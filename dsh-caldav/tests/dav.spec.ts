/**
 * The CalDAV transport, against a fake server.
 *
 * No network. `internals.loadSdk` is substituted with a fake that records what
 * was asked of it, which is the only way to assert on the two things most likely
 * to break silently against a real Nextcloud:
 *
 * - that a VTODO read sends an explicit VTODO filter (`tsdav` defaults to VEVENT,
 *   so omitting it returns an empty chore list rather than an error), and
 * - that credentials are resolved per operation while the *discovery* is cached,
 *   so a rotated app password takes effect without a restart.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CalDav, { CalDavError, internals as davInternals } from '../src/index.ts'
import type { DavCalendar, DavClient, DavObject, DavSdk } from '../src/index.ts'

/** What one fake client was asked to do. */
interface Recorded {
  logins: number
  fetchCalendars: number
  fetchObjects: { calendar: string; filters: unknown; timeRange?: { start: string; end: string } }[]
  created: { calendar: string; filename: string; ical: string }[]
  updated: { url: string; etag?: string; ical: string }[]
  deleted: { url: string; etag?: string }[]
  passwords: string[]
}

/** A fake CalDAV server, and the SDK that talks to it. */
function fakeServer(options: {
  calendars?: DavCalendar[]
  objects?: Record<string, DavObject[]>
  onLogin?: (password: string) => void
  writeStatus?: number
} = {}): { sdk: DavSdk; recorded: Recorded } {
  const calendars: DavCalendar[] = options.calendars ?? [
    { url: 'https://dav.example/cal/family/', displayName: 'Family', components: ['VEVENT'] },
    { url: 'https://dav.example/cal/household/', displayName: 'Household', components: ['VTODO'] },
    { url: 'https://dav.example/cal/alex/', displayName: 'Alex', components: ['VEVENT', 'VTODO'] },
  ]
  const recorded: Recorded = {
    logins: 0,
    fetchCalendars: 0,
    fetchObjects: [],
    created: [],
    updated: [],
    deleted: [],
    passwords: [],
  }
  const response = (status: number, etag?: string): Response =>
    ({
      ok: status >= 200 && status < 300,
      status,
      statusText: `status ${status}`,
      headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? etag ?? null : null) },
    }) as unknown as Response

  const sdk: DavSdk = {
    createClient({ password }) {
      recorded.passwords.push(password)
      const client: DavClient = {
        async login() {
          recorded.logins += 1
          options.onLogin?.(password)
          client.authHeaders = { authorization: 'Basic fake' }
          client.account = { accountType: 'caldav', serverUrl: 'https://dav.example' }
        },
        async fetchCalendars() {
          recorded.fetchCalendars += 1
          return calendars
        },
        async fetchCalendarObjects(params) {
          recorded.fetchObjects.push({
            calendar: params.calendar.url,
            filters: params.filters,
            ...params.timeRange === undefined ? {} : { timeRange: params.timeRange },
          })
          return options.objects?.[params.calendar.url] ?? []
        },
        async createCalendarObject(params) {
          recorded.created.push({
            calendar: params.calendar.url,
            filename: params.filename,
            ical: params.iCalString,
          })
          return response(options.writeStatus ?? 201, '"new-etag"')
        },
        async updateCalendarObject(params) {
          recorded.updated.push({
            url: params.calendarObject.url,
            ...params.calendarObject.etag === undefined ? {} : { etag: params.calendarObject.etag },
            ical: params.calendarObject.data,
          })
          return response(options.writeStatus ?? 204, '"updated-etag"')
        },
        async deleteCalendarObject(params) {
          recorded.deleted.push({
            url: params.calendarObject.url,
            ...params.calendarObject.etag === undefined ? {} : { etag: params.calendarObject.etag },
          })
          return response(options.writeStatus ?? 204)
        },
      }
      return client
    },
  }
  return { sdk, recorded }
}

/** A credentials service standing in for the real provider. */
class FakeCredentials extends Service {
  /** What the next resolve returns. Mutable, so a rotation can be simulated. */
  password = 'app-password-1'
  /** How many times a credential was resolved. */
  resolves = 0

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve a reference.
   * @param ref - the credential name.
   * @returns the resolved credential.
   */
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    this.resolves += 1
    if (ref === 'MISSING') return undefined
    return { value: this.password, source: 'test' }
  }
}

/** Build the service with a fake credentials provider on a throwaway context. */
function build(config: Record<string, unknown> = {}): {
  caldav: CalDav
  credentials: FakeCredentials
} {
  const ctx = new Context()
  const credentials = new FakeCredentials(ctx)
  const caldav = new CalDav(ctx, {
    servers: {
      home: {
        baseUrl: 'https://dav.example',
        username: 'family',
        passwordRef: 'NEXTCLOUD_APP_PASSWORD',
      },
    },
    defaultServer: 'home',
    ...config,
  } as never)
  return { caldav, credentials }
}

const ICAL_EVENT = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:swim-1',
  'SUMMARY:Swimming',
  'DTSTART:20260824T140000Z',
  'DTEND:20260824T150000Z',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

