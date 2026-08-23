/**
 * Planning cycles: what the butler should raise today, and what it should let be.
 *
 * A **cycle** is one planning conversation — about a holiday weekend, a birthday,
 * an anniversary, or just the coming weekend. It has a beginning (the butler asks),
 * a middle (the family answers, and the butler may nudge once), and an end (a plan
 * is written, or the date passes).
 *
 * The interesting problem is not scheduling, it is **state**. "Trying to get
 * consensus" spans days, so the butler has to know what it already asked, who has
 * answered, and when to stop — across restarts. All of that lives in Nextcloud as
 * VTODOs, so it survives, and so the family can see and edit it in the Tasks app
 * they already use. Nothing here holds durable state in memory.
 *
 * This module is the pure half: cycle identity, state read back off the VTODOs, and
 * the decision about what to do today. No network, no clock, no side effects — so
 * the awkward cases (a cycle already open, a nudge budget spent, a date gone by)
 * are all reachable in a test.
 *
 * @module dsh-planner/cycles
 */

/** What a cycle is about. */
export type CycleKind = 'weekend' | 'holiday' | 'birthday' | 'anniversary'

/** A cycle's identity, derived rather than stored. */
export interface CycleId {
  /** What kind of occasion this plans for. */
  readonly kind: CycleKind
  /**
   * The VTODO uid.
   *
   * Deterministic, so asking "has this cycle already been opened?" is a lookup
   * rather than a search, and so a duplicate create is refused by the server
   * instead of producing a second copy. That is what makes a catch-up pass after
   * a restart safe to run.
   */
  readonly uid: string
  /** The date being planned for, `YYYY-MM-DD`. */
  readonly targetDate: string
  /** How the butler refers to it, e.g. `the weekend of 2026-08-29`. */
  readonly label: string
  /** Days from the reference date to the target. */
  readonly daysAway: number
}

/** One member's subtask within a cycle. */
export interface CycleSubtask {
  /** Roster key of the member it belongs to. */
  readonly memberKey: string
  /** Whether they have weighed in. */
  readonly done: boolean
}

/** A cycle as it currently stands, read back from Nextcloud. */
export interface CycleState {
  /** The parent VTODO uid. */
  readonly uid: string
  /** Whether the parent has been completed or cancelled. */
  readonly closed: boolean
  /** Roster keys of members who have weighed in. */
  readonly answered: readonly string[]
  /** Roster keys of members who have not. */
  readonly waiting: readonly string[]
  /** How many times the butler has raised this. */
  readonly prompts: number
  /** The date it was last raised, `YYYY-MM-DD`, when it has been. */
  readonly lastPrompt?: string
}

/** Something for the butler to do about one cycle. */
export type CycleAction =
  /** Create the cycle and ask the family. */
  | { readonly action: 'open'; readonly cycle: CycleId; readonly members: readonly string[] }
  /** Ask again, naming who has not replied. */
  | { readonly action: 'nudge'; readonly cycle: CycleId; readonly waiting: readonly string[] }
  /** Everyone has weighed in: turn it into a plan. */
  | { readonly action: 'settle'; readonly cycle: CycleId; readonly answered: readonly string[] }
  /** Stop tracking it. */
  | { readonly action: 'close'; readonly cycle: CycleId; readonly reason: CloseReason }

/** Why a cycle is being closed. */
export type CloseReason =
  /** The date has arrived or gone by. */
  | 'passed'
  /** The nudge budget is spent and not everyone replied. */
  | 'unanswered'

/** How far ahead each kind of occasion is worth raising. */
export interface LeadTimes {
  /** Days before a holiday break. */
  readonly holiday: number
  /** Days before a birthday. */
  readonly birthday: number
  /** Days before an anniversary. */
  readonly anniversary: number
}

/**
 * Lead times that differ by occasion, because one number is wrong at both ends.
 *
 * A weekend raised three weeks out is noise; a holiday raised on the Thursday
 * before is useless because the flights have gone.
 */
