/**
 * The household clock: date arithmetic and phrasing in the family's own time
 * zone.
 *
 * A butler is asked about "tomorrow" and "this weekend", not about UTC
 * instants, and every such answer depends on where the family lives. The
 * household already owns `timezone`, so it owns the clock too — which also
 * keeps the calendar and chore packages from each carrying their own copy of
 * this arithmetic and drifting apart.
 *
 * All functions are pure and take the zone explicitly, so they are testable
 * without mounting the service.
 *
 * @module dsh-household/clock
 */

/** Calendar-local wall-clock fields of one instant. */
export interface ZonedParts {
  /** Full year. */
  readonly year: number
  /** Month, 1–12. */
  readonly month: number
  /** Day of month, 1–31. */
  readonly day: number
  /** Hour, 0–23. */
  readonly hour: number
  /** Minute, 0–59. */
  readonly minute: number
}

/** A half-open instant window `[start, end)`. */
export interface Window {
  /** Inclusive start. */
  readonly start: Date
  /** Exclusive end. */
  readonly end: Date
}

/** Weekday names as spoken, indexed the way `Date.getUTCDay` numbers them. */
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const

/** `YYYY-MM-DD`. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** Zero-pad to two digits. */
function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Read one instant's wall-clock fields in a zone. */
export function zonedParts(instant: Date, timezone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant)
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find(candidate => candidate.type === type)
    return part === undefined ? 0 : Number(part.value)
  }
  // `hour: '2-digit'` with hour12:false renders local midnight as 24 in some
  // ICU versions; fold it back into the 0–23 range the fields promise.
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
  }
}

/** The zone's UTC offset in milliseconds at one instant. */
function offsetMs(instant: Date, timezone: string): number {
  const parts = zonedParts(instant, timezone)
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  // Second-level precision is irrelevant for offsets, which are whole minutes.
  return asUtc - Math.floor(instant.getTime() / 60_000) * 60_000
}

/**
 * Convert a wall-clock time in a zone to the instant it names.
 *
 * The offset is applied twice because the first guess uses the offset at the
 * wrong instant near a DST transition; the second pass lands on the right one.
 * @param fields - the wall-clock fields.
 * @param timezone - IANA zone the fields are expressed in.
 * @returns the instant.
 */
export function zonedToInstant(
  fields: { year: number; month: number; day: number; hour?: number; minute?: number },
  timezone: string,
): Date {
  const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour ?? 0, fields.minute ?? 0)
  const first = naive - offsetMs(new Date(naive), timezone)
  const second = naive - offsetMs(new Date(first), timezone)
  return new Date(second)
}

/**
 * The family's current calendar date.
 * @param timezone - IANA zone.
 * @param now - the instant to read; defaults to the present.
 * @returns `YYYY-MM-DD`.
 */
