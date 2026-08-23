/**
 * The daily schedule: when the next digest is due, computed in the family's own
 * time zone.
 *
 * Kept separate from the plugin so the arithmetic is testable without timers, a
 * connection, or a clock that has to be waited on.
 *
 * The subtlety is daylight saving. Two obvious implementations both drift:
 *
 * - "now plus 24 hours" moves the digest an hour twice a year.
 * - "local midnight plus 7½ hours" is worse in a quieter way: on the transition
 *   day, local midnight is at the *old* offset, so adding hours to it crosses the
 *   transition and lands an hour out — on exactly the morning it matters.
 *
 * So the wall-clock time is resolved directly in the zone instead, reusing
 * `dsh-household`'s `zonedToInstant`, which applies the offset twice to settle on
 * the right side of a transition.
 *
 * @module dsh-household/schedule
 */

import { zonedToInstant } from './clock.ts'

/** `HH:MM` on a 24-hour clock. */
const TIME_OF_DAY = /^(\d{1,2}):(\d{2})$/

/** A parsed time of day. */
export interface TimeOfDay {
  /** Hour, 0–23. */
  readonly hour: number
  /** Minute, 0–59. */
  readonly minute: number
}

/**
 * Parse a configured `HH:MM`.
 * @param value - the configured time.
 * @returns the time of day.
 */
export function parseTimeOfDay(value: string): TimeOfDay {
  const match = TIME_OF_DAY.exec(value.trim())
  if (match === null) {
    throw new RangeError(`briefing time ${JSON.stringify(value)} must be HH:MM on a 24-hour clock, e.g. "07:30"`)
  }
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) {
    throw new RangeError(`briefing time ${JSON.stringify(value)} is not a real time of day`)
  }
  return { hour, minute }
}

/** What a household must provide for the schedule to be local rather than UTC. */
export interface ScheduleClock {
  /** The family's IANA time zone. */
  readonly timezone: string
  /**
   * The family's current calendar date.
   * @param now - the instant to read.
   * @returns `YYYY-MM-DD`.
   */
  today(now?: Date): string
  /**
   * Shift a calendar date by whole days.
   * @param dateIso - `YYYY-MM-DD`.
   * @param days - signed day count.
   * @returns `YYYY-MM-DD`.
   */
  shiftDay(dateIso: string, days: number): string
}

/**
 * Resolve a local calendar day and time of day to an instant.
 * @param dayIso - `YYYY-MM-DD`.
 * @param at - the local time of day.
 * @param timezone - the family's time zone.
 * @returns the instant.
 */
function instantOn(dayIso: string, at: TimeOfDay, timezone: string): Date {
  const [year, month, day] = dayIso.split('-').map(Number) as [number, number, number]
  return zonedToInstant({ year, month, day, hour: at.hour, minute: at.minute }, timezone)
}

/**
 * The next instant the digest is due.
 *
 * Derived from the local wall-clock time rather than by adding a fixed number of
 * hours to anything, so the digest keeps arriving at breakfast across a daylight
 * saving change instead of drifting an hour twice a year.
 * @param clock - the household clock.
 * @param at - the configured time of day.
 * @param now - the instant to schedule from.
 * @returns the next due instant, strictly after `now`.
 */
export function nextRun(clock: ScheduleClock, at: TimeOfDay, now: Date): Date {
  const today = clock.today(now)
  const dueToday = instantOn(today, at, clock.timezone)
  if (dueToday.getTime() > now.getTime()) return dueToday
  return instantOn(clock.shiftDay(today, 1), at, clock.timezone)
}
