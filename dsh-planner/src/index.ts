/**
 * dsh-planner — the half of the butler that speaks first.
 *
 * Everything else in this project waits to be asked. This notices that a holiday,
 * a birthday, an anniversary, or just the coming weekend is close enough to be
 * worth talking about, opens a conversation in the family room, and keeps track of
 * who has weighed in until there is a plan on the calendar.
 *
 * Three decisions shape the whole package.
 *
 * **Consensus is state, and it lives in Nextcloud.** A planning conversation spans
 * days, so the butler has to remember what it asked and who replied — across
 * restarts. A cycle is therefore a parent VTODO with one `RELATED-TO` subtask per
 * family member, which means "who has not weighed in" is just subtask completion.
 * It survives a restart, the family can see it in the Tasks app, and they can tick
 * their own subtask off there instead of in chat. Nothing durable is held in memory.
 *
 * **Cycle uids are deterministic.** `butler-holiday-thanksgiving-2026-11-26` is the
 * same string however many times it is computed, so a duplicate create is refused
 * by CalDAV's `If-None-Match` and surfaces as the existing `conflict` error. That is
 * what makes a catch-up pass after a restart safe rather than something that posts
 * twice.
 *
 * **Planning runs the agent; the briefing does not.** The morning digest reports
 * facts, so it is composed in code — it costs nothing and cannot hallucinate an
 * appointment. Planning *starts a conversation*, which is judgement, so it goes
 * through `ctx.discord.prompt` into the room's own session. The butler then writes
 * agreed plans with the same `calendar_add_event` the family's own requests use.
 * This package owns no write tools of its own: it decides what to raise, and the
 * butler does the rest.
 *
 * @module dsh-planner
 */

import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { nextRun, parseTimeOfDay } from 'dsh-household'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'
// Type-only: carries the `ctx.caldav` Context declaration.
import type {} from 'dsh-caldav'
// Type-only: carries the `ctx.discord` Context declaration.
import type {} from 'dsh-channel-discord'
import { notableBreaks, upcomingOccasions } from 'dsh-occasions'
import { decide, occasionCycle, weekendCycle, withoutRedundantWeekend } from './cycles.ts'
import type { CycleAction, CycleId, CycleState } from './cycles.ts'
import { nudgePrompt, openPrompt, settlePrompt } from './prompts.ts'
import { CalDavCycleStore } from './store.ts'
import type { CycleStore } from './store.ts'

export {
  cycleUid,
  DEFAULT_LEAD_TIMES,
  DEFAULT_MAX_NUDGES,
  DEFAULT_NUDGE_GAP_DAYS,
  daysBetween,
  decide,
  occasionCycle,
  subtaskUid,
  UID_PREFIX,
  weekendCycle,
  WEEKEND_SUPPRESSION_DAYS,
  withoutRedundantWeekend,
} from './cycles.ts'
export type {
  CloseReason,
  CycleAction,
  CycleId,
  CycleKind,
  CycleState,
  CycleSubtask,
  LeadTimes,
  PlannableOccasion,
  PlanningInput,
  PlanningPolicy,
} from './cycles.ts'
export { nudgePrompt, openPrompt, settlePrompt } from './prompts.ts'
export {
  CalDavCycleStore,
  isAnswered,
  LAST_PROMPT_PROPERTY,
  MEMBER_PROPERTY,
  parentSummary,
  PROMPTS_PROPERTY,
  subtaskSummary,
} from './store.ts'
export type { CycleStore, CycleStoreOptions } from './store.ts'

/** When the planning pass runs, in the family's local time. */
export const DEFAULT_TIME = '09:00'

/** Thursday — the day a Monday-to-Friday couple can still shape the weekend. */
export const DEFAULT_PLANNING_WEEKDAY = 4

/** How far ahead to look for occasions worth raising. */
export const LOOKAHEAD_DAYS = 60

/** Configuration. */
export interface Config {
  /** Discord channel the butler plans in. Required: there is no sensible default room. */
  channelId: string
  /** Local time of day the planning pass runs, `HH:MM`. */
  time?: string
  /** Weekday the coming weekend is planned on, 0 Sunday through 6 Saturday. */
  planningWeekday?: number
  /** Calendar collection the cycle VTODOs live in. Defaults to the household chore list. */
  calendar?: string
  /** CalDAV server name, when not the default. */
  server?: string
  /** Weekdays the adults work, for deciding what counts as a break. */
  workdays?: number[]
  /** Days before a holiday break to raise it. */
  holidayLeadDays?: number
  /** Days before a birthday to raise it. */
  birthdayLeadDays?: number
  /** Days before an anniversary to raise it. */
  anniversaryLeadDays?: number
  /** Times one cycle is raised before the butler goes quiet. Defaults to 1. */
  maxNudges?: number
  /** Days to leave between raising the same cycle again. */
  nudgeGapDays?: number
  /** Plan the coming weekend at all. Defaults to true. */
  planWeekends?: boolean
}

