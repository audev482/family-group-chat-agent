/**
 * Service Definition and single runtime of the CalDAV capability seam
 * (`ctx.caldav`): discovery, reads, and ETag-guarded writes against one or more
 * CalDAV servers.
 *
 * Nothing above this seam knows the word "Nextcloud". The Nextcloud Tasks and
 * Calendar apps are themselves CalDAV clients — Tasks builds a `DavClient` over
 * `remote.php/dav` and finds work with a `calendar-query` REPORT filtered to
 * `VTODO` — so speaking plain CalDAV is what makes a chore the butler creates a
 * first-class task in the Nextcloud UI, on phones, and in any other client.
 * `davPath` defaults to Nextcloud's `remote.php/dav`; that default is the only
 * Nextcloud-shaped fact in the package.
 *
 * Custody: configuration carries `passwordRef`, a credential *reference*. The
 * password is resolved through `ctx.credentials` inside each operation and
 * dropped on return, so a rotated Nextcloud app password reaches the very next
 * operation without a restart. What the seam caches between operations is
 * discovery — principal and calendar-home URLs — which contains no secret.
 *
 * @module dsh-caldav
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  assertWriteOk,
  componentFilter,
  loadDavSdk,
  readDisplayName,
  readEtag,
} from './dav.ts'
import type { DavAccountFacts, DavCalendar, DavClient } from './dav.ts'
import { CalDavError } from './types.ts'
import type {
  CalendarComponent,
  CalendarObjectRecord,
  CalendarSummary,
  CalendarWriteResult,
} from './types.ts'
// Type-only: carries the `caldav/request` event declaration.
import type {} from './types.ts'

export { CalDavError } from './types.ts'
export type {
  CalDavErrorCode,
  CalDavRequestEvent,
  CalendarComponent,
  CalendarObjectRecord,
  CalendarSummary,
  CalendarWriteResult,
} from './types.ts'
export {
  componentFilter,
  internals,
  lastPathSegment,
  loadDavSdk,
  readDisplayName,
  toDavTimestamp,
} from './dav.ts'
export type { DavCalendar, DavClient, DavObject, DavSdk } from './dav.ts'
export {
  createObject,
  internals as icalInternals,
  loadIcal,
  parseObject,
  readEvent,
  readTodo,
  toIcalTime,
  touch,
  writeCategories,
  writeText,
  writeWhen,
} from './ical.ts'
export type {
  EventFields,
  IcalComponent,
  IcalTime,
  TodoFields,
  TodoStatus,
  WhenInput,
} from './ical.ts'

/** Nextcloud's DAV entry point, and the default for any server that follows it. */
export const DEFAULT_DAV_PATH = 'remote.php/dav'

/** How long discovery and the collection list stay usable before being re-read. */
export const DEFAULT_DISCOVERY_TTL_MS = 300_000

/** One CalDAV server as written in configuration. */
export interface ServerDescriptor {
  /** Server origin, e.g. `https://fie.nl.tab.digital`. */
  baseUrl: string
  /** Account user name. */
  username: string
  /**
   * Credential *reference* naming the app password — a POSIX-style
   * environment-variable name such as `NEXTCLOUD_APP_PASSWORD`, never the
   * password itself. A pasted password fails loud at load because a secret
   * cannot syntactically be a reference.
   */
  passwordRef: string
  /** DAV path appended to {@link ServerDescriptor.baseUrl}; Nextcloud's default when absent. */
  davPath?: string
}

/** Plugin configuration: named CalDAV servers. */
export interface Config {
  /** Servers keyed by the name consumers pass to operations. */
  servers?: Record<string, ServerDescriptor>
  /** Server used when an operation names none; the only server when exactly one is configured. */
  defaultServer?: string
  /** How long discovery and the collection list stay usable. */
  discoveryTtlMs?: number
}

export const Config: z<Config> = z.object({
  servers: z.dict(z.object({
    baseUrl: z.string().required(),
    username: z.string().required(),
    passwordRef: z.string().required(),
    davPath: z.string(),
  })).default({}),
  defaultServer: z.string(),
  discoveryTtlMs: z.number().step(1).min(0).default(DEFAULT_DISCOVERY_TTL_MS),
})

/** One validated server with its branded credential reference resolved at load. */
interface ResolvedServer {
  readonly name: string
  readonly serverUrl: string
  readonly username: string
  readonly passwordRef: CredentialRef
}

