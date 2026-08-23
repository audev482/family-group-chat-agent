/**
 * The planning decision: what the butler raises today, and what it lets be.
 *
 * `decide` is pure, so every awkward case is reachable here — a cycle already open,
 * a nudge budget spent, a date gone by, a cycle settled yesterday. Those are the
 * cases that matter, because getting them wrong means either a butler that asks the
 * same question every morning or one that asks once and forgets.
 *
 * Dates are pinned throughout. Nothing reads the clock.
 */

import { describe, expect, it } from 'vitest'
import {
  cycleUid,
  daysBetween,
  DEFAULT_MAX_NUDGES,
  decide,
  occasionCycle,
  subtaskUid,
  weekendCycle,
  withoutRedundantWeekend,
} from '../src/cycles.ts'
import type { CycleId, CycleState, PlanningInput } from '../src/cycles.ts'

const TODAY = '2026-08-22'
const MEMBERS = ['alex', 'sam', 'kit']

/** A holiday cycle a given distance away. */
function holiday(daysAway: number, date = '2026-11-26'): CycleId {
  return { kind: 'holiday', uid: cycleUid('holiday', date, 'holiday:thanksgiving'), targetDate: date, label: 'Thanksgiving', daysAway }
}

/** Cycle state with only the fields under test filled in. */
function state(overrides: Partial<CycleState> = {}): CycleState {
  return { uid: holiday(20).uid, closed: false, answered: [], waiting: [...MEMBERS], prompts: 1, ...overrides }
}

/** Build a decision input with sensible defaults. */
function input(overrides: Partial<PlanningInput> = {}): PlanningInput {
  return { today: TODAY, candidates: [], existing: new Map(), members: MEMBERS, ...overrides }
}

describe('cycleUid', () => {
  // The uid is what makes a catch-up pass safe: the same cycle computed twice must
  // be the same string, so the server refuses the duplicate.
  it('is stable for the same cycle', () => {
    expect(cycleUid('holiday', '2026-11-26', 'holiday:thanksgiving'))
      .toBe(cycleUid('holiday', '2026-11-26', 'holiday:thanksgiving'))
  })

  it('distinguishes two occasions on the same date', () => {
    expect(cycleUid('birthday', '2026-08-30', 'birthday:kit'))
      .not.toBe(cycleUid('birthday', '2026-08-30', 'birthday:sam'))
  })

  it('distinguishes the same occasion in different years', () => {
    expect(cycleUid('holiday', '2026-11-26', 'holiday:thanksgiving'))
      .not.toBe(cycleUid('holiday', '2027-11-25', 'holiday:thanksgiving'))
  })

  it('is recognisable as the butler’s own', () => {
    expect(cycleUid('weekend', '2026-08-29').startsWith('butler-')).toBe(true)
  })

  it('carries no colon, which would be awkward in a uid', () => {
    expect(cycleUid('holiday', '2026-11-26', 'holiday:thanksgiving')).not.toContain(':')
  })
})

describe('subtaskUid', () => {
  it('is derived from the parent and the member', () => {
    expect(subtaskUid('butler-weekend-2026-08-29', 'kit')).toBe('butler-weekend-2026-08-29-kit')
  })

  it('differs per member', () => {
    const parent = 'butler-weekend-2026-08-29'
    expect(subtaskUid(parent, 'kit')).not.toBe(subtaskUid(parent, 'sam'))
  })
})

describe('occasionCycle', () => {
  it('turns a holiday into a cycle', () => {
    const cycle = occasionCycle({ kind: 'holiday', id: 'holiday:thanksgiving', name: 'Thanksgiving', date: '2026-11-26', daysAway: 96 })
    expect(cycle?.kind).toBe('holiday')
    expect(cycle?.targetDate).toBe('2026-11-26')
    expect(cycle?.daysAway).toBe(96)
  })

  it('turns a birthday into a cycle', () => {
    expect(occasionCycle({ kind: 'birthday', id: 'birthday:kit', name: "Kit's birthday", date: '2026-08-30', daysAway: 8 })?.kind)
      .toBe('birthday')
  })

  it('ignores an occasion kind it does not plan for', () => {
    expect(occasionCycle({ kind: 'something-else', id: 'x:y', name: 'X', date: '2026-09-01', daysAway: 10 }))
      .toBeUndefined()
  })
})

