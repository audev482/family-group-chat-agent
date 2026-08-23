/**
 * Birthdays, anniversaries, and the one list that merges them with holidays.
 *
 * These are the occasions that come from the household rather than from statute.
 * They are simpler than holidays — an annual repeat of a month and day — with two
 * details worth getting right.
 *
 * The first is the **ordinal**: a fortieth birthday and a tenth anniversary are
 * not the same as any other year, and a butler that knows which one it is can say
 * so. That only works when the stored date carries a year, so it is optional
 * throughout rather than required.
 *
 * The second is the **29th of February**. In a common year that date does not
 * exist, and the wrong answer is to skip it — a leap-day birthday would go
 * unmentioned three years in four. It is observed on the 28th instead, and
 * flagged as adjusted so the butler can explain itself.
 *
 * @module dsh-occasions/occasions
 */

import { addDays, daysInMonth, holidaysBetween } from './holidays.ts'
import type { Holiday } from './holidays.ts'

/** What kind of thing is coming up. */
export type OccasionKind = 'holiday' | 'birthday' | 'anniversary'

/** One dated thing coming up, whatever its origin. */
export interface Occasion {
  /** Where it came from. */
  readonly kind: OccasionKind
  /** Stable identifier, e.g. `birthday:kit` or `holiday:thanksgiving`. */
  readonly id: string
  /** How the butler would name it, e.g. `Kit's birthday`. */
  readonly name: string
  /** The date it is marked on this time round, `YYYY-MM-DD`. */
  readonly date: string
  /** Whole days from the reference date; 0 means today. */
  readonly daysAway: number
  /**
   * Which one this is — the age being turned, or the number of years being
   * marked. Absent when the stored date carries no year, and for holidays.
   */
  readonly ordinal?: number
  /**
   * Set when `date` is not the literal anniversary: a leap-day birthday observed
   * on the 28th, or a holiday moved off a weekend.
   */
  readonly adjusted?: boolean
}

/** A person who may have a birthday. Structurally satisfied by a household member. */
export interface BirthdayPerson {
  /** Roster key, used to build a stable occasion id. */
  readonly key: string
  /** Name as the butler says it. */
  readonly displayName: string
  /** `MM-DD` or `YYYY-MM-DD`. */
  readonly birthday?: string
}

/** A household-level recurring date: a wedding anniversary, the day you moved in. */
export interface HouseholdOccasion {
  /** Stable key, used to build the occasion id. */
  readonly id: string
  /** Name as the butler says it. */
  readonly name: string
  /** `MM-DD` or `YYYY-MM-DD`. */
  readonly date: string
}

const MONTH_DAY = /^(\d{2})-(\d{2})$/
const FULL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/** A recurring month and day, with the original year when one was given. */
export interface RecurringDate {
  /** 1-12. */
  readonly month: number
  /** 1-31. */
  readonly day: number
  /** The year it first happened, when the pattern carried one. */
  readonly year?: number
}

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * Parse a recurring date written as `MM-DD` or `YYYY-MM-DD`.
 *
 * Both forms are accepted because a household knows some dates fully and others
 * only as a day in the year, and refusing the shorter form would push families
 * into inventing a birth year.
 * @param pattern - `MM-DD` or `YYYY-MM-DD`.
 * @returns the parsed parts, or `undefined` when the pattern is neither form or
 * names a day the month does not have.
 */
export function parseRecurring(pattern: string): RecurringDate | undefined {
  const full = FULL_DATE.exec(pattern)
  const short = MONTH_DAY.exec(pattern)
  const month = Number(full?.[2] ?? short?.[1])
  const day = Number(full?.[3] ?? short?.[2])
  if (full === null && short === null) return undefined
  if (month < 1 || month > 12 || day < 1) return undefined
  // Checked against a leap year so the 29th of February is accepted as a
  // pattern; whether it exists in a particular year is a separate question.
  if (day > daysInMonth(2028, month)) return undefined
  return full === null ? { month, day } : { month, day, year: Number(full[1]) }
}

/** Whole days from one date to another; negative when the second is earlier. */
export function dayDiff(fromIso: string, toIso: string): number {
  const from = FULL_DATE.exec(fromIso)
  const to = FULL_DATE.exec(toIso)
  if (from === null || to === null) {
    throw new RangeError(`dayDiff expects YYYY-MM-DD, received ${JSON.stringify(fromIso)} and ${JSON.stringify(toIso)}`)
  }
  const start = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]))
  const end = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]))
  return Math.round((end - start) / 86_400_000)
}

/**
 * When a recurring date next falls, on or after a reference date.
 *
 * Today counts as "next": a birthday is not missed by asking about it on the
 * morning it happens.
 * @param recurring - the month and day that repeats.
 * @param fromIso - reference date, `YYYY-MM-DD`.
 * @returns the date and whether it had to be moved.
 */
