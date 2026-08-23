/**
 * Cycle storage: the VTODOs behind a planning conversation.
 *
 * The `RELATED-TO` direction is the thing under test here, because getting it
 * backwards is the one mistake that would quietly undermine the whole design —
 * subtasks the Nextcloud Tasks app cannot see, and a butler that therefore thinks
 * nobody ever answers. The app finds a parent with `task.related === parent.uid`, so
 * the child must carry the parent's uid, and these tests assert exactly that against
 * the iCalendar text actually sent to the server.
 *
 * CalDAV is faked structurally. Nothing here touches a network.
 */

import { describe, expect, it, vi } from 'vitest'
import { CalDavCycleStore, MEMBER_PROPERTY, PROMPTS_PROPERTY } from '../src/store.ts'
import { cycleUid, subtaskUid } from '../src/cycles.ts'
import type { CycleId } from '../src/cycles.ts'

const CYCLE: CycleId = {
  kind: 'holiday',
  uid: cycleUid('holiday', '2026-11-26', 'holiday:thanksgiving'),
  targetDate: '2026-11-26',
  label: 'Thanksgiving',
  daysAway: 21,
}

/** One VTODO as a server would return it. */
function vtodo(fields: {
  uid: string
  summary?: string
  status?: string
  relatedTo?: string
  member?: string
  prompts?: string
  lastPrompt?: string
  percent?: number
}): { url: string; etag: string; ical: string } {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//test//EN',
    'BEGIN:VTODO',
    `UID:${fields.uid}`,
    `SUMMARY:${fields.summary ?? 'Something'}`,
    `STATUS:${fields.status ?? 'NEEDS-ACTION'}`,
  ]
  if (fields.percent !== undefined) lines.push(`PERCENT-COMPLETE:${fields.percent}`)
  if (fields.relatedTo !== undefined) lines.push(`RELATED-TO:${fields.relatedTo}`)
  if (fields.member !== undefined) lines.push(`${MEMBER_PROPERTY.toUpperCase()}:${fields.member}`)
  if (fields.prompts !== undefined) lines.push(`${PROMPTS_PROPERTY.toUpperCase()}:${fields.prompts}`)
  if (fields.lastPrompt !== undefined) lines.push(`X-BUTLER-LAST-PROMPT:${fields.lastPrompt}`)
  lines.push('END:VTODO', 'END:VCALENDAR')
  return { url: `https://example.test/${fields.uid}.ics`, etag: `"${fields.uid}"`, ical: lines.join('\r\n') }
}

/** A store over a fake CalDAV service. */
function build(records: readonly { url: string; etag: string; ical: string }[] = []) {
  const created: { uid: string; ical: string }[] = []
  const updated: { url: string; ical: string; etag?: string }[] = []
  const caldav = {
    objects: vi.fn(async () => [...records]),
    create: vi.fn(async (options: { uid: string; ical: string }) => {
      created.push(options)
      return { url: `https://example.test/${options.uid}.ics` }
    }),
    update: vi.fn(async (options: { url: string; ical: string; etag?: string }) => {
      updated.push(options)
      return { url: options.url }
    }),
  }
  const ctx = { caldav } as unknown as ConstructorParameters<typeof CalDavCycleStore>[0]
  const store = new CalDavCycleStore(ctx, {
    calendar: 'Household',
    displayName: key => key.toUpperCase(),
  })
  return { store, created, updated, caldav }
}

