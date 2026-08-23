/**
 * Breaks and bridge days — the arithmetic a family actually plans around.
 *
 * Knowing that Independence Day is on the 4th of July is not useful; the family
 * owns a calendar. What is useful is this:
 *
 * > Independence Day falls on a Friday this year, so that is a three-day weekend
 * > — and taking Thursday off makes it four.
 *
 * That second clause is the whole point of this module. A **break** is a run of
 * consecutive days nobody works, and a **bridge** is a small amount of leave that
 * joins a break to a nearby one, or stretches it into the weekend. The valuable
 * fact is the exchange rate: one day of leave for four days off is worth booking
 * three weeks early, and one day of leave for two days off is not worth
 * mentioning.
 *
 * Everything here is pure arithmetic over calendar dates. No clock, no zone, no
 * network — a break is a property of the calendar, not of the moment you ask.
 *
 * @module dsh-occasions/breaks
 */

import { addDays, holidaysBetween, weekdayOf } from './holidays.ts'
import type { Holiday } from './holidays.ts'

/** Monday to Friday, the default working week. */
export const DEFAULT_WORKDAYS: readonly number[] = [1, 2, 3, 4, 5]

/**
 * Most leave days considered when looking for a bridge.
 *
 * Three, because the highest-value bridge a family gets is the gap between
 * Christmas and New Year, which can be three working days. Beyond that it stops
 * being a bridge and becomes simply booking a holiday, which is not something
 * the butler should be inferring from the calendar.
 */
export const DEFAULT_MAX_LEAVE = 3

/** How the working week is shaped, for households that do not work Monday to Friday. */
export interface BreakOptions {
  /** Weekdays that are worked, 0 Sunday through 6 Saturday. Defaults to Monday-Friday. */
  readonly workdays?: readonly number[]
  /** Most leave days to consider spending on a bridge. Defaults to {@link DEFAULT_MAX_LEAVE}. */
  readonly maxLeave?: number
}

/** One way to spend leave, and what it buys. */
export interface LeaveOption {
  /** Working days to book off, in calendar order. */
  readonly leave: readonly string[]
  /** First day of the resulting break, `YYYY-MM-DD`. */
  readonly start: string
  /** Last day of the resulting break, `YYYY-MM-DD`. */
  readonly end: string
  /** Total consecutive days off, including the leave. */
  readonly days: number
  /**
   * Days gained beyond the leave spent — the part that makes this a bridge
   * rather than simply taking a day off.
   *
   * Zero means the leave bought exactly itself: taking the Thursday before a
   * Friday-to-Sunday holiday weekend makes it four days, but the family already
   * knew they could take a Thursday off. A positive bonus means the leave
   * *connected* the break to further days off — Thanksgiving Thursday plus the
   * Friday reaches the weekend and yields two free days — and that is the only
   * case worth raising unprompted.
   */
  readonly bonus: number
}

/** A run of consecutive days off, and the ways leave could extend it. */
export interface Break {
  /** First day off, `YYYY-MM-DD`. */
  readonly start: string
  /** Last day off, `YYYY-MM-DD`. */
  readonly end: string
  /** How many consecutive days off, with no leave spent. */
  readonly days: number
  /** Holidays observed inside this break, in calendar order. */
  readonly holidays: readonly Holiday[]
  /**
   * Worthwhile ways to extend it with leave, cheapest first.
   *
   * Only options that buy something a cheaper option does not are kept, so a
   * second day of leave that adds no further days off is not offered.
   *
   * Where two equal-cost options buy the same number of days — the Friday before
   * a Monday holiday and the Tuesday after it both make four — the earlier one
   * wins, so the suggestion is stable between runs and starts the break sooner,
   * which is usually the more useful half for travelling.
   */
  readonly options: readonly LeaveOption[]
}

/** Resolved settings plus the day-off lookup for a padded window. */
interface Calendar {
  readonly workdays: ReadonlySet<number>
  readonly holidays: ReadonlyMap<string, Holiday>
  readonly maxLeave: number
}

/**
 * Days of padding either side of the range of interest.
 *
 * A break can extend past the range being asked about, and a bridge can reach
 * further still, so holidays are resolved over a wider window than the question.
 * Four weeks is comfortably more than the longest reachable span.
 */
const PADDING_DAYS = 28

