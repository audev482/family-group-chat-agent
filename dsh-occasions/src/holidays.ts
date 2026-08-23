/**
 * US federal holidays, computed from their statutory rules.
 *
 * Holidays are not a list, they are **rules**: the third Monday in January, the
 * last Monday in May, the fourth Thursday in November. Computing them means the
 * butler is correct in 2031 without anyone updating a table, needs no network
 * call, and cannot be broken by a feed going away.
 *
 * The part that actually matters for planning is the **observation shift**.
 * 5 U.S.C. § 6103 moves a fixed-date holiday that lands on a weekend: Saturday
 * is observed on the preceding Friday, Sunday on the following Monday. That rule
 * is what decides whether a family gets a long weekend, so it is modelled
 * explicitly rather than folded away — `date` is the statutory day and
 * `observed` is the day off, and they differ often enough to matter.
 *
 * Weekday-rule holidays never need the shift: they are defined as falling on a
 * Monday or a Thursday, so they are never on a weekend to begin with.
 *
 * @module dsh-occasions/holidays
 */

/** Days of the week as `Date` reports them, for readable rule declarations. */
export const SUNDAY = 0
/** Monday. */
export const MONDAY = 1
/** Thursday. */
export const THURSDAY = 4
/** Saturday. */
export const SATURDAY = 6

/** Stable identifiers for the federal holidays. */
export type HolidayId =
  | 'new-years-day'
  | 'martin-luther-king-jr-day'
  | 'washingtons-birthday'
  | 'memorial-day'
  | 'juneteenth'
  | 'independence-day'
  | 'labor-day'
  | 'columbus-day'
  | 'veterans-day'
  | 'thanksgiving'
  | 'christmas-day'

/** Why an observed date differs from the statutory one. */
export type ObservationShift = 'saturday-to-friday' | 'sunday-to-monday'

/** One holiday resolved to a specific year. */
export interface Holiday {
  /** Stable identifier. */
  readonly id: HolidayId
  /** Human name, as the butler would say it. */
  readonly name: string
  /** The statutory date, `YYYY-MM-DD`. */
  readonly date: string
  /**
   * The date it is actually taken as a day off, `YYYY-MM-DD`. Equal to `date`
   * unless the weekend shift applied.
   */
  readonly observed: string
  /** Present only when `observed` differs from `date`. */
  readonly shift?: ObservationShift
}

/** How a holiday's statutory date is determined. */
type HolidayRule =
  /** A calendar date that does not move, e.g. the 4th of July. */
  | { readonly kind: 'fixed'; readonly month: number; readonly day: number }
  /** The nth given weekday of a month, e.g. the 3rd Monday in January. */
  | { readonly kind: 'nth-weekday'; readonly month: number; readonly weekday: number; readonly nth: number }
  /** The final given weekday of a month, e.g. the last Monday in May. */
  | { readonly kind: 'last-weekday'; readonly month: number; readonly weekday: number }

interface HolidayDefinition {
  readonly id: HolidayId
  readonly name: string
  readonly rule: HolidayRule
  /** First year this was a federal holiday, where that is recent enough to matter. */
  readonly since?: number
}

/**
 * The current federal set, in calendar order.
 *
 * This is the *modern* set and is not a history of federal holidays. Juneteenth
 * carries a `since` because 2021 is recent enough that reporting it for an
 * earlier year would be an outright wrong answer; the older holidays predate any
 * year this butler will be asked about.
 */