export function todayIso(timezone: string, now: Date = new Date()): string {
  const parts = zonedParts(now, timezone)
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}`
}

/**
 * Shift a calendar date by whole days without crossing into DST arithmetic.
 * @param dateIso - `YYYY-MM-DD`.
 * @param days - signed day count.
 * @returns `YYYY-MM-DD`.
 */
export function addDays(dateIso: string, days: number): string {
  const match = DATE_ONLY.exec(dateIso)
  if (match === null) throw new RangeError(`addDays expects YYYY-MM-DD, received ${JSON.stringify(dateIso)}`)
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/**
 * The instant window covering whole local days starting at a calendar date.
 * @param dateIso - first day, `YYYY-MM-DD`.
 * @param days - how many days the window spans; values below 1 are treated as 1.
 * @param timezone - IANA zone the days are local to.
 * @returns the half-open window.
 */
export function dayWindow(dateIso: string, days: number, timezone: string): Window {
  const span = Math.max(1, Math.trunc(days))
  const startMatch = DATE_ONLY.exec(dateIso)
  if (startMatch === null) throw new RangeError(`dayWindow expects YYYY-MM-DD, received ${JSON.stringify(dateIso)}`)
  const endIso = addDays(dateIso, span)
  const endMatch = DATE_ONLY.exec(endIso)!
  return {
    start: zonedToInstant({
      year: Number(startMatch[1]),
      month: Number(startMatch[2]),
      day: Number(startMatch[3]),
    }, timezone),
    end: zonedToInstant({
      year: Number(endMatch[1]),
      month: Number(endMatch[2]),
      day: Number(endMatch[3]),
    }, timezone),
  }
}

/**
 * Resolve a day as a person would say it.
 *
 * Understood: `today`, `tonight`, `tomorrow`, `yesterday`, a weekday name
 * (meaning the next such day, today included), and any `YYYY-MM-DD`. Anything
 * else returns `undefined` so a caller can report the phrase back rather than
 * silently answering about the wrong day.
 * @param phrase - the phrase as written.
 * @param timezone - IANA zone.
 * @param now - the instant "today" is relative to; defaults to the present.
 * @returns `YYYY-MM-DD`, or `undefined` when the phrase is not understood.
 */
export function resolveDay(phrase: string, timezone: string, now: Date = new Date()): string | undefined {
  const text = phrase.trim().toLowerCase()
  const today = todayIso(timezone, now)
  if (text === '' || text === 'today' || text === 'tonight') return today
  if (text === 'tomorrow') return addDays(today, 1)
  if (text === 'yesterday') return addDays(today, -1)
  if (DATE_ONLY.test(text)) return text
  const weekdayIndex = WEEKDAYS.indexOf(text as (typeof WEEKDAYS)[number])
  if (weekdayIndex >= 0) {
    const match = DATE_ONLY.exec(today)!
    const todayIndex = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    return addDays(today, (weekdayIndex - todayIndex + 7) % 7)
  }
  return undefined
}

/**
 * Phrase an instant or all-day date the way the butler says it out loud.
 * @param value - ISO instant, or `YYYY-MM-DD` for a whole day.
 * @param timezone - IANA zone to render in.
 * @returns a short human phrase, or the input unchanged when it does not parse.
 */
export function formatWhen(value: string, timezone: string): string {
  if (DATE_ONLY.test(value)) {
    const match = DATE_ONLY.exec(value)!
    const instant = zonedToInstant({
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: 12,
    }, timezone)
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    }).format(instant)
  }
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return value
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(instant)
}

/**
 * Phrase only the clock part of an instant, for listing several items on one
 * known day.
 * @param value - ISO instant, or `YYYY-MM-DD` for a whole day.
 * @param timezone - IANA zone to render in.
 * @returns `HH:MM`, or `all day` for a date-only value.
 */
export function formatTimeOfDay(value: string, timezone: string): string {
  if (DATE_ONLY.test(value)) return 'all day'
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return value
  const parts = zonedParts(instant, timezone)
  return `${pad(parts.hour)}:${pad(parts.minute)}`
}

/**
 * Describe how far away a due date is, which is what makes a chore list
 * actionable rather than a wall of dates.
 * @param value - ISO instant, or `YYYY-MM-DD`.
 * @param timezone - IANA zone.
 * @param now - the instant to measure from; defaults to the present.
 * @returns `overdue by 2 days`, `due today`, `in 3 days`, or `''` when undatable.
 */
export function describeDueness(value: string, timezone: string, now: Date = new Date()): string {
  const today = todayIso(timezone, now)
  const dueDay = DATE_ONLY.test(value) ? value : todayIso(timezone, new Date(value))
  if (!DATE_ONLY.test(dueDay)) return ''
  const dayNumber = (iso: string): number => {
    const match = DATE_ONLY.exec(iso)!
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000
  }
  const delta = dayNumber(dueDay) - dayNumber(today)
  if (delta === 0) return 'due today'
  if (delta === 1) return 'due tomorrow'
  if (delta === -1) return 'overdue since yesterday'
  if (delta < 0) return `overdue by ${Math.abs(delta)} days`
  return `in ${delta} days`
}
