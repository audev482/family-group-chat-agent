/**
 * dsh-occasions — what is coming up, and what it is worth.
 *
 * Two layers. Underneath, pure arithmetic: US federal holidays from their
 * statutory rules, birthdays and anniversaries from the household, and the
 * derived facts a family plans around — how long a break really is, and what a
 * day of leave would buy. None of it touches the network or the clock, so it is
 * the same answer in July as it is in December and can be tested exhaustively.
 *
 * On top, one tool. `occasions_upcoming` answers "anything coming up?" and "are
 * there any long weekends soon?", which is the question a family asks before
 * booking anything.
 *
 * There is deliberately **no prompt context** here. Restating the next month of
 * the calendar on every single turn would spend tokens on every "what's for
 * dinner" to serve the rare planning conversation, and the two paths that
 * genuinely need this — the morning briefing and proactive planning — read the
 * functions directly rather than through the model.
 *
 * @module dsh-occasions
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'

export {
  addDays,
  daysInMonth,
  federalHolidays,
  holidaysBetween,
  lastWeekdayOf,
  MONDAY,
  nthWeekdayOf,
  observedDate,
  SATURDAY,
  SUNDAY,
  THURSDAY,
  weekdayOf,
} from './holidays.ts'
export type { Holiday, HolidayId, ObservationShift } from './holidays.ts'
export {
  breakAround,
  breaksBetween,
  DEFAULT_MAX_LEAVE,
  DEFAULT_WORKDAYS,
  notableBreaks,
} from './breaks.ts'
export type { Break, BreakOptions, LeaveOption } from './breaks.ts'
export {
  birthdayOccasions,
  dayDiff,
  householdOccasions,
  nextOccurrence,
  parseRecurring,
  upcomingOccasions,
} from './occasions.ts'
export type {
  BirthdayPerson,
  HouseholdOccasion,
  Occasion,
  OccasionKind,
  OccasionSources,
  RecurringDate,
} from './occasions.ts'

import { notableBreaks } from './breaks.ts'
import type { Break, LeaveOption } from './breaks.ts'
import { upcomingOccasions } from './occasions.ts'
import type { Occasion } from './occasions.ts'
import { addDays } from './holidays.ts'

/** Plugin name. */
export const name = 'occasions'

/** Injected services. */
export const inject = ['household', 'tools']

/** How far ahead `occasions_upcoming` looks when not told otherwise. */
export const DEFAULT_WITHIN_DAYS = 45

/** Configuration. */
export interface Config {
  /**
   * Household-level recurring dates, overriding `occasions` in the
   * `dsh-household` config.
   *
   * These normally belong on the household, alongside the roster and the time
   * zone, because a wedding anniversary is a fact about the family rather than
   * about this plugin. Set them here only to override that.
   */
  occasions?: Record<string, { name: string; date: string }>
  /** Weekdays the adults work, 0 Sunday through 6 Saturday. Defaults to Monday-Friday. */
  workdays?: number[]
  /** Most leave days to consider spending on a bridge. Defaults to 3. */
  maxLeave?: number
  /** Whether to include US federal holidays. Defaults to true. */
  federalHolidays?: boolean
}

/** Configuration schema. */
export const Config: z<Config> = z.object({
  occasions: z.dict(z.object({
    name: z.string().required(),
    date: z.string().required(),
  })),
  workdays: z.array(z.number()).default([1, 2, 3, 4, 5]),
  maxLeave: z.number().default(3),
  federalHolidays: z.boolean().default(true),
})

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args: unknown, value: string) {
    return [{ type: 'text', text: value }] as never
  },
} as const

/** Render a distance in days the way a person would say it. */
export function describeDistance(days: number): string {
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 14) return `in ${days} days`
  if (days < 60) return `in ${Math.round(days / 7)} weeks`
  return `in ${Math.round(days / 30)} months`
}

/** One occasion as a line of prose. */
export function occasionLine(occasion: Occasion): string {
  const ordinal = occasion.ordinal === undefined ? '' : ` (${ordinalSuffix(occasion.ordinal)})`
  const adjusted = occasion.adjusted === true ? ', observed' : ''
  return `- ${occasion.name}${ordinal}: ${occasion.date}${adjusted}, ${describeDistance(occasion.daysAway)}`
}

/** `12` becomes `12th`, `21` becomes `21st`. */
export function ordinalSuffix(value: number): string {
  const tens = value % 100
  if (tens >= 11 && tens <= 13) return `${value}th`
  const ones = value % 10
  if (ones === 1) return `${value}st`
  if (ones === 2) return `${value}nd`
  if (ones === 3) return `${value}rd`
  return `${value}th`
}