export const Config: z<Config> = z.object({
  channelId: z.string().required(),
  time: z.string().default(DEFAULT_TIME),
  planningWeekday: z.number().default(DEFAULT_PLANNING_WEEKDAY),
  calendar: z.string(),
  server: z.string(),
  workdays: z.array(z.number()).default([1, 2, 3, 4, 5]),
  holidayLeadDays: z.number().default(24),
  birthdayLeadDays: z.number().default(18),
  anniversaryLeadDays: z.number().default(24),
  maxNudges: z.number().default(1),
  nudgeGapDays: z.number().default(3),
  planWeekends: z.boolean().default(true),
})

/**
 * The proactive planner.
 *
 * A service rather than a function plugin because it owns a timer and needs to be
 * torn down cleanly, and because a future tool ("what are we planning at the
 * moment?") will want to reach the same cycle state.
 */
export class Planner extends Service {
  static inject = ['caldav', 'household', 'discord']
  static Config = Config

  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly config: Config
  private stopped = false

  constructor(ctx: Context, config: Config) {
    super(ctx, 'planner')
    this.config = config
    parseTimeOfDay(config.time ?? DEFAULT_TIME)
  }

  /** Arm the daily pass. */
  protected async start(): Promise<void> {
    this.arm()
  }

  /** Stop the timer; a pending pass must not hold the process open. */
  protected async stop(): Promise<void> {
    this.stopped = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = undefined
  }

  /**
   * Schedule the next pass.
   *
   * Re-armed **before** the pass runs, not after, so a failed morning does not end
   * the series. A planner that stops planning after one CalDAV hiccup is worse than
   * one that never started, because nobody notices the absence.
   */
  private arm(): void {
    if (this.stopped) return
    const at = parseTimeOfDay(this.config.time ?? DEFAULT_TIME)
    const due = nextRun(this.ctx.household, at, new Date())
    const delay = Math.max(0, due.getTime() - Date.now())
    this.timer = setTimeout(() => {
      this.arm()
      void this.pass().catch(() => undefined)
    }, delay)
    this.timer.unref?.()
  }

  /**
   * One planning pass: work out what is worth raising, then raise it.
   *
   * Public so an operator or a test can run a pass without waiting for the timer.
   * @returns the actions taken.
   */
  async pass(): Promise<CycleAction[]> {
    const store = this.store()
    if (store === undefined) return []
    const today = this.ctx.household.today()
    const candidates = this.candidates(today)
    const existing = await this.readCycles(store, candidates)
    const actions = decide({
      today,
      candidates,
      existing,
      members: this.ctx.household.list().map(member => member.key),
      policy: {
        leadTimes: {
          holiday: this.config.holidayLeadDays ?? 24,
          birthday: this.config.birthdayLeadDays ?? 18,
          anniversary: this.config.anniversaryLeadDays ?? 24,
        },
        maxNudges: this.config.maxNudges ?? 1,
        nudgeGapDays: this.config.nudgeGapDays ?? 3,
      },
    })
    for (const action of actions) {
      if (this.stopped) break
      await this.perform(store, action, today).catch(() => undefined)
    }
    return actions
  }

  /** Every cycle that could be raised today, weekend duplicates removed. */
  private candidates(today: string): CycleId[] {
    const occasions = upcomingOccasions(today, LOOKAHEAD_DAYS, {
      people: this.ctx.household.list(),
      occasions: this.ctx.household.occasions,
      holidays: true,
    })
    const found: CycleId[] = []
    for (const occasion of occasions) {
      const cycle = occasionCycle(occasion)
      if (cycle !== undefined) found.push(cycle)
    }
    if (this.config.planWeekends !== false && this.isPlanningDay(today)) {
      const weekend = this.nextWeekend(today)
      if (weekend !== undefined) found.push(weekend)
    }
    return withoutRedundantWeekend(found)
  }