describe('withoutRedundantWeekend', () => {
  // Otherwise the butler opens two conversations about Thanksgiving week: one about
  // Thanksgiving, one about "the weekend of the 28th". Same weekend, same people.
  it('drops a weekend that an occasion already covers', () => {
    const candidates = [holiday(96, '2026-11-26'), weekendCycle('2026-11-28', 98)]
    expect(withoutRedundantWeekend(candidates).map(entry => entry.kind)).toEqual(['holiday'])
  })

  it('keeps a weekend that stands on its own', () => {
    const candidates = [holiday(96, '2026-11-26'), weekendCycle('2026-08-29', 7)]
    expect(withoutRedundantWeekend(candidates).map(entry => entry.kind)).toEqual(['holiday', 'weekend'])
  })

  it('keeps every occasion, however they cluster', () => {
    const candidates = [holiday(96, '2026-11-26'), holiday(97, '2026-11-27')]
    expect(withoutRedundantWeekend(candidates)).toHaveLength(2)
  })

  it('leaves a lone weekend alone', () => {
    expect(withoutRedundantWeekend([weekendCycle('2026-08-29', 7)])).toHaveLength(1)
  })

  it('honours a wider suppression window', () => {
    const candidates = [holiday(96, '2026-11-26'), weekendCycle('2026-12-05', 105)]
    expect(withoutRedundantWeekend(candidates, 3)).toHaveLength(2)
    expect(withoutRedundantWeekend(candidates, 10)).toHaveLength(1)
  })
})

describe('decide: opening a cycle', () => {
  it('opens a cycle once it is close enough to raise', () => {
    const actions = decide(input({ candidates: [holiday(20)] }))
    expect(actions).toHaveLength(1)
    expect(actions[0]?.action).toBe('open')
  })

  it('gives every member a say', () => {
    const actions = decide(input({ candidates: [holiday(20)] }))
    expect(actions[0]?.action === 'open' && actions[0].members).toEqual(MEMBERS)
  })

  // A holiday raised three months out is noise; the family cannot plan that far.
  it('stays quiet about something still too far off', () => {
    expect(decide(input({ candidates: [holiday(96)] }))).toEqual([])
  })

  it('raises a birthday later than a holiday, because the lead times differ', () => {
    const birthday: CycleId = { kind: 'birthday', uid: 'butler-birthday-kit-2026-09-11', targetDate: '2026-09-11', label: "Kit's birthday", daysAway: 20 }
    // 20 days out: inside the holiday window (24) but outside the birthday one (18).
    expect(decide(input({ candidates: [holiday(20)] }))).toHaveLength(1)
    expect(decide(input({ candidates: [birthday] }))).toEqual([])
  })

  it('honours configured lead times', () => {
    const actions = decide(input({ candidates: [holiday(40)], policy: { leadTimes: { holiday: 45 } } }))
    expect(actions[0]?.action).toBe('open')
  })

  it('never opens a cycle for a date already gone', () => {
    expect(decide(input({ candidates: [holiday(-1)] }))).toEqual([])
  })

  it('opens a weekend cycle regardless of lead time, since its day decides it', () => {
    expect(decide(input({ candidates: [weekendCycle('2026-08-29', 7)] }))[0]?.action).toBe('open')
  })
})