function buildCalendar(startIso: string, endIso: string, options: BreakOptions): Calendar {
  const holidays = new Map<string, Holiday>()
  for (const holiday of holidaysBetween(addDays(startIso, -PADDING_DAYS), addDays(endIso, PADDING_DAYS))) {
    holidays.set(holiday.observed, holiday)
  }
  return {
    workdays: new Set(options.workdays ?? DEFAULT_WORKDAYS),
    holidays,
    maxLeave: options.maxLeave ?? DEFAULT_MAX_LEAVE,
  }
}

/**
 * Whether a date is a day nobody works.
 *
 * A day is off when it is not a working weekday, or when a holiday is observed on
 * it. Note this reads the **observed** date: a Saturday Independence Day does not
 * make Saturday any more of a day off than it already was, but it does make the
 * Friday one.
 */
function isOff(dateIso: string, calendar: Calendar, granted: ReadonlySet<string>): boolean {
  if (granted.has(dateIso)) return true
  if (!calendar.workdays.has(weekdayOf(dateIso))) return true
  return calendar.holidays.has(dateIso)
}

const NO_LEAVE: ReadonlySet<string> = new Set()

/**
 * The maximal run of days off containing a date.
 *
 * Walks outward in both directions until it finds a working day, which is what
 * makes the run maximal — and therefore makes the days immediately outside it
 * guaranteed working days, which the bridge search relies on.
 */
function runContaining(
  dateIso: string,
  calendar: Calendar,
  granted: ReadonlySet<string>,
): { start: string; end: string; days: number } {
  if (!isOff(dateIso, calendar, granted)) return { start: dateIso, end: dateIso, days: 0 }
  let start = dateIso
  for (;;) {
    const previous = addDays(start, -1)
    if (!isOff(previous, calendar, granted)) break
    start = previous
  }
  let end = dateIso
  for (;;) {
    const next = addDays(end, 1)
    if (!isOff(next, calendar, granted)) break
    end = next
  }
  return { start, end, days: daysBetween(start, end) }
}

/** Inclusive day count between two dates. */
function daysBetween(startIso: string, endIso: string): number {
  let count = 1
  let cursor = startIso
  while (cursor < endIso) {
    cursor = addDays(cursor, 1)
    count += 1
  }
  return count
}

/**
 * Consecutive working days immediately before a break, up to a limit.
 *
 * Stops early on reaching a day that is already off, because at that point the
 * bridge is complete and asking for more leave would be spending it on a day the
 * family already has.
 */
function leaveBefore(startIso: string, limit: number, calendar: Calendar): string[] {
  const days: string[] = []
  let cursor = addDays(startIso, -1)
  while (days.length < limit && !isOff(cursor, calendar, NO_LEAVE)) {
    days.unshift(cursor)
    cursor = addDays(cursor, -1)
  }
  return days
}

/** Consecutive working days immediately after a break, up to a limit. */
function leaveAfter(endIso: string, limit: number, calendar: Calendar): string[] {
  const days: string[] = []
  let cursor = addDays(endIso, 1)
  while (days.length < limit && !isOff(cursor, calendar, NO_LEAVE)) {
    days.push(cursor)
    cursor = addDays(cursor, 1)
  }
  return days
}

/**
 * Every worthwhile way to extend a break with leave.
 *
 * Searches leave taken before, after, and on both sides, because a holiday
 * mid-week is bridged in both directions at once — a Wednesday holiday plus
 * Thursday and Friday reaches the weekend, and neither day alone does.
 *
 * Options are then pruned so only genuine improvements survive: the best span for
 * each leave cost, and only where it beats every cheaper option. A second day of
 * leave that buys nothing further is not something to suggest.
 */