describe('openCycle', () => {
  it('creates one parent and one subtask per member', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex', 'sam'], '2026-11-05')
    expect(created.map(entry => entry.uid)).toEqual([
      CYCLE.uid,
      subtaskUid(CYCLE.uid, 'alex'),
      subtaskUid(CYCLE.uid, 'sam'),
    ])
  })

  // The direction the Nextcloud Tasks app reads. Reversing this produces subtasks
  // the family never sees.
  it('puts the parent uid on each child, not the other way round', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    const parent = created[0]!
    const child = created[1]!
    expect(child.ical).toContain(`RELATED-TO:${CYCLE.uid}`)
    expect(parent.ical).not.toContain('RELATED-TO')
  })

  it('writes a plain RELATED-TO with no RELTYPE, which the Tasks app treats as the parent', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    expect(created[1]!.ical).not.toContain('RELTYPE')
  })

  it('records the member on each subtask so answers can be attributed', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    expect(created[1]!.ical.toUpperCase()).toContain('X-BUTLER-MEMBER:alex'.toUpperCase())
  })

  it('counts the opening as the first ask', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    expect(created[0]!.ical.toUpperCase()).toContain('X-BUTLER-PROMPTS:1')
    expect(created[0]!.ical).toContain('X-BUTLER-LAST-PROMPT:2026-11-05')
  })

  it('dates both parent and subtasks to the occasion', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    for (const entry of created) expect(entry.ical).toContain('20261126')
  })

  it('titles the subtask as a question to that person', async () => {
    const { store, created } = build()
    await store.openCycle(CYCLE, ['alex'], '2026-11-05')
    expect(created[1]!.ical).toContain('ALEX')
  })

  // One member's subtask failing must not cost the others theirs.
  it('keeps going when one subtask cannot be written', async () => {
    const { store, created, caldav } = build()
    let call = 0
    caldav.create.mockImplementation(async (options: { uid: string; ical: string }) => {
      call += 1
      if (call === 2) throw new Error('conflict')
      created.push(options)
      return { url: 'https://example.test/x.ics' }
    })
    await store.openCycle(CYCLE, ['alex', 'sam'], '2026-11-05')
    expect(created.map(entry => entry.uid)).toEqual([CYCLE.uid, subtaskUid(CYCLE.uid, 'sam')])
  })
})

describe('readCycle', () => {
  it('returns nothing when the cycle has never been opened', async () => {
    const { store } = build()
    expect(await store.readCycle(CYCLE)).toBeUndefined()
  })

  it('splits members into answered and waiting', async () => {
    const { store } = build([
      vtodo({ uid: CYCLE.uid, prompts: '1' }),
      vtodo({ uid: subtaskUid(CYCLE.uid, 'alex'), relatedTo: CYCLE.uid, member: 'alex', status: 'COMPLETED' }),
      vtodo({ uid: subtaskUid(CYCLE.uid, 'sam'), relatedTo: CYCLE.uid, member: 'sam' }),
    ])
    const state = await store.readCycle(CYCLE)
    expect(state?.answered).toEqual(['alex'])
    expect(state?.waiting).toEqual(['sam'])
  })

  it('reads the ask count and the date it last asked', async () => {
    const { store } = build([vtodo({ uid: CYCLE.uid, prompts: '2', lastPrompt: '2026-11-08' })])
    const state = await store.readCycle(CYCLE)
    expect(state?.prompts).toBe(2)
    expect(state?.lastPrompt).toBe('2026-11-08')
  })

  it('treats a missing ask count as none rather than failing', async () => {
    const { store } = build([vtodo({ uid: CYCLE.uid })])
    expect((await store.readCycle(CYCLE))?.prompts).toBe(0)
  })

  it('treats a corrupt ask count as none, costing at most one extra nudge', async () => {
    const { store } = build([vtodo({ uid: CYCLE.uid, prompts: 'lots' })])
    expect((await store.readCycle(CYCLE))?.prompts).toBe(0)
  })

  it('reports a completed parent as closed', async () => {
    const { store } = build([vtodo({ uid: CYCLE.uid, status: 'COMPLETED' })])
    expect((await store.readCycle(CYCLE))?.closed).toBe(true)
  })

  // Somebody else's chores share the collection and must not be read as answers.
  it('ignores tasks belonging to another cycle', async () => {
    const { store } = build([
      vtodo({ uid: CYCLE.uid }),
      vtodo({ uid: 'butler-weekend-2026-08-29-alex', relatedTo: 'butler-weekend-2026-08-29', member: 'alex' }),
      vtodo({ uid: 'take-the-bins-out' }),
    ])
    const state = await store.readCycle(CYCLE)
    expect(state?.answered).toEqual([])
    expect(state?.waiting).toEqual([])
  })

  it('ignores a subtask with no member recorded', async () => {
    const { store } = build([
      vtodo({ uid: CYCLE.uid }),
      vtodo({ uid: 'stray', relatedTo: CYCLE.uid }),
    ])
    expect((await store.readCycle(CYCLE))?.waiting).toEqual([])
  })

  it('counts a subtask at a hundred percent as answered', async () => {
    const { store } = build([
      vtodo({ uid: CYCLE.uid }),
      vtodo({ uid: subtaskUid(CYCLE.uid, 'kit'), relatedTo: CYCLE.uid, member: 'kit', percent: 100 }),
    ])
    expect((await store.readCycle(CYCLE))?.answered).toEqual(['kit'])
  })

  // One malformed object in a shared collection must not hide the whole cycle.
  it('skips an object that does not parse', async () => {
    const { store } = build([
      { url: 'https://example.test/broken.ics', etag: '"x"', ical: 'this is not iCalendar' },
      vtodo({ uid: CYCLE.uid }),
      vtodo({ uid: subtaskUid(CYCLE.uid, 'kit'), relatedTo: CYCLE.uid, member: 'kit' }),
    ])
    const state = await store.readCycle(CYCLE)
    expect(state?.waiting).toEqual(['kit'])
  })

  // An undated VTODO would be excluded by an RFC 4791 time-range query.
  it('asks for the whole collection rather than a date range', async () => {
    const { store, caldav } = build()
    await store.readCycle(CYCLE)
    expect(caldav.objects).toHaveBeenCalledWith(expect.not.objectContaining({ timeRange: expect.anything() }))
  })
})