describe('decide: chasing an answer', () => {
  it('nudges when somebody has not replied and the gap has passed', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ lastPrompt: '2026-08-18', waiting: ['sam'] })]])
    const actions = decide(input({ candidates: [cycle], existing }))
    expect(actions[0]?.action).toBe('nudge')
    expect(actions[0]?.action === 'nudge' && actions[0].waiting).toEqual(['sam'])
  })

  // Asking again the next morning is exactly how a butler gets muted.
  it('waits out the gap before asking again', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ lastPrompt: '2026-08-21' })]])
    expect(decide(input({ candidates: [cycle], existing }))).toEqual([])
  })

  it('respects a configured gap', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ lastPrompt: '2026-08-18' })]])
    expect(decide(input({ candidates: [cycle], existing, policy: { nudgeGapDays: 10 } }))).toEqual([])
  })

  // The chosen default: ask once more, then leave it with them.
  it('gives up once the nudge budget is spent', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ prompts: DEFAULT_MAX_NUDGES + 2, lastPrompt: '2026-08-01' })]])
    const actions = decide(input({ candidates: [cycle], existing }))
    expect(actions[0]?.action).toBe('close')
    expect(actions[0]?.action === 'close' && actions[0].reason).toBe('unanswered')
  })

  it('can be configured to chase harder', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ prompts: 3, lastPrompt: '2026-08-01' })]])
    expect(decide(input({ candidates: [cycle], existing, policy: { maxNudges: 5 } }))[0]?.action).toBe('nudge')
  })

  it('nudges a cycle it has never chased', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ prompts: 1 })]])
    expect(decide(input({ candidates: [cycle], existing }))[0]?.action).toBe('nudge')
  })
})

describe('decide: settling and closing', () => {
  it('settles once everyone has weighed in', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ answered: MEMBERS, waiting: [] })]])
    const actions = decide(input({ candidates: [cycle], existing }))
    expect(actions[0]?.action).toBe('settle')
    expect(actions[0]?.action === 'settle' && actions[0].answered).toEqual(MEMBERS)
  })

  it('closes a cycle whose date has gone by', () => {
    const cycle = holiday(-1)
    const existing = new Map([[cycle.uid, state()]])
    const actions = decide(input({ candidates: [cycle], existing }))
    expect(actions[0]?.action).toBe('close')
    expect(actions[0]?.action === 'close' && actions[0].reason).toBe('passed')
  })

  // The uid is stable, so a settled cycle keeps turning up as a candidate. Without
  // this the butler would raise Thanksgiving again the morning after settling it.
  it('never reopens a cycle that is already closed', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ closed: true })]])
    expect(decide(input({ candidates: [cycle], existing }))).toEqual([])
  })

  it('leaves a closed cycle closed even once its date passes', () => {
    const cycle = holiday(-3)
    const existing = new Map([[cycle.uid, state({ closed: true })]])
    expect(decide(input({ candidates: [cycle], existing }))).toEqual([])
  })

  it('settles rather than nudging when the last person answers late', () => {
    const cycle = holiday(20)
    const existing = new Map([[cycle.uid, state({ answered: MEMBERS, waiting: [], prompts: 9, lastPrompt: '2026-08-01' })]])
    expect(decide(input({ candidates: [cycle], existing }))[0]?.action).toBe('settle')
  })
})

describe('decide: several cycles at once', () => {
  it('decides each candidate independently', () => {
    const near = holiday(20, '2026-09-11')
    const far = holiday(90, '2026-11-26')
    const open = weekendCycle('2026-08-29', 7)
    const actions = decide(input({ candidates: [near, far, open] }))
    expect(actions.map(entry => entry.action)).toEqual(['open', 'open'])
  })

  it('preserves candidate order, so the nearest thing is raised first', () => {
    const first = holiday(5, '2026-08-27')
    const second = holiday(20, '2026-09-11')
    const actions = decide(input({ candidates: [first, second] }))
    expect(actions.map(entry => entry.cycle.targetDate)).toEqual(['2026-08-27', '2026-09-11'])
  })

  it('does nothing at all when there is nothing to raise', () => {
    expect(decide(input())).toEqual([])
  })
})

describe('daysBetween', () => {
  it('counts forward', () => {
    expect(daysBetween('2026-08-18', '2026-08-22')).toBe(4)
  })

  it('is zero for the same day', () => {
    expect(daysBetween(TODAY, TODAY)).toBe(0)
  })

  it('counts backward as negative', () => {
    expect(daysBetween('2026-08-22', '2026-08-18')).toBe(-4)
  })

  it('crosses a year boundary', () => {
    expect(daysBetween('2026-12-30', '2027-01-02')).toBe(3)
  })

  it('refuses a value that is not a calendar date', () => {
    expect(() => daysBetween('yesterday', TODAY)).toThrow(/YYYY-MM-DD/)
  })
})
