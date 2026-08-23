/**
 * What the butler is told to say when it starts or continues a planning cycle.
 *
 * These are **instructions to the butler**, not messages to the family. The butler
 * reads them in its own voice, with its own tools, and decides what is actually
 * worth saying — which is the reason planning runs the agent instead of composing
 * text in code the way the morning briefing does. A briefing reports facts; this
 * starts a conversation and has to read the room.
 *
 * Two things every instruction carries, because both are failure modes otherwise:
 * the butler is told **not to invent** anyone's preferences, and told to write
 * agreed plans to the calendar with the tools it already has. A planning
 * conversation that ends in agreement and no calendar entry has wasted everybody's
 * time.
 *
 * @module dsh-planner/prompts
 */

import type { CycleId } from './cycles.ts'

/** How the butler should describe a cycle's occasion in conversation. */
function occasionPhrase(cycle: CycleId): string {
  if (cycle.kind === 'weekend') return cycle.label
  if (cycle.kind === 'birthday') return `${cycle.label} on ${cycle.targetDate}`
  return `${cycle.label} on ${cycle.targetDate}`
}

/** How far off it is, in words the butler can reuse. */
function distancePhrase(daysAway: number): string {
  if (daysAway === 0) return 'today'
  if (daysAway === 1) return 'tomorrow'
  if (daysAway < 14) return `in ${daysAway} days`
  return `in about ${Math.round(daysAway / 7)} weeks`
}

/** Shared closing rules appended to every planning instruction. */
const GROUND_RULES = [
  'Do not invent anyone\'s preferences or availability — ask, and wait for real answers.',
  'Keep it to a short message; this is a family chat, not a briefing.',
  'When something is actually agreed, put it on the shared calendar with calendar_add_event,',
  'and add any preparation the family needs to do as chores with chores_add.',
].join(' ')

/**
 * Open a cycle: raise the occasion and ask what the family wants.
 * @param cycle - the cycle being opened.
 * @param extra - anything the caller knows that the butler should mention, such as
 *   how long the break is and what a day of leave would add to it.
 * @returns the instruction text.
 */
export function openPrompt(cycle: CycleId, extra?: string): string {
  const lead = cycle.kind === 'weekend'
    ? `It is time to plan ${occasionPhrase(cycle)}.`
    : `${occasionPhrase(cycle)} is coming up ${distancePhrase(cycle.daysAway)}.`
  const detail = extra === undefined || extra.trim() === '' ? '' : ` ${extra.trim()}`
  return [
    `${lead}${detail}`,
    'Raise it with the family and ask what each of them would like to do.',
    'Your aim is to get to something everyone is happy with, so gather what people want before proposing anything.',
    GROUND_RULES,
  ].join(' ')
}

/**
 * Ask again, naming who has not replied.
 *
 * The instruction says once, gently, and explains that this is the last ask —
 * because a butler that keeps asking gets muted, and a muted channel loses the
 * morning briefing too.
 * @param cycle - the cycle being chased.
 * @param waiting - display names of the members who have not weighed in.
 * @returns the instruction text.
 */
export function nudgePrompt(cycle: CycleId, waiting: readonly string[]): string {
  const who = waiting.length === 0
    ? 'anyone who has not'
    : waiting.length === 1
      ? waiting[0]!
      : `${waiting.slice(0, -1).join(', ')} and ${waiting[waiting.length - 1]!}`
  return [
    `You asked the family about ${occasionPhrase(cycle)} and ${who} has not said anything yet.`,
    `It is ${distancePhrase(cycle.daysAway)}.`,
    'Ask once more, lightly, and make clear you will leave it with them after this.',
    'Do not repeat everything you said the first time.',
    GROUND_RULES,
  ].join(' ')
}

/**
 * Everyone has weighed in: turn the answers into a plan.
 *
 * This is the step that makes the whole cycle worth running, and it is where the
 * butler stops gathering and starts proposing. It asks for a plan and a single
 * confirmation rather than trying to detect agreement — "everyone answered" is
 * checkable, "everyone agreed" is not.
 * @param cycle - the cycle being settled.
 * @param answered - display names of everyone who replied.
 * @returns the instruction text.
 */
export function settlePrompt(cycle: CycleId, answered: readonly string[]): string {
  const who = answered.length === 0 ? 'the family' : answered.join(', ')
  return [
    `Everyone has now weighed in on ${occasionPhrase(cycle)} (${who}).`,
    'Read back through what each of them asked for, then propose one plan that gives as many people what they wanted as you can.',
    'Say plainly where you had to choose between two things, and ask them to confirm.',
    'Once anyone confirms, write it to the shared calendar with calendar_add_event and add any preparation as chores.',
    'Do not invent preferences nobody stated.',
  ].join(' ')
}

/**
 * Say nothing further about a cycle that ran out of time.
 *
 * There is deliberately no prompt for closing. A cycle that nobody answered should
 * end in silence, not in the butler announcing that it is giving up — that is a
 * reproach, and the family did nothing wrong by being busy. Closing is a
 * bookkeeping change to the VTODO, visible in the Tasks app if anyone looks.
 */
export const CLOSE_IS_SILENT = true