  /** Whether today is the weekday the coming weekend gets planned on. */
  private isPlanningDay(today: string): boolean {
    const target = this.config.planningWeekday ?? DEFAULT_PLANNING_WEEKDAY
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today)
    if (match === null) return false
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay() === target
  }

  /** The next run of days off, as a cycle. */
  private nextWeekend(today: string): CycleId | undefined {
    const workdays = this.config.workdays ?? [1, 2, 3, 4, 5]
    const breaks = notableBreaks(today, addDays(today, 10), { workdays })
    // notableBreaks only reports holidays and unusually long runs, so fall back to
    // the plain weekend: an ordinary Saturday is exactly what wants planning here.
    const start = breaks[0]?.start ?? nextDayOff(today, workdays)
    if (start === undefined) return undefined
    return weekendCycle(start, daysApart(today, start))
  }

  /**
   * The store, or `undefined` when no collection is configured.
   *
   * Built per pass rather than in the constructor because the household's chore
   * list is configuration that can change under a reload, and because a planner
   * with nowhere to write should stay dormant rather than fail at startup.
   */
  private store(): CycleStore | undefined {
    const calendar = this.config.calendar ?? this.ctx.household.choresCalendar
    if (calendar === undefined) return undefined
    const server = this.config.server
    return new CalDavCycleStore(this.ctx, {
      calendar,
      ...server !== undefined ? { server } : {},
      displayName: key => this.ctx.household.member(key)?.displayName ?? key,
    })
  }

  /** Read the current state of each candidate cycle from Nextcloud. */
  private async readCycles(
    store: CycleStore,
    candidates: readonly CycleId[],
  ): Promise<Map<string, CycleState>> {
    const found = new Map<string, CycleState>()
    for (const cycle of candidates) {
      const state = await store.readCycle(cycle).catch(() => undefined)
      if (state !== undefined) found.set(cycle.uid, state)
    }
    return found
  }

  /** Perform one decided action. */
  private async perform(store: CycleStore, action: CycleAction, today: string): Promise<void> {
    if (action.action === 'open') return await this.open(store, action.cycle, action.members, today)
    if (action.action === 'nudge') return await this.nudge(store, action.cycle, action.waiting, today)
    if (action.action === 'settle') return await this.settle(store, action.cycle, action.answered)
    return await store.closeCycle(action.cycle)
  }

  /** Display names for a list of roster keys, falling back to the key itself. */
  private names(keys: readonly string[]): string[] {
    return keys.map(key => this.ctx.household.member(key)?.displayName ?? key)
  }

  /**
   * Open a cycle: record it, then ask.
   *
   * Written before spoken, deliberately. If the prompt fails the cycle still
   * exists, so the next pass sees it as open and nudges instead of asking again
   * from scratch. The other order would post a question with nothing tracking it.
   */
  private async open(
    store: CycleStore,
    cycle: CycleId,
    members: readonly string[],
    today: string,
  ): Promise<void> {
    await store.openCycle(cycle, members, today)
    await this.ctx.discord.prompt(this.config.channelId, openPrompt(cycle, this.detail(cycle)))
  }

  private async nudge(
    store: CycleStore,
    cycle: CycleId,
    waiting: readonly string[],
    today: string,
  ): Promise<void> {
    await store.recordPrompt(cycle, today)
    await this.ctx.discord.prompt(this.config.channelId, nudgePrompt(cycle, this.names(waiting)))
  }

  /**
   * Settle a cycle: propose a plan, then close it.
   *
   * Spoken before closed, the opposite of opening, because a closed cycle is never
   * reopened — closing first and then failing to speak would lose the conversation
   * entirely.
   */
  private async settle(store: CycleStore, cycle: CycleId, answered: readonly string[]): Promise<void> {
    await this.ctx.discord.prompt(this.config.channelId, settlePrompt(cycle, this.names(answered)))
    await store.closeCycle(cycle)
  }

  /** Extra colour for an opening prompt: how long the break is, and what leave adds. */
  private detail(cycle: CycleId): string | undefined {
    if (cycle.kind === 'birthday' || cycle.kind === 'anniversary') return undefined
    const workdays = this.config.workdays ?? [1, 2, 3, 4, 5]
    const breaks = notableBreaks(cycle.targetDate, cycle.targetDate, { workdays })
    const entry = breaks[0]
    if (entry === undefined) return undefined
    const bridge = entry.options.find(option => option.bonus > 0)
    const base = `That is ${entry.days} day${entry.days === 1 ? '' : 's'} off, ${entry.start} to ${entry.end}.`
    if (bridge === undefined) return base
    return `${base} Taking ${bridge.leave.join(', ')} off would make it ${bridge.days} days.`
  }

}

/** Shift a calendar date by whole days. */
function addDays(dateIso: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateIso)
  if (match === null) throw new RangeError(`expected YYYY-MM-DD, received ${JSON.stringify(dateIso)}`)
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days))
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`
}

/** Whole days between two calendar dates. */
function daysApart(fromIso: string, toIso: string): number {
  const parse = (value: string): number => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (match === null) throw new RangeError(`expected YYYY-MM-DD, received ${JSON.stringify(value)}`)
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  return Math.round((parse(toIso) - parse(fromIso)) / 86_400_000)
}

/** The next day nobody works, searching forward. */
function nextDayOff(today: string, workdays: readonly number[], within = 10): string | undefined {
  const working = new Set(workdays)
  for (let offset = 1; offset <= within; offset += 1) {
    const candidate = addDays(today, offset)
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(candidate)!
    const weekday = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).getUTCDay()
    if (!working.has(weekday)) return candidate
  }
  return undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    planner: Planner
  }
}

export default Planner