export const DEFAULT_LEAD_TIMES: LeadTimes = {
  // Long enough to still book travel and accommodation.
  holiday: 24,
  // Presents, a party, invitations.
  birthday: 18,
  // Reservations, and possibly leave.
  anniversary: 24,
}

/**
 * Times the butler will raise one cycle before going quiet.
 *
 * One. A butler that asks about the weekend every day gets the channel muted, and
 * then the family loses the morning briefing too. Asking twice and then waiting to
 * be asked is the polite failure; asking five times is not.
 */
export const DEFAULT_MAX_NUDGES = 1

/** Days to leave between raising the same cycle again. */
export const DEFAULT_NUDGE_GAP_DAYS = 3

/** The prefix every cycle uid carries, so the butler's own tasks are recognisable. */
export const UID_PREFIX = 'butler'

/** An occasion as `dsh-occasions` reports it. Structural, so no import is needed. */
export interface PlannableOccasion {
  /** `holiday`, `birthday`, or `anniversary`. */
  readonly kind: string
  /** Stable id, e.g. `holiday:thanksgiving`. */
  readonly id: string
  /** Name as the butler says it. */
  readonly name: string
  /** The date it falls on, `YYYY-MM-DD`. */
  readonly date: string
  /** Whole days from today. */
  readonly daysAway: number
}

/**
 * The uid for a cycle.
 *
 * Built from the kind and the target date rather than from a counter or a
 * timestamp, so the same cycle computed on Tuesday and again on Wednesday is the
 * same cycle. Occasion cycles also carry the occasion's own id, so two birthdays
 * in one week do not collide.
 * @param kind - what the cycle is about.
 * @param targetDate - the date being planned for, `YYYY-MM-DD`.
 * @param occasionId - the occasion's id, for anything but a weekend.
 * @returns the uid.
 */
export function cycleUid(kind: CycleKind, targetDate: string, occasionId?: string): string {
  const slug = occasionId === undefined ? kind : occasionId.replace(':', '-')
  return `${UID_PREFIX}-${slug}-${targetDate}`
}

/** The uid of one member's subtask within a cycle. */
export function subtaskUid(parentUid: string, memberKey: string): string {
  return `${parentUid}-${memberKey}`
}

/** Turn an occasion into a cycle identity. */
export function occasionCycle(occasion: PlannableOccasion): CycleId | undefined {
  const kind = occasion.kind
  if (kind !== 'holiday' && kind !== 'birthday' && kind !== 'anniversary') return undefined
  return {
    kind,
    uid: cycleUid(kind, occasion.date, occasion.id),
    targetDate: occasion.date,
    label: occasion.name,
    daysAway: occasion.daysAway,
  }
}

/** Turn an upcoming weekend into a cycle identity. */
export function weekendCycle(startDate: string, daysAway: number): CycleId {
  return {
    kind: 'weekend',
    uid: cycleUid('weekend', startDate),
    targetDate: startDate,
    label: `the weekend of ${startDate}`,
    daysAway,
  }
}

/** Settings that shape what gets raised and how insistently. */
export interface PlanningPolicy {
  /** How far ahead each kind is raised. */
  readonly leadTimes?: Partial<LeadTimes>
  /** Times one cycle is raised before the butler goes quiet. */
  readonly maxNudges?: number
  /** Days to leave between raising the same cycle again. */
  readonly nudgeGapDays?: number
}

function leadTimeFor(kind: CycleKind, policy: PlanningPolicy): number {
  const times = { ...DEFAULT_LEAD_TIMES, ...policy.leadTimes }
  if (kind === 'holiday') return times.holiday
  if (kind === 'birthday') return times.birthday
  if (kind === 'anniversary') return times.anniversary
  // A weekend is raised by the weekday it is planned on, not by a lead time.
  return Number.POSITIVE_INFINITY
}

/** Everything a decision pass needs to know. */
export interface PlanningInput {
  /** Today, in the family's zone, `YYYY-MM-DD`. */
  readonly today: string
  /** Cycles that could be raised, from occasions and the coming weekend. */
  readonly candidates: readonly CycleId[]
  /** Cycles that already exist, keyed by uid. */
  readonly existing: ReadonlyMap<string, CycleState>
  /** Roster keys of everyone who gets a say. */
  readonly members: readonly string[]
  /** How insistent to be. */
  readonly policy?: PlanningPolicy
}

