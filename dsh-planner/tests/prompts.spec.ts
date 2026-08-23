/**
 * The instructions the butler is given, and the VTODO bookkeeping behind them.
 *
 * The prompts are tested as instructions rather than as strings: what matters is
 * that each one tells the butler to write agreed plans down, and not to invent
 * anyone's preferences. Both are failure modes with no exception — a planning
 * conversation that ends in agreement and no calendar entry has wasted everyone's
 * time, and a butler that fills in what Sam "probably wants" is worse than one that
 * asks.
 */

import { describe, expect, it } from 'vitest'
import { nudgePrompt, openPrompt, settlePrompt } from '../src/prompts.ts'
import { isAnswered, parentSummary, subtaskSummary } from '../src/store.ts'
import { weekendCycle } from '../src/cycles.ts'
import type { CycleId } from '../src/cycles.ts'

const THANKSGIVING: CycleId = {
  kind: 'holiday',
  uid: 'butler-holiday-thanksgiving-2026-11-26',
  targetDate: '2026-11-26',
  label: 'Thanksgiving',
  daysAway: 21,
}

describe('openPrompt', () => {
  it('names the occasion and how far off it is', () => {
    const text = openPrompt(THANKSGIVING)
    expect(text).toContain('Thanksgiving')
    expect(text).toContain('2026-11-26')
    expect(text).toContain('3 weeks')
  })

  it('asks the butler to gather what people want before proposing', () => {
    expect(openPrompt(THANKSGIVING)).toMatch(/ask what each of them would like/i)
  })

  it('phrases a weekend as planning rather than as an approaching date', () => {
    const text = openPrompt(weekendCycle('2026-08-29', 7))
    expect(text).toContain('the weekend of 2026-08-29')
    expect(text).toMatch(/time to plan/i)
  })

  it('includes the detail it is given', () => {
    expect(openPrompt(THANKSGIVING, 'That is 1 day off. Taking 2026-11-27 off would make it 4 days.'))
      .toContain('would make it 4 days')
  })

  it('reads cleanly when there is no detail', () => {
    expect(openPrompt(THANKSGIVING, '')).not.toContain('  ')
    expect(openPrompt(THANKSGIVING, undefined)).not.toContain('undefined')
  })

  it('says tomorrow rather than counting to one', () => {
    expect(openPrompt({ ...THANKSGIVING, daysAway: 1 })).toContain('tomorrow')
  })

  it('says today rather than in 0 days', () => {
    expect(openPrompt({ ...THANKSGIVING, daysAway: 0 })).toContain('today')
  })
})

describe('nudgePrompt', () => {
  it('names the one person who has not replied', () => {
    expect(nudgePrompt(THANKSGIVING, ['Sam'])).toContain('Sam has not said anything yet')
  })

  it('lists two people readably', () => {
    expect(nudgePrompt(THANKSGIVING, ['Sam', 'Kit'])).toContain('Sam and Kit')
  })

  it('lists three people readably', () => {
    expect(nudgePrompt(THANKSGIVING, ['Alex', 'Sam', 'Kit'])).toContain('Alex, Sam and Kit')
  })

  it('copes with being given nobody', () => {
    expect(nudgePrompt(THANKSGIVING, [])).toContain('anyone who has not')
  })

  // The nudge has to be the last one, and say so, or the family cannot tell
  // whether ignoring it will make it stop.
  it('tells the butler this is the last ask', () => {
    expect(nudgePrompt(THANKSGIVING, ['Sam'])).toMatch(/leave it with them/i)
  })

  it('tells the butler not to repeat itself', () => {
    expect(nudgePrompt(THANKSGIVING, ['Sam'])).toMatch(/not repeat/i)
  })
})

describe('settlePrompt', () => {
  it('lists who weighed in', () => {
    expect(settlePrompt(THANKSGIVING, ['Alex', 'Sam'])).toContain('Alex, Sam')
  })

  // "Everyone answered" is checkable; "everyone agreed" is not. So the butler
  // proposes and asks, rather than declaring consensus it cannot detect.
  it('asks for one proposal and a confirmation, not a declaration of agreement', () => {
    const text = settlePrompt(THANKSGIVING, ['Alex', 'Sam'])
    expect(text).toMatch(/propose one plan/i)
    expect(text).toMatch(/ask them to confirm/i)
  })

  it('tells the butler to say where it had to choose', () => {
    expect(settlePrompt(THANKSGIVING, ['Alex'])).toMatch(/where you had to choose/i)
  })

  it('copes with an empty list of names', () => {
    expect(settlePrompt(THANKSGIVING, [])).toContain('the family')
  })
})

describe('every prompt', () => {
  const all = [
    openPrompt(THANKSGIVING),
    nudgePrompt(THANKSGIVING, ['Sam']),
    settlePrompt(THANKSGIVING, ['Alex', 'Sam']),
  ]

  // A cycle that reaches agreement and leaves nothing on the calendar has wasted
  // the family's time, so every instruction has to close that loop.
  it('tells the butler to write an agreed plan to the calendar', () => {
    for (const text of all) expect(text).toContain('calendar_add_event')
  })

  it('forbids inventing anyone’s preferences', () => {
    for (const text of all) expect(text).toMatch(/do not invent/i)
  })

  it('names the occasion', () => {
    for (const text of all) expect(text).toContain('Thanksgiving')
  })
})

describe('task titles', () => {
  it('titles the parent as the plan', () => {
    expect(parentSummary('Thanksgiving')).toBe('Plan Thanksgiving')
  })

  // The subtask is what a family member sees on their phone, so it has to read as
  // a question addressed to them rather than as bookkeeping.
  it('titles a subtask as a question to that person', () => {
    expect(subtaskSummary('Kit', 'Thanksgiving')).toBe('Kit: what would you like to do for Thanksgiving?')
  })
})

describe('isAnswered', () => {
  it('counts a completed task', () => {
    expect(isAnswered({ status: 'COMPLETED', percentComplete: 0 })).toBe(true)
  })

  // Somebody who deliberately cancels their subtask has answered: they are saying
  // they have no preference, which is a real answer and must not block the cycle.
  it('counts a cancelled task, because declining to answer is an answer', () => {
    expect(isAnswered({ status: 'CANCELLED', percentComplete: 0 })).toBe(true)
  })

  it('counts a completion timestamp even without a status', () => {
    expect(isAnswered({ completed: '2026-08-20T10:00:00Z', percentComplete: 0 })).toBe(true)
  })

  // The Tasks app can leave a task at 100% without setting STATUS.
  it('counts a task dragged to a hundred percent', () => {
    expect(isAnswered({ percentComplete: 100 })).toBe(true)
  })

  it('does not count an untouched task', () => {
    expect(isAnswered({ status: 'NEEDS-ACTION', percentComplete: 0 })).toBe(false)
  })

  it('does not count a task somebody has merely started', () => {
    expect(isAnswered({ status: 'IN-PROCESS', percentComplete: 50 })).toBe(false)
  })
})