describe('recordPrompt', () => {
  it('increments the ask count and moves the date on', async () => {
    const { store, updated } = build([vtodo({ uid: CYCLE.uid, prompts: '1', lastPrompt: '2026-11-05' })])
    await store.recordPrompt(CYCLE, '2026-11-09')
    expect(updated[0]!.ical.toUpperCase()).toContain('X-BUTLER-PROMPTS:2')
    expect(updated[0]!.ical).toContain('X-BUTLER-LAST-PROMPT:2026-11-09')
  })

  // Somebody editing their task on a phone is expected, so the ETag goes back and
  // the server decides rather than the butler overwriting them.
  it('sends the ETag back so a concurrent edit is a conflict, not a silent overwrite', async () => {
    const { store, updated } = build([vtodo({ uid: CYCLE.uid })])
    await store.recordPrompt(CYCLE, '2026-11-09')
    expect(updated[0]!.etag).toBe(`"${CYCLE.uid}"`)
  })

  it('does nothing when the cycle is not there', async () => {
    const { store, updated } = build()
    await store.recordPrompt(CYCLE, '2026-11-09')
    expect(updated).toEqual([])
  })
})

describe('closeCycle', () => {
  it('completes the parent so it is never reopened', async () => {
    const { store, updated } = build([vtodo({ uid: CYCLE.uid })])
    await store.closeCycle(CYCLE)
    expect(updated[0]!.ical).toContain('STATUS:COMPLETED')
    expect(updated[0]!.ical).toContain('PERCENT-COMPLETE:100')
    expect(updated[0]!.ical).toContain('COMPLETED:')
  })

  it('leaves the subtasks alone, so the family can still see who said what', async () => {
    const { store, updated } = build([
      vtodo({ uid: CYCLE.uid }),
      vtodo({ uid: subtaskUid(CYCLE.uid, 'kit'), relatedTo: CYCLE.uid, member: 'kit' }),
    ])
    await store.closeCycle(CYCLE)
    expect(updated).toHaveLength(1)
    expect(updated[0]!.url).toContain(CYCLE.uid)
  })
})
