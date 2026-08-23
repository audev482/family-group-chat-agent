/**
 * Calendar reasoning: which collections a question is about, how an agenda
 * reads, and where the gaps are.
 *
 * The household is a structural stand-in rather than the real service. Building
 * the real one here would pull `dsh-household`'s compiled artifact into a program
 * that also holds this package's source, which is the type-plane mismatch the
 * workspace avoids by typechecking per package.
 */

import { describe, expect, it } from 'vitest'
import type { EventFields } from 'dsh-caldav'
import { findFreeSlots, formatAgenda, scopeFor } from '../src/events.ts'
import type { EventEntry } from '../src/events.ts'

const ZONE = 'Europe/Amsterdam'

/** The roster surface the calendar helpers actually touch. */
function roster(overrides: Record<string, unknown> = {}) {
  const base = {
    familyName: 'The Bakers',
    timezone: ZONE,
    sharedCalendar: 'Family',
    choresCalendar: 'Household',
    list: () => [
      { key: 'alex', displayName: 'Alex', tag: 'alex', aliases: [], calendar: 'Alex', role: 'adult' },
      { key: 'sam', displayName: 'Sam', tag: 'sam', aliases: [], role: 'adult' },
    ],
    // Takes an instant and reports its local day, which is what bucketing needs.
    today: (now: Date = new Date()) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, dateStyle: 'short' }).format(now),
    shiftDay: (day: string, offset: number) => {
      const date = new Date(`${day}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() + offset)
      return date.toISOString().slice(0, 10)
    },
    window: (day: string, days: number) => ({
      // Amsterdam is UTC+2 in August, which is all these tests use.
      start: new Date(`${day}T00:00:00+02:00`),
      end: new Date(new Date(`${day}T00:00:00+02:00`).getTime() + days * 86_400_000),
    }),
    when: (day: string) => `on ${day}`,
    timeOfDay: (value: string) =>
      value.length === 10
        ? 'all day'
        : new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit' })
            .format(new Date(value)),
    ...overrides,
  }
  return base as unknown as Parameters<typeof scopeFor>[0]
}

/** An event entry with only the fields under test filled in. */
function event(fields: Partial<EventFields> & { start: string }, calendar = 'Family'): EventEntry {
  return {
    calendar,
    url: `https://dav.example/${calendar}/${fields.uid ?? 'x'}.ics`,
    ical: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    fields: {
      uid: fields.uid ?? 'uid-1',
      summary: fields.summary ?? 'Something',
      allDay: fields.allDay ?? false,
      categories: fields.categories ?? [],
      attendees: fields.attendees ?? [],
      ...fields,
    } as EventFields,
  }
}

describe('scopeFor', () => {
  it('uses an explicitly named collection above everything else', () => {
    const scope = scopeFor(roster(), { calendar: 'Holidays' })
    expect(scope.calendars).toEqual(['Holidays'])
    expect(scope.reason).toContain('Holidays')
  })

  it('uses a person\'s own collection when they have one', () => {
    const person = { key: 'alex', displayName: 'Alex', tag: 'alex', aliases: [], calendar: 'Alex', role: 'adult' }
    const scope = scopeFor(roster(), { person: person as never })
    expect(scope.calendars).toEqual(['Alex'])
    expect(scope.reason).toContain('Alex')
  })

  it('falls back to the shared collection for a person without one', () => {
    // Their events are kept on the shared calendar, so "nothing found" would be wrong.
    const person = { key: 'sam', displayName: 'Sam', tag: 'sam', aliases: [], role: 'adult' }
    const scope = scopeFor(roster(), { person: person as never })
    expect(scope.calendars).toEqual(['Family'])
    expect(scope.reason).toContain('Sam')
  })

  it('says so plainly when a person has no collection at all', () => {
    const bare = roster({ sharedCalendar: undefined })
    const person = { key: 'sam', displayName: 'Sam', tag: 'sam', aliases: [], role: 'adult' }
    const scope = scopeFor(bare, { person: person as never })
    expect(scope.calendars).toEqual([])
    expect(scope.reason).toContain('Sam')
  })

  it('covers every collection the family keeps when nobody is named', () => {
    const scope = scopeFor(roster(), {})
    expect(scope.calendars).toContain('Family')
    expect(scope.calendars).toContain('Alex')
  })

  it('does not list the same collection twice when a person shares the family one', () => {
    const shared = roster({
      list: () => [
        { key: 'alex', displayName: 'Alex', tag: 'alex', aliases: [], calendar: 'Family', role: 'adult' },
      ],
    })
    const scope = scopeFor(shared, {})
    expect(scope.calendars.filter(name => name === 'Family')).toHaveLength(1)
  })

  it('ignores an explicit collection that is only whitespace', () => {
    const scope = scopeFor(roster(), { calendar: '   ' })
    expect(scope.calendars).toContain('Family')
  })
})

