/**
 * The `tsdav` boundary: the narrow structural interface this seam drives, the
 * lazy SDK loader, and the CalDAV request filters.
 *
 * `tsdav` is an optional peer. Nothing here imports it at module load, so
 * `dsh-caldav` mounts, typechecks, and tests without the SDK installed; a
 * household that never configures a server never needs it. The
 * {@link internals} seam is what tests substitute in its place.
 *
 * @module dsh-caldav/dav
 */

import { CalDavError } from './types.ts'
import type { CalendarComponent } from './types.ts'

/** A calendar collection as `tsdav` reports it. */
export interface DavCalendar {
  /** Absolute collection URL. */
  url: string
  /** `displayname`, which some servers return as a parsed XML object rather than text. */
  displayName?: string | Record<string, unknown>
  /** `supported-calendar-component-set`. */
  components?: string[]
  /** `calendar-color`. */
  calendarColor?: string
  /** Collection default time zone. */
  timezone?: string
}

/** A calendar object as `tsdav` reports it. */
export interface DavObject {
  /** Absolute object URL. */
  url: string
  /** Current ETag. */
  etag?: string
  /** iCalendar text, which `tsdav` types loosely because it comes from XML. */
  data?: unknown
}

/** The CalDAV account facts discovery produces; URLs only, never credentials. */
export interface DavAccountFacts {
  /** Account type; always `caldav` here. */
  accountType: 'caldav'
  /** The configured server URL discovery started from. */
  serverUrl: string
  /** Discovered DAV root. */
  rootUrl?: string
  /** Discovered principal URL. */
  principalUrl?: string
  /** Discovered calendar home. */
  homeUrl?: string
}

/** The subset of `tsdav`'s `DAVClient` this seam uses. */
export interface DavClient {
  /** Compute auth headers and discover the account. */
  login(): Promise<void>
  /** Auth headers, assignable so a cached discovery can skip a second login. */
  authHeaders?: Record<string, string>
  /** Discovered account, assignable for the same reason. */
  account?: DavAccountFacts
  /** List the principal's calendar collections. */
  fetchCalendars(params?: { headers?: Record<string, string> }): Promise<DavCalendar[]>
  /** Fetch objects from one collection, optionally filtered. */
  fetchCalendarObjects(params: {
    calendar: DavCalendar
    filters?: unknown
    timeRange?: { start: string; end: string }
    objectUrls?: string[]
    expand?: boolean
  }): Promise<DavObject[]>
  /** `PUT` a new object with `If-None-Match: *`. */
  createCalendarObject(params: {
    calendar: DavCalendar
    iCalString: string
    filename: string
  }): Promise<Response>
  /** `PUT` over an existing object, guarded by its ETag. */
  updateCalendarObject(params: {
    calendarObject: { url: string; data: string; etag?: string }
  }): Promise<Response>
  /** `DELETE` an object, guarded by its ETag. */
  deleteCalendarObject(params: {
    calendarObject: { url: string; etag?: string }
  }): Promise<Response>
}

/** Factory over the SDK: one call builds one operation-scoped client. */
export interface DavSdk {
  /**
   * Build a client for one operation.
   * @param params - server URL and the credentials resolved for this operation.
   * @returns an unlogged-in client.
   */
  createClient(params: { serverUrl: string; username: string; password: string }): DavClient
}

/** Load `tsdav` on first use, or explain exactly how to install it. */
async function importSdk(): Promise<DavSdk> {
  let module: { DAVClient: new (params: unknown) => DavClient }
  try {
    module = await import('tsdav') as unknown as { DAVClient: new (params: unknown) => DavClient }
  } catch (cause) {
    throw new CalDavError(
      'sdk-missing',
      'dsh-caldav requires the optional peer dependency "tsdav". Install it into the profile, e.g. '
      + '`dsh plugin --profile <name> add tsdav`, or `pnpm add tsdav` in a source checkout.',
      { cause },
    )
  }
  return {
    createClient({ serverUrl, username, password }) {
      return new module.DAVClient({
        serverUrl,
        credentials: { username, password },
        authMethod: 'Basic',
        defaultAccountType: 'caldav',
      })
    },
  }
}

/**
 * Test seam. Replacing `loadSdk` substitutes a fake CalDAV server, which is how
 * every spec in this package runs without a network or an installed `tsdav`.
 */
export const internals: { loadSdk: () => Promise<DavSdk> } = { loadSdk: importSdk }

/**
 * Load the SDK through the {@link internals} seam.
 * @returns the client factory.
 */
export function loadDavSdk(): Promise<DavSdk> {
  return internals.loadSdk()
}

/** Format an instant the way RFC 4791 time-range filters require: basic UTC. */
export function toDavTimestamp(value: Date): string {
  return `${value.toISOString().slice(0, 19).replace(/[-:.]/g, '')}Z`
}

/**
 * Build the `calendar-query` filter selecting one component kind, optionally
 * within a time range.
 *
 * `tsdav` defaults its filter to `VEVENT`, so a VTODO read that omits this
 * would silently return events instead of chores.
 * @param component - the component to select.
 * @param timeRange - optional window; RFC 4791 compares it against the component's own times.
 * @returns the filter value to hand to `fetchCalendarObjects`.
 */
export function componentFilter(
  component: CalendarComponent,
  timeRange?: { start: Date; end: Date },
): unknown {
  return [{
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': {
        _attributes: { name: component },
        ...timeRange !== undefined
          ? {
              'time-range': {
                _attributes: {
                  start: toDavTimestamp(timeRange.start),
                  end: toDavTimestamp(timeRange.end),
                },
              },
            }
          : {},
      },
    },
  }]
}

/** Read the `displayname` property, which some servers return as parsed XML. */
export function readDisplayName(calendar: DavCalendar): string {
  const raw = calendar.displayName
  if (typeof raw === 'string' && raw.trim() !== '') return raw.trim()
  if (raw !== null && typeof raw === 'object') {
    const text = (raw as { _text?: unknown; _cdata?: unknown })._text
      ?? (raw as { _cdata?: unknown })._cdata
    if (typeof text === 'string' && text.trim() !== '') return text.trim()
  }
  return lastPathSegment(calendar.url)
}

/** The final non-empty path segment of a URL, percent-decoded when possible. */
export function lastPathSegment(url: string): string {
  const trimmed = url.replace(/\/+$/, '')
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(segment)
  } catch {
    // A malformed escape in a server-generated URL is not worth failing a read
    // over; the raw segment is still a usable name.
    return segment
  }
}

/** Read the ETag a write response returned, if any. */
export function readEtag(response: Response): string | undefined {
  return response.headers?.get?.('etag') ?? undefined
}

/**
 * Turn a failed write response into a diagnosable seam error, distinguishing a
 * lost-update conflict from every other failure.
 * @param response - the response to check.
 * @param what - short description of the attempted operation.
 */
export function assertWriteOk(response: Response, what: string): void {
  if (response.ok) return
  if (response.status === 412 || response.status === 409) {
    throw new CalDavError(
      'conflict',
      `${what} was rejected with ${response.status}: the item changed on the server since it was read. `
      + 'Read it again and re-apply the change.',
      { status: response.status },
    )
  }
  throw new CalDavError(
    'request-failed',
    `${what} failed with HTTP ${response.status} ${response.statusText}`,
    { status: response.status },
  )
}