export function nextOccurrence(recurring: RecurringDate, fromIso: string): { date: string; adjusted: boolean } {
  const fromYear = Number(fromIso.slice(0, 4))
  for (const year of [fromYear, fromYear + 1]) {
    const exists = recurring.day <= daysInMonth(year, recurring.month)
    // A leap-day date in a common year is kept in February rather than pushed
    // into March, so it stays the same month the family thinks of it as.
    const day = exists ? recurring.day : daysInMonth(year, recurring.month)
    const candidate = `${year}-${pad(recurring.month)}-${pad(day)}`
    if (candidate >= fromIso) return { date: candidate, adjusted: !exists }
  }
  // Unreachable: the second candidate year is always in the future.
  throw new RangeError(`no occurrence of ${recurring.month}-${recurring.day} on or after ${fromIso}`)
}

function occasionFrom(
  kind: OccasionKind,
  id: string,
  name: string,
  pattern: string,
  fromIso: string,
): Occasion | undefined {
  const recurring = parseRecurring(pattern)
  if (recurring === undefined) return undefined
  const { date, adjusted } = nextOccurrence(recurring, fromIso)
  const ordinal = recurring.year === undefined ? undefined : Number(date.slice(0, 4)) - recurring.year
  return {
    kind,
    id,
    name,
    date,
    daysAway: dayDiff(fromIso, date),
    // A zero or negative ordinal means the stored year is this year or later,
    // which is a typo rather than a fact worth stating.
    ...ordinal !== undefined && ordinal > 0 ? { ordinal } : {},
    ...adjusted ? { adjusted: true } : {},
  }
}

/**
 * The next birthday for each member who has one recorded.
 *
 * Members with no birthday are skipped rather than reported as unknown: the
 * butler should be quiet about what it has not been told.
 * @param people - household members.
 * @param fromIso - reference date, `YYYY-MM-DD`.
 * @returns one occasion per member with a birthday, in date order.
 */
export function birthdayOccasions(people: readonly BirthdayPerson[], fromIso: string): Occasion[] {
  const found: Occasion[] = []
  for (const person of people) {
    if (person.birthday === undefined) continue
    const occasion = occasionFrom(
      'birthday',
      `birthday:${person.key}`,
      `${person.displayName}'s birthday`,
      person.birthday,
      fromIso,
    )
    if (occasion !== undefined) found.push(occasion)
  }
  return sortByDate(found)
}

/**
 * The next occurrence of each household-level recurring date.
 * @param occasions - configured household occasions.
 * @param fromIso - reference date, `YYYY-MM-DD`.
 * @returns one occasion per configured entry, in date order.
 */
export function householdOccasions(occasions: readonly HouseholdOccasion[], fromIso: string): Occasion[] {
  const found: Occasion[] = []
  for (const entry of occasions) {
    const occasion = occasionFrom('anniversary', `anniversary:${entry.id}`, entry.name, entry.date, fromIso)
    if (occasion !== undefined) found.push(occasion)
  }
  return sortByDate(found)
}

/** Holidays observed in a window, as occasions. */
function holidayOccasions(fromIso: string, withinDays: number): Occasion[] {
  return holidaysBetween(fromIso, addDays(fromIso, withinDays)).map((holiday: Holiday) => ({
    kind: 'holiday' as const,
    id: `holiday:${holiday.id}`,
    name: holiday.name,
    date: holiday.observed,
    daysAway: dayDiff(fromIso, holiday.observed),
    ...holiday.shift === undefined ? {} : { adjusted: true },
  }))
}

function sortByDate(occasions: Occasion[]): Occasion[] {
  return occasions.sort((left, right) => (left.date < right.date ? -1 : left.date > right.date ? 1 : left.id < right.id ? -1 : 1))
}

/** What the household contributes to the occasion list. */
export interface OccasionSources {
  /** Members whose birthdays should be included. */
  readonly people?: readonly BirthdayPerson[]
  /** Household-level recurring dates. */
  readonly occasions?: readonly HouseholdOccasion[]
  /** Whether to include US federal holidays. Defaults to true. */
  readonly holidays?: boolean
}

/**
 * Everything coming up within a window, in date order.
 *
 * One merged list because the planner's question is "what is coming up?", not
 * "what holidays are coming up, and separately what birthdays". Ties are broken
 * by id so the order is stable when a birthday shares a day with a holiday.
 * @param fromIso - reference date, `YYYY-MM-DD`.
 * @param withinDays - how far ahead to look, in days.
 * @param sources - what the household contributes.
 * @returns the occasions falling in the window, nearest first.
 */
export function upcomingOccasions(
  fromIso: string,
  withinDays: number,
  sources: OccasionSources = {},
): Occasion[] {
  const found: Occasion[] = [
    ...sources.holidays === false ? [] : holidayOccasions(fromIso, withinDays),
    ...birthdayOccasions(sources.people ?? [], fromIso),
    ...householdOccasions(sources.occasions ?? [], fromIso),
  ]
  return sortByDate(found.filter(occasion => occasion.daysAway >= 0 && occasion.daysAway <= withinDays))
}