const ICAL_TODO = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:bins-1',
  'SUMMARY:Bins',
  'DUE;VALUE=DATE:20260825',
  'CATEGORIES:alex',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n')

describe('collections', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('lists the collections a server offers', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    const calendars = await caldav.calendars()
    expect(calendars.map(entry => entry.displayName)).toEqual(['Family', 'Household', 'Alex'])
  })

  it('filters collections by the component asked for', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    const todoCapable = await caldav.calendars({ component: 'VTODO' })
    expect(todoCapable.map(entry => entry.displayName)).toEqual(['Household', 'Alex'])
  })

  it('finds a collection by display name', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    expect((await caldav.calendar('Household')).url).toBe('https://dav.example/cal/household/')
  })

  it('names the collections it does have when one is not found', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await expect(caldav.calendar('Holidays')).rejects.toThrow(/Family|Household/)
  })

  it('refuses a collection that cannot hold the component asked for', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    // "Family" advertises VEVENT only; writing a chore there would silently fail.
    await expect(caldav.calendar('Family', { component: 'VTODO' })).rejects.toThrow()
  })
})

describe('reading objects', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends an explicit VTODO filter, because the SDK would otherwise ask for VEVENT', async () => {
    const { sdk, recorded } = fakeServer({
      objects: {
        'https://dav.example/cal/household/': [
          { url: 'https://dav.example/cal/household/bins-1.ics', etag: '"e1"', data: ICAL_TODO },
        ],
      },
    })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    const objects = await caldav.objects({ calendar: 'Household', component: 'VTODO' })
    expect(objects).toHaveLength(1)
    // The filter must name VTODO somewhere inside it.
    expect(JSON.stringify(recorded.fetchObjects[0]?.filters)).toContain('VTODO')
  })

  it('sends a time range when one is asked for, and none when it is not', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.objects({
      calendar: 'Family',
      component: 'VEVENT',
      timeRange: { start: new Date('2026-08-22T00:00:00Z'), end: new Date('2026-08-23T00:00:00Z') },
    })
    expect(recorded.fetchObjects[0]?.timeRange).toBeDefined()

    await caldav.objects({ calendar: 'Household', component: 'VTODO' })
    // An undated chore would be excluded by a time range, so chores are read unfiltered.
    expect(recorded.fetchObjects[1]?.timeRange).toBeUndefined()
  })

  it('returns the raw iCalendar text and the ETag together', async () => {
    const { sdk } = fakeServer({
      objects: {
        'https://dav.example/cal/family/': [
          { url: 'https://dav.example/cal/family/swim-1.ics', etag: '"e9"', data: ICAL_EVENT },
        ],
      },
    })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    const [object] = await caldav.objects({ calendar: 'Family', component: 'VEVENT' })
    expect(object?.etag).toBe('"e9"')
    expect(object?.ical).toContain('SUMMARY:Swimming')
  })

  it('skips objects the server returned without usable text rather than failing the read', async () => {
    const { sdk } = fakeServer({
      objects: {
        'https://dav.example/cal/family/': [
          { url: 'https://dav.example/cal/family/broken.ics', etag: '"e1"', data: undefined },
          { url: 'https://dav.example/cal/family/swim-1.ics', etag: '"e2"', data: ICAL_EVENT },
        ],
      },
    })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    const objects = await caldav.objects({ calendar: 'Family', component: 'VEVENT' })
    expect(objects).toHaveLength(1)
  })
})