/** `1 day` but `3 days`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

/**
 * The leave worth actually suggesting, or `undefined` when there is none.
 *
 * Picks the option that gains the most days beyond the leave it costs, not the
 * cheapest one. For a Wednesday holiday the cheapest option is a single day
 * either side, which buys a two-day break and is not worth saying; two days
 * reaches the weekend and yields five. Ties go to the cheaper option.
 *
 * Returns nothing when no option gains anything, which is the honest answer for a
 * holiday weekend already flush against the weekend on both sides: the family can
 * always take a day off, and pointing that out is noise rather than insight.
 */
export function bestBridge(entry: Break): LeaveOption | undefined {
  let best: LeaveOption | undefined
  for (const option of entry.options) {
    if (option.bonus <= 0) continue
    if (best === undefined || option.bonus > best.bonus
      || (option.bonus === best.bonus && option.leave.length < best.leave.length)) {
      best = option
    }
  }
  return best
}

/**
 * One break as a line of prose, including what leave would buy.
 *
 * The exchange rate is the point: "one day off makes it four" is the sentence
 * that gets a family to book something in time.
 */
export function breakLine(entry: Break): string {
  const names = entry.holidays.map(holiday => holiday.name).join(' and ')
  const label = names === '' ? 'A long weekend' : names
  const head = `- ${label}: ${entry.start} to ${entry.end}, ${plural(entry.days, 'day')} off`
  const bridge = bestBridge(entry)
  if (bridge === undefined) return head
  const leave = bridge.leave.length === 1
    ? `taking ${bridge.leave[0]} off`
    : `taking ${plural(bridge.leave.length, 'day')} off (${bridge.leave.join(', ')})`
  return `${head}. ${capitalise(leave)} makes it ${plural(bridge.days, 'day')}, ${bridge.start} to ${bridge.end}.`
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`
}

/** The whole answer for one lookahead window. */
export function formatUpcoming(occasions: readonly Occasion[], breaks: readonly Break[], withinDays: number): string {
  const sections: string[] = []
  if (occasions.length > 0) {
    sections.push(`Coming up in the next ${withinDays} days:\n${occasions.map(occasionLine).join('\n')}`)
  }
  if (breaks.length > 0) {
    sections.push(`Breaks worth planning around:\n${breaks.map(breakLine).join('\n')}`)
  }
  if (sections.length === 0) {
    return `Nothing notable in the next ${withinDays} days — no holidays, birthdays, or anniversaries.`
  }
  return sections.join('\n\n')
}

/** Register the occasions tool. */
export function apply(ctx: Context, config: Config): void {
  const breakOptions = {
    ...config.workdays !== undefined ? { workdays: config.workdays } : {},
    ...config.maxLeave !== undefined ? { maxLeave: config.maxLeave } : {},
  }

  /**
   * Household occasions, preferring this plugin's config when it sets any.
   *
   * Mirrors how `dsh-chores` treats the chore calendar: the household owns the
   * fact, and the plugin config is an override rather than the primary home.
   */
  function householdEntries() {
    const override = config.occasions
    if (override !== undefined) {
      return Object.entries(override).map(([id, entry]) => ({ id, name: entry.name, date: entry.date }))
    }
    return ctx.household.occasions
  }

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'occasions_upcoming',
        description:
          'What is coming up: holidays, birthdays, anniversaries, and long weekends. Call this for "anything '
          + 'coming up", "when is the next long weekend", "any holidays soon", or before helping plan time off, '
          + 'because it reports how many days a break really is and what one day of leave would add to it.',
        parameters: {
          within_days: {
            type: 'number',
            description: `How far ahead to look. Defaults to ${DEFAULT_WITHIN_DAYS} days.`,
          },
        },
        output: TEXT_OUTPUT,
        presentCall: () => ({ card: 'generic' as const, title: 'Upcoming occasions', kind: 'read' as const }),
        execute: async (args: { within_days?: number }) => {
          const withinDays = args.within_days !== undefined && args.within_days > 0
            ? Math.floor(args.within_days)
            : DEFAULT_WITHIN_DAYS
          const today = ctx.household.today()
          const occasions = upcomingOccasions(today, withinDays, {
            people: ctx.household.list(),
            occasions: householdEntries(),
            holidays: config.federalHolidays !== false,
          })
          const breaks = notableBreaks(today, addDays(today, withinDays), breakOptions)
          return formatUpcoming(occasions, breaks, withinDays)
        },
      }),
    ),
  )
}
