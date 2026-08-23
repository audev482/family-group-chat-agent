/**
 * Type surface of the CalDAV capability seam: collection and object views,
 * failure codes, and the seam's Cordis event declarations. Types only — no
 * runtime code.
 *
 * @module dsh-caldav/types
 */

/** The iCalendar components this seam reads and writes. */
export type CalendarComponent = 'VEVENT' | 'VTODO'

/** One calendar collection discovered on a server. */
export interface CalendarSummary {
  /** Absolute collection URL; the stable handle for every later operation. */
  readonly url: string
  /** Human name as the server reports it, or the last URL segment when unnamed. */
  readonly displayName: string
  /**
   * Components the collection accepts, from `supported-calendar-component-set`.
   * Empty when the server does not report it, which RFC 4791 reads as "any".
   */
  readonly components: readonly string[]
  /** Collection colour, when the server reports one. */
  readonly color?: string
  /** Collection default time zone, when the server reports one. */
  readonly timezone?: string
}

/** One calendar object with the concurrency token needed to change it. */
export interface CalendarObjectRecord {
  /** Absolute object URL. */
  readonly url: string
  /** Current ETag; required to update or delete without clobbering a concurrent edit. */
  readonly etag?: string
  /** The raw iCalendar text. */
  readonly ical: string
}

/** The outcome of a write, carrying the token a follow-up change needs. */
export interface CalendarWriteResult {
  /** Absolute object URL. */
  readonly url: string
  /** ETag the server assigned, when it returned one. */
  readonly etag?: string
}

/** Stable machine-readable failure codes of the CalDAV seam. */
export type CalDavErrorCode =
  | 'server-not-found'
  | 'invalid-password-ref'
  | 'credential-unconfigured'
  | 'sdk-missing'
  | 'discovery-failed'
  | 'calendar-not-found'
  | 'calendar-ambiguous'
  | 'component-unsupported'
  | 'request-failed'
  | 'conflict'

/**
 * Structured CalDAV-seam failure. Messages name the configuration field or the
 * collection at fault and never echo a credential value.
 */
export class CalDavError extends Error {
  override readonly name = 'CalDavError'
  /** Stable machine-readable code. */
  readonly code: CalDavErrorCode
  /** HTTP status, when the failure came from a response. */
  readonly status?: number

  constructor(code: CalDavErrorCode, message: string, options?: { cause?: unknown; status?: number }) {
    super(message, options)
    this.code = code
    if (options?.status !== undefined) this.status = options.status
  }
}

/** One completed CalDAV operation — identity and timing facts, never content. */
export interface CalDavRequestEvent {
  /** Configured server name. */
  readonly server: string
  /** Seam operation that ran (`calendars`, `list`, `create`, `update`, `remove`). */
  readonly operation: string
  /** Wall-clock duration in milliseconds. */
  readonly durationMs: number
  /** Whether the operation succeeded. */
  readonly ok: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One CalDAV operation finished, successfully or not.
     * @param event - server, operation, timing, and outcome; never calendar content.
     * @mode emit
     */
    'caldav/request'(event: CalDavRequestEvent): void
  }
}