describe('formatAgenda', () => {
  it('groups events under each day and says when a day is empty', () => {
    const text = formatAgenda(roster(), [
      event({ uid: 'a', summary: 'Swimming', start: '2026-08-22T12:00:00.000Z' }),
    ], { fromDay: '2026-08-22', days: 2, showCalendar: false })
    expect(text).toContain('Swimming')
    expect(text).toContain('nothing scheduled')
  })

  it('reports an all-day event on its own date', () => {
    const text = formatAgenda(roster(), [
      event({ uid: 'b', summary: 'Kit\'s birthday', start: '2026-08-23', allDay: true }),
    ], { fromDay: '2026-08-22', days: 2, showCalendar: false })
    const lines = text.split('\n')
    const dayIndex = lines.findIndex(line => line.includes('2026-08-23'))
    expect(lines[dayIndex + 1]).toContain('birthday')
  })

  it('names the collection when more than one was read', () => {
    const text = formatAgenda(roster(), [
      event({ uid: 'c', summary: 'Dentist', start: '2026-08-22T12:00:00.000Z' }, 'Alex'),
    ], { fromDay: '2026-08-22', days: 1, showCalendar: true })
    expect(text).toContain('Alex')
  })

  it('assigns a late-evening event to the local day, not the UTC one', () => {
    // 22:30Z on the 22nd is 00:30 on the 23rd in Amsterdam.
    const text = formatAgenda(roster(), [
      event({ uid: 'd', summary: 'Night flight', start: '2026-08-22T22:30:00.000Z' }),
    ], { fromDay: '2026-08-22', days: 2, showCalendar: false })
    const lines = text.split('\n')
    const twentySecond = lines.findIndex(line => line.includes('2026-08-22'))
    const twentyThird = lines.findIndex(line => line.includes('2026-08-23'))
    expect(lines.slice(twentySecond, twentyThird).join('\n')).toContain('nothing scheduled')
    expect(lines.slice(twentyThird).join('\n')).toContain('Night flight')
  })
})

describe('findFreeSlots', () => {
  const options = { fromDay: '2026-08-22', days: 1, minutes: 60, earliestHour: 9, latestHour: 17 }

  it('offers the whole usable day when nothing is booked', () => {
    const slots = findFreeSlots(roster(), [], options)
    expect(slots).toHaveLength(1)
    expect(slots[0]?.start.toISOString()).toBe('2026-08-22T07:00:00.000Z')
    expect(slots[0]?.end.toISOString()).toBe('2026-08-22T15:00:00.000Z')
  })

  it('splits the day around a booking', () => {
    const slots = findFreeSlots(roster(), [
      // 12:00–13:00 local.
      event({ uid: 'a', start: '2026-08-22T10:00:00.000Z', end: '2026-08-22T11:00:00.000Z' }),
    ], options)
    expect(slots).toHaveLength(2)
    expect(slots[0]?.end.toISOString()).toBe('2026-08-22T10:00:00.000Z')
    expect(slots[1]?.start.toISOString()).toBe('2026-08-22T11:00:00.000Z')
  })

  it('does not offer a gap shorter than what was asked for', () => {
    const slots = findFreeSlots(roster(), [
      event({ uid: 'a', start: '2026-08-22T07:30:00.000Z', end: '2026-08-22T11:00:00.000Z' }),
    ], options)
    // The 30-minute gap before the booking is too short for an hour.
    expect(slots.every(slot => slot.end.getTime() - slot.start.getTime() >= 3_600_000)).toBe(true)
  })

  it('ignores an all-day event, which does not actually occupy the afternoon', () => {
    const slots = findFreeSlots(roster(), [
      event({ uid: 'a', start: '2026-08-22', allDay: true, summary: 'Kit\'s birthday' }),
    ], options)
    expect(slots).toHaveLength(1)
  })

  it('merges overlapping bookings rather than reporting a gap between them', () => {
    const slots = findFreeSlots(roster(), [
      event({ uid: 'a', start: '2026-08-22T10:00:00.000Z', end: '2026-08-22T12:00:00.000Z' }),
      event({ uid: 'b', start: '2026-08-22T11:00:00.000Z', end: '2026-08-22T13:00:00.000Z' }),
    ], options)
    expect(slots).toHaveLength(2)
    expect(slots[1]?.start.toISOString()).toBe('2026-08-22T13:00:00.000Z')
  })

  it('treats an event with no end as lasting an hour', () => {
    const slots = findFreeSlots(roster(), [
      event({ uid: 'a', start: '2026-08-22T10:00:00.000Z' }),
    ], options)
    expect(slots[1]?.start.toISOString()).toBe('2026-08-22T11:00:00.000Z')
  })

  it('ignores bookings that fall entirely outside the usable hours', () => {
    const slots = findFreeSlots(roster(), [
      // 06:00–07:00 local, before the day opens at 09:00.
      event({ uid: 'a', start: '2026-08-22T04:00:00.000Z', end: '2026-08-22T05:00:00.000Z' }),
    ], options)
    expect(slots).toHaveLength(1)
  })

  it('returns nothing when the day is fully booked', () => {
    const slots = findFreeSlots(roster(), [
      event({ uid: 'a', start: '2026-08-22T07:00:00.000Z', end: '2026-08-22T15:00:00.000Z' }),
    ], options)
    expect(slots).toHaveLength(0)
  })

  it('searches several days when asked', () => {
    const slots = findFreeSlots(roster(), [], { ...options, days: 3 })
    expect(slots).toHaveLength(3)
    expect([...new Set(slots.map(slot => slot.day))]).toHaveLength(3)
  })
})