describe('writing objects', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('creates with a filename derived from the UID', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.create({ calendar: 'Family', component: 'VEVENT', ical: ICAL_EVENT, uid: 'swim-1' })
    expect(recorded.created[0]?.filename).toBe('swim-1.ics')
    expect(recorded.created[0]?.calendar).toBe('https://dav.example/cal/family/')
  })

  it('escapes a UID that would otherwise be an unsafe path segment', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.create({ calendar: 'Family', component: 'VEVENT', ical: ICAL_EVENT, uid: 'a/b c' })
    expect(recorded.created[0]?.filename).not.toContain('/')
  })

  it('passes the ETag through on update, so a concurrent edit is detected', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.update({ url: 'https://dav.example/cal/family/swim-1.ics', ical: ICAL_EVENT, etag: '"e9"' })
    expect(recorded.updated[0]?.etag).toBe('"e9"')
  })

  it('reports a 412 as a conflict, which is a different problem from a failure', async () => {
    const { sdk } = fakeServer({ writeStatus: 412 })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await expect(caldav.update({ url: 'https://dav.example/x.ics', ical: ICAL_EVENT, etag: '"old"' }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('reports a 409 as a conflict too', async () => {
    const { sdk } = fakeServer({ writeStatus: 409 })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await expect(caldav.remove({ url: 'https://dav.example/x.ics', etag: '"old"' }))
      .rejects.toMatchObject({ code: 'conflict' })
  })

  it('reports a 500 as a request failure', async () => {
    const { sdk } = fakeServer({ writeStatus: 500 })
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await expect(caldav.create({ calendar: 'Family', component: 'VEVENT', ical: ICAL_EVENT, uid: 'x' }))
      .rejects.toMatchObject({ code: 'request-failed' })
  })

  it('deletes with the ETag it was given', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.remove({ url: 'https://dav.example/cal/family/swim-1.ics', etag: '"e9"' })
    expect(recorded.deleted[0]).toEqual({ url: 'https://dav.example/cal/family/swim-1.ics', etag: '"e9"' })
  })
})

describe('credentials and discovery', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves the password for every operation, so a rotation takes effect immediately', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav, credentials } = build()
    // `objects` always reaches the server; `calendars` can be answered wholly
    // from the cached collection list, and an operation that makes no request
    // rightly needs no credential.
    await caldav.objects({ calendar: 'Family', component: 'VEVENT' })
    credentials.password = 'app-password-2'
    await caldav.objects({ calendar: 'Family', component: 'VEVENT' })
    // The second operation used the new password even though the cached
    // discovery meant no second login. (The first operation builds two clients:
    // one to discover the collections, one to read them.)
    expect(recorded.passwords[0]).toBe('app-password-1')
    expect(recorded.passwords.at(-1)).toBe('app-password-2')
    expect(recorded.logins).toBe(1)
  })

  it('rebuilds the auth header rather than replaying a cached one', async () => {
    const headers: (Record<string, string> | undefined)[] = []
    const { sdk } = fakeServer()
    const wrapped: typeof sdk = {
      createClient(params) {
        const client = sdk.createClient(params)
        const fetchCalendars = client.fetchCalendars.bind(client)
        client.fetchCalendars = async (options) => {
          headers.push(client.authHeaders)
          return fetchCalendars(options)
        }
        return client
      },
    }
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(wrapped)
    const { caldav, credentials } = build()
    await caldav.calendars()
    credentials.password = 'rotated-password'
    await caldav.calendars({ refresh: true })
    // A Basic header is base64 of user:password, so caching it would cache the
    // secret. The second header must encode the new password.
    const decoded = headers.map(header =>
      Buffer.from((header?.authorization ?? '').replace('Basic ', ''), 'base64').toString('utf8'))
    expect(decoded[1]).toBe('family:rotated-password')
  })

  it('caches discovery so a second question does not pay for another login', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.calendars()
    await caldav.calendars()
    await caldav.calendars()
    expect(recorded.fetchCalendars).toBe(1)
  })

  it('re-discovers when explicitly refreshed', async () => {
    const { sdk, recorded } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await caldav.calendars()
    await caldav.calendars({ refresh: true })
    expect(recorded.fetchCalendars).toBe(2)
  })

  it('reports an unconfigured credential as such, not as a connection failure', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const ctx = new Context()
    new FakeCredentials(ctx)
    const caldav = new CalDav(ctx, {
      servers: { home: { baseUrl: 'https://dav.example', username: 'family', passwordRef: 'MISSING' } },
      defaultServer: 'home',
    } as never)
    await expect(caldav.calendars()).rejects.toMatchObject({ code: 'credential-unconfigured' })
  })

  it('names an unknown server rather than silently using the default', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const { caldav } = build()
    await expect(caldav.calendars({ server: 'nowhere' })).rejects.toMatchObject({ code: 'server-not-found' })
  })

  it('lists configured servers without exposing the credential', () => {
    const { caldav } = build()
    const listed = caldav.list()
    expect(listed).toEqual([
      { name: 'home', serverUrl: expect.stringContaining('remote.php/dav'), username: 'family' },
    ])
    expect(JSON.stringify(listed)).not.toContain('app-password')
  })
})

describe('observability', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports each operation without leaking what was read', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const ctx = new Context()
    new FakeCredentials(ctx)
    const caldav = new CalDav(ctx, {
      servers: { home: { baseUrl: 'https://dav.example', username: 'family', passwordRef: 'REF' } },
      defaultServer: 'home',
    } as never)
    const events: unknown[] = []
    ctx.on('caldav/request', event => events.push(event))
    await caldav.calendars()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ server: 'home', operation: 'calendars', ok: true })
    expect(JSON.stringify(events[0])).not.toContain('Family')
  })

  it('reports a failed operation as not ok', async () => {
    const { sdk } = fakeServer()
    vi.spyOn(davInternals, 'loadSdk').mockResolvedValue(sdk)
    const ctx = new Context()
    new FakeCredentials(ctx)
    const caldav = new CalDav(ctx, {
      servers: { home: { baseUrl: 'https://dav.example', username: 'family', passwordRef: 'REF' } },
      defaultServer: 'home',
    } as never)
    const events: { ok: boolean }[] = []
    ctx.on('caldav/request', event => events.push(event as { ok: boolean }))
    await caldav.calendar('Nope').catch(() => undefined)
    expect(events.at(-1)?.ok).toBe(false)
  })
})

describe('CalDavError', () => {
  it('carries a code a tool can turn into an explanation', () => {
    const error = new CalDavError('calendar-not-found', 'no such collection')
    expect(error.code).toBe('calendar-not-found')
    expect(error.name).toBe('CalDavError')
    expect(error).toBeInstanceOf(Error)
  })
})