/**
 * Discovery kept between operations, with the collection list it produced.
 *
 * URLs only. The auth header is deliberately **not** cached: for Basic auth it is
 * base64 of `user:password`, so holding one would hold the secret and would keep
 * a rotated app password from taking effect until the TTL lapsed.
 */
interface Discovery {
  readonly account: DavAccountFacts
  calendars: DavCalendar[]
  readonly at: number
}

/**
 * Build the Basic authorization header for one operation.
 *
 * Recomputed per operation from the freshly resolved credential, which is what
 * lets a rotated password reach the very next request.
 * @param username - the account user name.
 * @param password - the credential resolved for this operation.
 * @returns the header map.
 */
function basicAuthHeaders(username: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}` }
}

/** Join a base URL and a DAV path without doubling or dropping the separator. */
function joinDavUrl(baseUrl: string, davPath: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  const path = davPath.replace(/^\/+/, '').replace(/\/+$/, '')
  return path === '' ? `${base}/` : `${base}/${path}/`
}

/**
 * Validate one configured server at load, refusing anything that would smuggle
 * a password into configuration.
 */
function resolveServer(name: string, descriptor: ServerDescriptor): ResolvedServer {
  let origin: string
  try {
    origin = new URL(descriptor.baseUrl).origin
  } catch (cause) {
    throw new CalDavError(
      'server-not-found',
      `caldav.servers.${name}.baseUrl ${JSON.stringify(descriptor.baseUrl)} is not an absolute URL `
      + '(e.g. "https://fie.nl.tab.digital")',
      { cause },
    )
  }
  if (descriptor.username.trim() === '') {
    throw new CalDavError('server-not-found', `caldav.servers.${name}.username must not be empty`)
  }
  let passwordRef: CredentialRef
  try {
    passwordRef = credentialRef(descriptor.passwordRef)
  } catch (cause) {
    throw new CalDavError(
      'invalid-password-ref',
      `caldav.servers.${name}.passwordRef is not a credential reference. Configuration carries the NAME of a `
      + 'credential (a POSIX-style environment-variable name, e.g. "NEXTCLOUD_APP_PASSWORD"), never the secret '
      + 'itself — store the app password with your credential provider and reference it here.',
      { cause },
    )
  }
  // Preserve an explicit path prefix (a reverse proxy may host Nextcloud under
  // a subdirectory) while normalizing the DAV suffix.
  const prefix = new URL(descriptor.baseUrl).pathname.replace(/\/+$/, '')
  return {
    name,
    serverUrl: joinDavUrl(`${origin}${prefix}`, descriptor.davPath ?? DEFAULT_DAV_PATH),
    username: descriptor.username,
    passwordRef,
  }
}

/** Normalize a name for collection matching: case-folded and whitespace-collapsed. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Whether a collection accepts a component, treating an unreported set as "any". */
function accepts(calendar: DavCalendar, component: CalendarComponent): boolean {
  const components = calendar.components ?? []
  if (components.length === 0) return true
  return components.some(entry => entry.toUpperCase() === component)
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    caldav: CalDav
  }
}

/**
 * The CalDAV runtime (`ctx.caldav`): named servers, cached discovery, and the
 * per-operation resolve → connect → request → drop pipeline.
 */
export class CalDav extends Service {
  static inject = ['credentials']
  static Config: z<Config> = Config

  private readonly servers = new Map<string, ResolvedServer>()
  private readonly discoveries = new Map<string, Discovery>()
  private readonly configuredDefault: string | undefined
  private readonly discoveryTtlMs: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'caldav')
    this.discoveryTtlMs = config.discoveryTtlMs ?? DEFAULT_DISCOVERY_TTL_MS
    this.configuredDefault = config.defaultServer
    for (const [name, descriptor] of Object.entries(config.servers ?? {})) {
      this.servers.set(name, resolveServer(name, descriptor))
    }
    if (config.defaultServer !== undefined && !this.servers.has(config.defaultServer)) {
      const known = [...this.servers.keys()].join(', ') || 'none'
      throw new CalDavError(
        'server-not-found',
        `caldav.defaultServer "${config.defaultServer}" is not a configured server (configured: ${known})`,
      )
    }
  }

  /**
   * Describe every configured server for diagnostics — names and URLs, never
   * secrets.
   * @returns a fresh snapshot array.
   */
  list(): Array<{ name: string; serverUrl: string; username: string }> {
    return [...this.servers.values()].map(server => ({
      name: server.name,
      serverUrl: server.serverUrl,
      username: server.username,
    }))
  }

  /** Resolve the server an operation addresses, defaulting when only one exists. */
  private serverFor(name?: string): ResolvedServer {
    const requested = name ?? this.configuredDefault
      ?? (this.servers.size === 1 ? [...this.servers.keys()][0] : undefined)
    if (requested === undefined) {
      const known = [...this.servers.keys()].join(', ') || 'none'
      throw new CalDavError(
        'server-not-found',
        this.servers.size === 0
          ? 'no CalDAV server is configured — add one under caldav.servers in your profile patch'
          : `more than one CalDAV server is configured (${known}); name one, or set caldav.defaultServer`,
      )
    }
    const server = this.servers.get(requested)
    if (server === undefined) {
      const known = [...this.servers.keys()].join(', ') || 'none'
      throw new CalDavError('server-not-found', `CalDAV server "${requested}" is not configured (configured: ${known})`)
    }
    return server
  }

  /**
   * Open one operation: resolve the credential NOW — this call, not plugin
   * load, is the only place the password exists — build a client, and reuse
   * cached discovery when it is still fresh.
   */
  private async connect(server: ResolvedServer): Promise<DavClient> {
    const resolved = await this.ctx.credentials.resolve(server.passwordRef)
    if (resolved === undefined) {
      throw new CalDavError(
        'credential-unconfigured',
        `CalDAV server "${server.name}": credential reference "${server.passwordRef}" resolves to no value — `
        + 'configure it with your credential provider (for Nextcloud, generate an app password under '
        + 'Settings → Security → Devices & sessions) before connecting',
      )
    }
    const sdk = await loadDavSdk()
    const client = sdk.createClient({
      serverUrl: server.serverUrl,
      username: server.username,
      password: resolved.value,
    })
    const cached = this.discoveries.get(server.name)
    if (cached !== undefined && Date.now() - cached.at < this.discoveryTtlMs) {
      // Skip re-discovery — the principal and calendar-home URLs have not moved —
      // but compute the auth header from the credential resolved for THIS
      // operation. Caching the header instead would cache the secret inside it
      // (a Basic header is just base64 of user:password) and a rotated app
      // password would keep failing until the TTL lapsed.
      client.account = cached.account
      client.authHeaders = basicAuthHeaders(server.username, resolved.value)
      return client
    }
    try {
      await client.login()
    } catch (cause) {
      this.discoveries.delete(server.name)
      throw new CalDavError(
        'discovery-failed',
        `could not sign in to CalDAV server "${server.name}" at ${server.serverUrl}: ${describe(cause)}. `
        + 'Check the base URL, the user name, and that the credential holds a current app password.',
        { cause },
      )
    }
    if (client.account !== undefined) {
      this.discoveries.set(server.name, {
        account: client.account,
        calendars: [],
        at: Date.now(),
      })
    }
    return client
  }

  /** Run one operation with timing reported through `caldav/request`. */
  private async run<T>(server: ResolvedServer, operation: string, body: () => Promise<T>): Promise<T> {
    const started = Date.now()
    try {
      const result = await body()
      this.ctx.emit('caldav/request', {
        server: server.name,
        operation,
        durationMs: Date.now() - started,
        ok: true,
      })
      return result
    } catch (error) {
      this.ctx.emit('caldav/request', {
        server: server.name,
        operation,
        durationMs: Date.now() - started,
        ok: false,
      })
      // A stale discovery is the most common cause of a mid-session failure
      // (rotated password, moved principal); drop it so the next call re-logs in.
      if (error instanceof CalDavError && (error.status === 401 || error.status === 403)) {
        this.discoveries.delete(server.name)
      }
      throw error
    }
  }

  /** Fetch the collection list, reusing the cached one while it is fresh. */
  private async collections(server: ResolvedServer, refresh: boolean): Promise<DavCalendar[]> {
    const cached = this.discoveries.get(server.name)
    if (!refresh && cached !== undefined && cached.calendars.length > 0
      && Date.now() - cached.at < this.discoveryTtlMs) {
      return cached.calendars
    }
    const client = await this.connect(server)
    let calendars: DavCalendar[]
    try {
      calendars = await client.fetchCalendars()
    } catch (cause) {
      throw new CalDavError(
        'discovery-failed',
        `could not list calendars on CalDAV server "${server.name}": ${describe(cause)}`,
        { cause },
      )
    }
    const discovery = this.discoveries.get(server.name)
    if (discovery !== undefined) discovery.calendars = calendars
    return calendars
  }

  /**
   * List the calendar collections on a server.
   * @param options - which server, whether to bypass the cached list, and an optional component filter.
   * @returns one summary per collection, in server order.
   */
  async calendars(options: {
    server?: string
    refresh?: boolean
    component?: CalendarComponent
  } = {}): Promise<CalendarSummary[]> {
    const server = this.serverFor(options.server)
    return this.run(server, 'calendars', async () => {
      const calendars = await this.collections(server, options.refresh ?? false)
      const component = options.component
      return calendars
        .filter(calendar => component === undefined || accepts(calendar, component))
        .map(calendar => ({
          url: calendar.url,
          displayName: readDisplayName(calendar),
          components: (calendar.components ?? []).map(entry => entry.toUpperCase()),
          ...calendar.calendarColor !== undefined ? { color: calendar.calendarColor } : {},
          ...calendar.timezone !== undefined ? { timezone: calendar.timezone } : {},
        }))
    })
  }

  /** Match a collection by display name or URL, refusing an ambiguous name. */
  private async findCollection(
    server: ResolvedServer,
    name: string,
    component: CalendarComponent | undefined,
    refresh: boolean,
  ): Promise<DavCalendar> {
    const calendars = await this.collections(server, refresh)
    const wanted = fold(name)
    const byUrl = calendars.filter(calendar => calendar.url === name || fold(calendar.url) === wanted)
    const candidates = byUrl.length > 0
      ? byUrl
      : calendars.filter(calendar => fold(readDisplayName(calendar)) === wanted)
    if (candidates.length === 0) {
      // A collection created since the last read is the likely explanation, so
      // retry once against a fresh list before failing.
      if (!refresh) return this.findCollection(server, name, component, true)
      const known = calendars.map(calendar => readDisplayName(calendar)).join(', ') || 'none'
      throw new CalDavError(
        'calendar-not-found',
        `no calendar named "${name}" on server "${server.name}" (available: ${known})`,
      )
    }
    if (candidates.length > 1) {
      throw new CalDavError(
        'calendar-ambiguous',
        `"${name}" matches ${candidates.length} calendars on server "${server.name}" — `
        + `address one by URL: ${candidates.map(calendar => calendar.url).join(', ')}`,
      )
    }
    const calendar = candidates[0]!
    if (component !== undefined && !accepts(calendar, component)) {
      throw new CalDavError(
        'component-unsupported',
        `calendar "${readDisplayName(calendar)}" does not accept ${component} `
        + `(it accepts ${(calendar.components ?? []).join(', ') || 'nothing it reports'}). `
        + (component === 'VTODO'
          ? 'Create a task list in the Nextcloud Tasks app and name that one instead.'
          : 'Name a calendar that stores events instead.'),
      )
    }
    return calendar
  }

  /**
   * Resolve a calendar by display name or URL.
   * @param name - display name or absolute collection URL.
   * @param options - which server, and the component the caller intends to use.
   * @returns the collection summary.
   */
  async calendar(name: string, options: {
    server?: string
    component?: CalendarComponent
  } = {}): Promise<CalendarSummary> {
    const server = this.serverFor(options.server)
    return this.run(server, 'calendar', async () => {
      const calendar = await this.findCollection(server, name, options.component, false)
      return {
        url: calendar.url,
        displayName: readDisplayName(calendar),
        components: (calendar.components ?? []).map(entry => entry.toUpperCase()),
        ...calendar.calendarColor !== undefined ? { color: calendar.calendarColor } : {},
        ...calendar.timezone !== undefined ? { timezone: calendar.timezone } : {},
      }
    })
  }

  /**
   * Read objects of one component kind from one collection.
   *
   * The component filter is not optional in practice: `tsdav` defaults its
   * `calendar-query` filter to `VEVENT`, so a VTODO read that omitted it would
   * silently return events.
   * @param options - collection, component, and an optional time window.
   * @returns one record per object, each with the ETag a later write needs.
   */
  async objects(options: {
    calendar: string
    component: CalendarComponent
    server?: string
    timeRange?: { start: Date; end: Date }
    expand?: boolean
  }): Promise<CalendarObjectRecord[]> {
    const server = this.serverFor(options.server)
    return this.run(server, 'objects', async () => {
      const calendar = await this.findCollection(server, options.calendar, options.component, false)
      const client = await this.connect(server)
      let objects
      try {
        objects = await client.fetchCalendarObjects({
          calendar,
          filters: componentFilter(options.component, options.timeRange),
          ...options.timeRange !== undefined
            ? {
                timeRange: {
                  start: options.timeRange.start.toISOString(),
                  end: options.timeRange.end.toISOString(),
                },
              }
            : {},
          ...options.expand !== undefined ? { expand: options.expand } : {},
        })
      } catch (cause) {
        throw new CalDavError(
          'request-failed',
          `could not read ${options.component}s from "${options.calendar}" on server "${server.name}": ${describe(cause)}`,
          { cause },
        )
      }
      const records: CalendarObjectRecord[] = []
      for (const object of objects) {
        const ical = typeof object.data === 'string' ? object.data : undefined
        if (ical === undefined || ical.trim() === '') continue
        records.push({
          url: object.url,
          ical,
          ...object.etag !== undefined ? { etag: object.etag } : {},
        })
      }
      return records
    })
  }

  /**
   * Create one object in a collection.
   * @param options - collection, the iCalendar text, and the object's UID (used as the file name).
   * @returns the new object's URL and ETag when the server returned one.
   */
  async create(options: {
    calendar: string
    component: CalendarComponent
    ical: string
    uid: string
    server?: string
  }): Promise<CalendarWriteResult> {
    const server = this.serverFor(options.server)
    return this.run(server, 'create', async () => {
      const calendar = await this.findCollection(server, options.calendar, options.component, false)
      const client = await this.connect(server)
      const filename = `${encodeURIComponent(options.uid)}.ics`
      const response = await client.createCalendarObject({
        calendar,
        iCalString: options.ical,
        filename,
      })
      assertWriteOk(response, `creating ${options.component} "${options.uid}"`)
      const url = new URL(filename, calendar.url).href
      const etag = readEtag(response)
      return { url, ...etag !== undefined ? { etag } : {} }
    })
  }

  /**
   * Replace one object, guarded by the ETag it was read with.
   * @param options - object URL, the complete new iCalendar text, and the ETag.
   * @returns the object's URL and its new ETag when the server returned one.
   */
  async update(options: {
    url: string
    ical: string
    etag?: string
    server?: string
  }): Promise<CalendarWriteResult> {
    const server = this.serverFor(options.server)
    return this.run(server, 'update', async () => {
      const client = await this.connect(server)
      const response = await client.updateCalendarObject({
        calendarObject: {
          url: options.url,
          data: options.ical,
          ...options.etag !== undefined ? { etag: options.etag } : {},
        },
      })
      assertWriteOk(response, `updating ${options.url}`)
      const etag = readEtag(response)
      return { url: options.url, ...etag !== undefined ? { etag } : {} }
    })
  }

  /**
   * Delete one object, guarded by the ETag it was read with.
   * @param options - object URL and the ETag.
   */
  async remove(options: { url: string; etag?: string; server?: string }): Promise<void> {
    const server = this.serverFor(options.server)
    await this.run(server, 'remove', async () => {
      const client = await this.connect(server)
      const response = await client.deleteCalendarObject({
        calendarObject: {
          url: options.url,
          ...options.etag !== undefined ? { etag: options.etag } : {},
        },
      })
      assertWriteOk(response, `deleting ${options.url}`)
    })
  }

  /**
   * Check one server end to end and report what the account can see, for
   * operators diagnosing a fresh install.
   * @param server - configured server name; the default server when omitted.
   * @returns a human-readable report naming every collection and its components.
   */
  async probe(server?: string): Promise<string> {
    const target = this.serverFor(server)
    const calendars = await this.calendars({ server: target.name, refresh: true })
    if (calendars.length === 0) {
      return `Signed in to "${target.name}" (${target.serverUrl}) as ${target.username}, but the account has no `
        + 'calendar collections. Create a calendar in Nextcloud Calendar and a task list in Nextcloud Tasks.'
    }
    const lines = calendars.map((calendar) => {
      const components = calendar.components.length > 0 ? calendar.components.join('+') : 'unreported'
      return `- ${calendar.displayName} [${components}] ${calendar.url}`
    })
    return `Signed in to "${target.name}" (${target.serverUrl}) as ${target.username}. `
      + `${calendars.length} collection(s):\n${lines.join('\n')}`
  }
}

/** Describe a thrown value for an operator-facing message without leaking a stack. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a function-plugin `apply` makes
// the Loader drop the plugin namespace.
export default CalDav