/**
 * What the butler should do today.
 *
 * One pass over the candidate cycles, deciding for each whether to open it, ask
 * again, settle it, close it, or leave it alone. Returning actions rather than
 * performing them is what makes every branch testable without a CalDAV server or
 * a Discord connection.
 *
 * A cycle already closed is never reopened, which matters because the deterministic
 * uid means a closed cycle stays findable: without this the butler would raise
 * Thanksgiving again the day after settling it.
 * @param input - today, the candidates, and what already exists.
 * @returns the actions to take, in candidate order.
 */
export function decide(input: PlanningInput): CycleAction[] {
  const policy = input.policy ?? {}
  const maxNudges = policy.maxNudges ?? DEFAULT_MAX_NUDGES
  const gap = policy.nudgeGapDays ?? DEFAULT_NUDGE_GAP_DAYS
  const actions: CycleAction[] = []

  for (const cycle of input.candidates) {
    const state = input.existing.get(cycle.uid)

    if (state === undefined) {
      // Not raised yet. Only open it once it is close enough to be worth raising,
      // and never once the date has gone by.
      if (cycle.daysAway < 0) continue
      if (cycle.daysAway > leadTimeFor(cycle.kind, policy)) continue
      actions.push({ action: 'open', cycle, members: input.members })
      continue
    }

    // A settled or abandoned cycle stays settled. The uid is stable, so it will
    // keep turning up as a candidate until the date passes.
    if (state.closed) continue

    if (cycle.daysAway < 0) {
      actions.push({ action: 'close', cycle, reason: 'passed' })
      continue
    }

    if (state.waiting.length === 0) {
      actions.push({ action: 'settle', cycle, answered: state.answered })
      continue
    }

    // Somebody still owes an answer. Ask again only if there is budget, enough
    // time has passed, and the date has not nearly arrived.
    if (state.prompts > maxNudges) {
      actions.push({ action: 'close', cycle, reason: 'unanswered' })
      continue
    }
    if (state.lastPrompt !== undefined && daysBetween(state.lastPrompt, input.today) < gap) continue
    actions.push({ action: 'nudge', cycle, waiting: state.waiting })
  }

  return actions
}

/** Days either side of an occasion within which a plain weekend is redundant. */
export const WEEKEND_SUPPRESSION_DAYS = 3

/**
 * Drop a weekend cycle when an occasion already covers that weekend.
 *
 * Without this the butler opens two conversations about Thanksgiving week: one
 * about Thanksgiving, and one about "the weekend of the 28th" — which is the same
 * weekend, with the same people, about the same plans. One occasion should produce
 * one conversation, the same principle that keeps `notableBreaks` from reporting a
 * holiday twice.
 *
 * Occasion cycles win because they carry the reason the weekend is interesting in
 * the first place.
 * @param candidates - every cycle that could be raised.
 * @param windowDays - how close an occasion has to be to absorb the weekend.
 * @returns the candidates with redundant weekend cycles removed.
 */
export function withoutRedundantWeekend(
  candidates: readonly CycleId[],
  windowDays: number = WEEKEND_SUPPRESSION_DAYS,
): CycleId[] {
  const occasions = candidates.filter(candidate => candidate.kind !== 'weekend')
  return candidates.filter((candidate) => {
    if (candidate.kind !== 'weekend') return true
    return !occasions.some(occasion =>
      Math.abs(daysBetween(candidate.targetDate, occasion.targetDate)) <= windowDays)
  })
}

/** Whole days from one calendar date to another. */
export function daysBetween(fromIso: string, toIso: string): number {
  const parse = (value: string): number => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
    if (match === null) throw new RangeError(`expected YYYY-MM-DD, received ${JSON.stringify(value)}`)
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }
  return Math.round((parse(toIso) - parse(fromIso)) / 86_400_000)
}