function leaveOptionsFor(
  span: { start: string; end: string; days: number },
  target: string,
  calendar: Calendar,
): LeaveOption[] {
  const best = new Map<number, LeaveOption>()
  for (let before = 0; before <= calendar.maxLeave; before += 1) {
    for (let after = 0; after + before <= calendar.maxLeave; after += 1) {
      if (before === 0 && after === 0) continue
      const leave = [
        ...leaveBefore(span.start, before, calendar),
        ...leaveAfter(span.end, after, calendar),
      ]
      if (leave.length === 0) continue
      const granted = new Set(leave)
      const extended = runContaining(target, calendar, granted)
      if (extended.days <= span.days) continue
      const existing = best.get(leave.length)
      // Ties are broken toward the earlier leave day so the output is stable
      // rather than an artefact of loop order: bridging a Friday-observed
      // holiday with the Thursday before and the Monday after both buy four
      // days, and the family should get the same suggestion every time.
      const better = existing === undefined
        || extended.days > existing.days
        || (extended.days === existing.days && leave[0]! < existing.leave[0]!)
      if (better) {
        best.set(leave.length, {
          leave,
          start: extended.start,
          end: extended.end,
          days: extended.days,
          bonus: extended.days - span.days - leave.length,
        })
      }
    }
  }
  const ranked: LeaveOption[] = []
  let bestSoFar = span.days
  for (const cost of [...best.keys()].sort((left, right) => left - right)) {
    const option = best.get(cost)
    // Only keep a costlier option when it actually buys more days than every
    // cheaper one already offers.
    if (option !== undefined && option.days > bestSoFar) {
      ranked.push(option)
      bestSoFar = option.days
    }
  }
  return ranked
}

/**
 * The break containing a date, with the ways leave could extend it.
 *
 * When the date is an ordinary working day the result has `days: 0` and no
 * options, because there is no break there to describe. Observed holiday dates
 * are always days off, so callers passing one always get a real break.
 * @param dateIso - the date of interest, `YYYY-MM-DD`.
 * @param options - shape of the working week and leave budget.
 * @returns the break around that date.
 */
export function breakAround(dateIso: string, options: BreakOptions = {}): Break {
  const calendar = buildCalendar(dateIso, dateIso, options)
  return describeBreak(dateIso, calendar)
}

function describeBreak(dateIso: string, calendar: Calendar): Break {
  const span = runContaining(dateIso, calendar, NO_LEAVE)
  if (span.days === 0) {
    return { start: span.start, end: span.end, days: 0, holidays: [], options: [] }
  }
  const holidays: Holiday[] = []
  for (let cursor = span.start; cursor <= span.end; cursor = addDays(cursor, 1)) {
    const holiday = calendar.holidays.get(cursor)
    if (holiday !== undefined) holidays.push(holiday)
  }
  return {
    start: span.start,
    end: span.end,
    days: span.days,
    holidays,
    options: leaveOptionsFor(span, dateIso, calendar),
  }
}

/**
 * Every break that overlaps a date range.
 *
 * Breaks are reported whole even when they only partly overlap the range, since a
 * long weekend starting the day after the range ends is exactly the thing worth
 * being told about early.
 * @param startIso - first day of the range, `YYYY-MM-DD`.
 * @param endIso - last day of the range, `YYYY-MM-DD`.
 * @param options - shape of the working week and leave budget.
 * @returns the breaks, in calendar order, each appearing once.
 */
export function breaksBetween(startIso: string, endIso: string, options: BreakOptions = {}): Break[] {
  const calendar = buildCalendar(startIso, endIso, options)
  const found: Break[] = []
  const seen = new Set<string>()
  for (let cursor = startIso; cursor <= endIso; cursor = addDays(cursor, 1)) {
    if (!isOff(cursor, calendar, NO_LEAVE)) continue
    const span = runContaining(cursor, calendar, NO_LEAVE)
    if (seen.has(span.start)) continue
    seen.add(span.start)
    found.push(describeBreak(span.start, calendar))
  }
  return found
}

/**
 * Breaks worth planning around: those containing a holiday, or longer than the
 * household's ordinary weekend.
 *
 * This is the filter that keeps the butler from announcing every Saturday.
 *
 * It deliberately does **not** include "an ordinary weekend that one day of leave
 * would turn into four", even though that sounds like exactly the thing worth
 * saying. The only way a single day of leave stretches a plain weekend that far
 * is by bridging to a nearby holiday — and that holiday's own break is already in
 * this list, carrying the same suggestion. Including both reported Thanksgiving
 * twice: once as the Thursday, and again as the weekend after it. One opportunity
 * should produce one conversation.
 * @param startIso - first day of the range, `YYYY-MM-DD`.
 * @param endIso - last day of the range, `YYYY-MM-DD`.
 * @param options - shape of the working week and leave budget.
 * @returns the notable breaks, in calendar order.
 */
export function notableBreaks(startIso: string, endIso: string, options: BreakOptions = {}): Break[] {
  const ordinaryWeekend = 7 - (options.workdays ?? DEFAULT_WORKDAYS).length
  return breaksBetween(startIso, endIso, options)
    .filter(entry => entry.holidays.length > 0 || entry.days > ordinaryWeekend)
}
