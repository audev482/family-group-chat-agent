/**
 * Chore reasoning: what counts as done, who a chore belongs to, what is most
 * urgent, and how a spoken phrase finds the right one.
 *
 * The matching tests are the load-bearing ones. A butler that guesses which
 * chore someone meant will eventually tick off the wrong one, and the family will
 * not find out until the bins are still on the kerb.
 */

import { describe, expect, it } from 'vitest'
import type { TodoFields } from 'dsh-caldav'
import {
  assigneeOf,
  byUrgency,
  choreLine,
  formatChoresByPerson,
  isCancelled,
  isDone,
  labelsOf,
  matchBySummary,
} from '../src/chores.ts'
import type { ChoreEntry } from '../src/chores.ts'

const ZONE = 'Europe/Amsterdam'

const MEMBERS = [
  { key: 'alex', displayName: 'Alex', tag: 'alex', aliases: ['Dad'], role: 'adult' },
  { key: 'sam', displayName: 'Sam', tag: 'sam', aliases: ['Mum'], role: 'adult' },
  { key: 'kit', displayName: 'Kit', tag: 'kit', aliases: [], role: 'child' },
]

/** The roster surface the chore helpers touch. */
function roster() {
  return {
    familyName: 'The Bakers',
    timezone: ZONE,
    choresCalendar: 'Household',
    list: () => MEMBERS,
    tags: () => MEMBERS.map(member => member.tag),
    // Fixed, so grouping and ordering do not depend on the real date.
    today: () => '2026-08-22',
    resolve: (name: string) => {
      const folded = name.trim().toLowerCase()
      if (folded === '') return undefined
      return MEMBERS.find(member =>
        member.key.toLowerCase() === folded
        || member.displayName.toLowerCase() === folded
        || member.tag.toLowerCase() === folded
        || member.aliases.some(alias => alias.toLowerCase() === folded))
    },
    fromCategories: (categories: readonly string[]) => {
      const folded = categories.map(value => value.trim().toLowerCase())
      return MEMBERS.find(member => folded.includes(member.tag.toLowerCase()))
    },
    when: (day: string) => `on ${day}`,
    dueness: (value: string) => `due ${value.slice(0, 10)}`,
  } as unknown as Parameters<typeof assigneeOf>[0]
}

/** A chore entry with only the fields under test filled in. */
function chore(fields: Partial<TodoFields> & { summary: string }): ChoreEntry {
  return {
    calendar: 'Household',
    url: `https://dav.example/household/${fields.uid ?? fields.summary}.ics`,
    ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    fields: {
      allDayDue: fields.allDayDue ?? true,
      priority: fields.priority ?? 0,
      percentComplete: fields.percentComplete ?? 0,
      categories: fields.categories ?? [],
      ...fields,
      uid: fields.uid ?? fields.summary,
    } as TodoFields,
  }
}

describe('isDone', () => {
  it('is done when the status says so', () => {
    expect(isDone(chore({ summary: 'Bins', status: 'COMPLETED' }).fields)).toBe(true)
  })

  it('is done when a completion time is recorded', () => {
    // Some clients set COMPLETED without touching STATUS.
    expect(isDone(chore({ summary: 'Bins', completed: '2026-08-21T10:00:00.000Z' }).fields)).toBe(true)
  })

  it('is done at 100 percent', () => {
    expect(isDone(chore({ summary: 'Bins', percentComplete: 100 }).fields)).toBe(true)
  })

  it('is not done part-way through', () => {
    expect(isDone(chore({ summary: 'Bins', percentComplete: 60, status: 'IN-PROCESS' }).fields)).toBe(false)
  })

  it('is not done when nothing has happened', () => {
    expect(isDone(chore({ summary: 'Bins' }).fields)).toBe(false)
  })

  it('does not treat a cancelled chore as done', () => {
    const cancelled = chore({ summary: 'Bins', status: 'CANCELLED' }).fields
    expect(isDone(cancelled)).toBe(false)
    expect(isCancelled(cancelled)).toBe(true)
  })
})

describe('assigneeOf', () => {
  it('reads the assignee from the categories', () => {
    expect(assigneeOf(roster(), chore({ summary: 'Bins', categories: ['alex'] }).fields)?.key).toBe('alex')
  })

  it('finds the tag among unrelated tags, which is how the Tasks UI leaves them', () => {
    const fields = chore({ summary: 'Bins', categories: ['weekly', 'outdoor', 'Sam'] }).fields
    expect(assigneeOf(roster(), fields)?.key).toBe('sam')
  })

  it('is undefined when nobody is named', () => {
    expect(assigneeOf(roster(), chore({ summary: 'Bins', categories: ['weekly'] }).fields)).toBeUndefined()
  })
})

describe('labelsOf', () => {
  it('returns the categories that are not people', () => {
    const fields = chore({ summary: 'Bins', categories: ['weekly', 'alex', 'outdoor'] }).fields
    expect(labelsOf(roster(), fields).sort()).toEqual(['outdoor', 'weekly'])
  })

  it('returns nothing when every category is a person', () => {
    expect(labelsOf(roster(), chore({ summary: 'Bins', categories: ['alex'] }).fields)).toEqual([])
  })
})