const DEFINITIONS: readonly HolidayDefinition[] = [
  { id: 'new-years-day', name: "New Year's Day", rule: { kind: 'fixed', month: 1, day: 1 } },
  { id: 'martin-luther-king-jr-day', name: 'Martin Luther King Jr. Day', rule: { kind: 'nth-weekday', month: 1, weekday: MONDAY, nth: 3 } },
  { id: 'washingtons-birthday', name: "Presidents' Day", rule: { kind: 'nth-weekday', month: 2, weekday: MONDAY, nth: 3 } },
  { id: 'memorial-day', name: 'Memorial Day', rule: { kind: 'last-weekday', month: 5, weekday: MONDAY } },
  { id: 'juneteenth', name: 'Juneteenth', rule: { kind: 'fixed', month: 6, day: 19 }, since: 2021 },
  { id: 'independence-day', name: 'Independence Day', rule: { kind: 'fixed', month: 7, day: 4 } },
  { id: 'labor-day', name: 'Labor Day', rule: { kind: 'nth-weekday', month: 9, weekday: MONDAY, nth: 1 } },
  { id: 'columbus-day', name: 'Columbus Day', rule: { kind: 'nth-weekday', month: 10, weekday: MONDAY, nth: 2 } },
  { id: 'veterans-day', name: 'Veterans Day', rule: { kind: 'fixed', month: 11, day: 11 } },
  { id: 'thanksgiving', name: 'Thanksgiving', rule: { kind: 'nth-weekday', month: 11, weekday: THURSDAY, nth: 4 } },
  { id: 'christmas-day', name: 'Christmas Day', rule: { kind: 'fixed', month: 12, day: 25 } },
]

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function iso(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(day)}`
}

/**
 * The day of the week a calendar date falls on.
 *
 * Read through UTC deliberately: a date-only value has no time and no zone, so
 * building it as UTC keeps the answer independent of where the process runs. A
 * local-time `Date` would shift the weekday for anyone east or west far enough.
 * @param dateIso - `YYYY-MM-DD`.
 * @returns 0 for Sunday through 6 for Saturday.
 */
export function weekdayOf(dateIso: string): number {
  const match = DATE_ONLY.exec(dateIso)
  if (match === null) throw new RangeError(`weekdayOf expects YYYY-MM-DD, received ${JSON.stringify(dateIso)}`)
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
}

/**
 * How many days a month has, leap years included.
 * @param year - full year.
 * @param month - 1-12.
 * @returns the day count.
 */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one, which gets leap
  // Februaries right without a leap-year rule written out here.
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * The nth given weekday of a month.
 * @param year - full year.
 * @param month - 1-12.
 * @param weekday - 0 Sunday through 6 Saturday.
 * @param nth - 1-based occurrence.
 * @returns the date as `YYYY-MM-DD`.
 * @throws RangeError when the month has no nth such weekday.
 */
export function nthWeekdayOf(year: number, month: number, weekday: number, nth: number): string {
  const firstWeekday = weekdayOf(iso(year, month, 1))
  const offset = (weekday - firstWeekday + 7) % 7
  const day = 1 + offset + (nth - 1) * 7
  if (day > daysInMonth(year, month)) {
    throw new RangeError(`${year}-${pad(month)} has no ${nth}th weekday ${weekday}`)
  }
  return iso(year, month, day)
}

/**
 * The last given weekday of a month — Memorial Day's rule.
 * @param year - full year.
 * @param month - 1-12.
 * @param weekday - 0 Sunday through 6 Saturday.
 * @returns the date as `YYYY-MM-DD`.
 */
export function lastWeekdayOf(year: number, month: number, weekday: number): string {
  const lastDay = daysInMonth(year, month)
  const back = (weekdayOf(iso(year, month, lastDay)) - weekday + 7) % 7
  return iso(year, month, lastDay - back)
}

/**
 * Apply the federal weekend-observation rule.
 *
 * Note that the observed date can land in a **different year** than the
 * statutory one: when the 1st of January is a Saturday it is observed on the
 * 31st of December before it. Anything scanning a date range therefore has to
 * look at the neighbouring years, which is why {@link holidaysBetween} exists
 * rather than callers filtering {@link federalHolidays} themselves.
 * @param dateIso - the statutory date, `YYYY-MM-DD`.
 * @returns the observed date and the shift that produced it, if any.
 */
export function observedDate(dateIso: string): { observed: string; shift?: ObservationShift } {
  const weekday = weekdayOf(dateIso)
  if (weekday === SATURDAY) return { observed: addDays(dateIso, -1), shift: 'saturday-to-friday' }
  if (weekday === SUNDAY) return { observed: addDays(dateIso, 1), shift: 'sunday-to-monday' }
  return { observed: dateIso }
}

/**
 * Shift a calendar date by whole days.
 *
 * Local to this module and UTC-based, so it cannot drift across a daylight-saving
 * boundary. Holiday rules are calendar arithmetic, not clock arithmetic.
 * @param dateIso - `YYYY-MM-DD`.
 * @param days - days to add; negative subtracts.
 * @returns the shifted date as `YYYY-MM-DD`.
 */
export function addDays(dateIso: string, days: number): string {
  const match = DATE_ONLY.exec(dateIso)
  if (match === null) throw new RangeError(`addDays expects YYYY-MM-DD, received ${JSON.stringify(dateIso)}`)
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  return iso(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate())
}

function resolveRule(rule: HolidayRule, year: number): string {
  if (rule.kind === 'fixed') return iso(year, rule.month, rule.day)
  if (rule.kind === 'nth-weekday') return nthWeekdayOf(year, rule.month, rule.weekday, rule.nth)
  return lastWeekdayOf(year, rule.month, rule.weekday)
}

/**
 * Every federal holiday whose statutory date falls in a given year.
 *
 * Ordered by statutory date. A holiday observed in this year but statutory in
 * the next (a Saturday New Year's Day) belongs to the next year's list; use
 * {@link holidaysBetween} when you care about days off within a range.
 * @param year - full year.
 * @returns the holidays, in calendar order.
 */
export function federalHolidays(year: number): Holiday[] {
  return DEFINITIONS
    .filter(definition => definition.since === undefined || year >= definition.since)
    .map((definition) => {
      const date = resolveRule(definition.rule, year)
      const { observed, shift } = observedDate(date)
      return {
        id: definition.id,
        name: definition.name,
        date,
        observed,
        ...shift === undefined ? {} : { shift },
      }
    })
}

/**
 * Every federal holiday **observed** within an inclusive date range.
 *
 * Selects on `observed` rather than `date` because the question a family asks is
 * about days off. Scans the neighbouring years too, so a range ending on the
 * 31st of December still finds a New Year's Day observed early.
 * @param startIso - first day of the range, `YYYY-MM-DD`.
 * @param endIso - last day of the range, `YYYY-MM-DD`.
 * @returns the holidays observed in the range, ordered by observed date.
 */
export function holidaysBetween(startIso: string, endIso: string): Holiday[] {
  const firstYear = Number(startIso.slice(0, 4)) - 1
  const lastYear = Number(endIso.slice(0, 4)) + 1
  const found: Holiday[] = []
  for (let year = firstYear; year <= lastYear; year += 1) {
    for (const holiday of federalHolidays(year)) {
      if (holiday.observed >= startIso && holiday.observed <= endIso) found.push(holiday)
    }
  }
  // ISO dates sort lexicographically, which is the whole reason this codebase
  // keeps dates as strings.
  return found.sort((left, right) => (left.observed < right.observed ? -1 : left.observed > right.observed ? 1 : 0))
}