describe('byUrgency', () => {
  const today = '2026-08-22'

  it('puts overdue chores first', () => {
    const sorted = byUrgency([
      chore({ summary: 'Later', due: '2026-08-30' }),
      chore({ summary: 'Overdue', due: '2026-08-19' }),
      chore({ summary: 'Today', due: '2026-08-22' }),
    ], today)
    expect(sorted.map(entry => entry.fields.summary)).toEqual(['Overdue', 'Today', 'Later'])
  })

  it('orders overdue chores oldest first', () => {
    const sorted = byUrgency([
      chore({ summary: 'Yesterday', due: '2026-08-21' }),
      chore({ summary: 'Last week', due: '2026-08-15' }),
    ], today)
    expect(sorted.map(entry => entry.fields.summary)).toEqual(['Last week', 'Yesterday'])
  })

  it('breaks a tie on due date by priority', () => {
    const sorted = byUrgency([
      chore({ summary: 'Low', due: today, priority: 9 }),
      chore({ summary: 'High', due: today, priority: 1 }),
    ], today)
    expect(sorted.map(entry => entry.fields.summary)).toEqual(['High', 'Low'])
  })

  it('treats priority 0 as unset, not as the highest', () => {
    // RFC 5545 numbers 1 as highest, so a naive sort would put "none" first.
    const sorted = byUrgency([
      chore({ summary: 'None', due: today, priority: 0 }),
      chore({ summary: 'Low', due: today, priority: 9 }),
    ], today)
    expect(sorted.map(entry => entry.fields.summary)).toEqual(['Low', 'None'])
  })

  it('puts undated chores after dated ones', () => {
    const sorted = byUrgency([
      chore({ summary: 'Someday' }),
      chore({ summary: 'Friday', due: '2026-08-28' }),
    ], today)
    expect(sorted.map(entry => entry.fields.summary)).toEqual(['Friday', 'Someday'])
  })

  it('does not mutate the list it was given', () => {
    const entries = [chore({ summary: 'B', due: '2026-08-30' }), chore({ summary: 'A', due: '2026-08-19' })]
    byUrgency(entries, today)
    expect(entries.map(entry => entry.fields.summary)).toEqual(['B', 'A'])
  })
})

describe('matchBySummary', () => {
  const entries = [
    chore({ uid: '1', summary: 'Take the bins out' }),
    chore({ uid: '2', summary: 'Wash the car' }),
    chore({ uid: '3', summary: 'Clean the bathroom' }),
    chore({ uid: '4', summary: 'Clean the kitchen' }),
  ]

  it('matches on a word from the summary', () => {
    expect(matchBySummary(entries, 'bins').map(entry => entry.fields.uid)).toEqual(['1'])
  })

  it('ignores case and surrounding whitespace', () => {
    expect(matchBySummary(entries, '  BINS  ').map(entry => entry.fields.uid)).toEqual(['1'])
  })

  it('returns every match rather than picking one', () => {
    // The caller has to be able to ask which, instead of guessing.
    expect(matchBySummary(entries, 'clean').map(entry => entry.fields.uid)).toEqual(['3', '4'])
  })

  it('returns nothing when there is no match', () => {
    expect(matchBySummary(entries, 'mow the lawn')).toEqual([])
  })

  it('matches an exact summary', () => {
    expect(matchBySummary(entries, 'Wash the car').map(entry => entry.fields.uid)).toEqual(['2'])
  })

  it('returns nothing for an empty phrase rather than everything', () => {
    expect(matchBySummary(entries, '   ')).toEqual([])
  })
})

describe('choreLine', () => {
  it('carries the id, because every other tool needs it', () => {
    const line = choreLine(roster(), chore({ uid: 'bins-1', summary: 'Bins', due: '2026-08-22' }), {
      showAssignee: false,
    })
    expect(line).toContain('bins-1')
    expect(line).toContain('Bins')
  })

  it('names the assignee when asked', () => {
    const line = choreLine(roster(), chore({ summary: 'Bins', categories: ['alex'] }), { showAssignee: true })
    expect(line).toContain('Alex')
  })

  it('marks a high-priority chore', () => {
    const line = choreLine(roster(), chore({ summary: 'Bins', priority: 1 }), { showAssignee: false })
    expect(line.toLowerCase()).toContain('priority')
  })
})

describe('formatChoresByPerson', () => {
  it('groups by person in roster order', () => {
    const text = formatChoresByPerson(roster(), [
      chore({ summary: 'Dishes', categories: ['sam'] }),
      chore({ summary: 'Bins', categories: ['alex'] }),
    ])
    expect(text.indexOf('Alex')).toBeLessThan(text.indexOf('Sam'))
  })

  it('puts unassigned chores last, where they read as an open question', () => {
    const text = formatChoresByPerson(roster(), [
      chore({ summary: 'Nobody\'s job', categories: [] }),
      chore({ summary: 'Bins', categories: ['alex'] }),
    ])
    expect(text.indexOf('Alex')).toBeLessThan(text.toLowerCase().indexOf('unassigned'))
  })

  it('omits a person with nothing on their list', () => {
    const text = formatChoresByPerson(roster(), [chore({ summary: 'Bins', categories: ['alex'] })])
    expect(text).not.toContain('Kit')
  })

  it('says so when there is nothing at all', () => {
    expect(formatChoresByPerson(roster(), []).toLowerCase()).toContain('nothing')
  })
})
