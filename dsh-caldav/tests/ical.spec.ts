/**
 * iCalendar reading and writing.
 *
 * The tests that matter most here are the preservation ones. The butler is never
 * the only writer of these objects — a phone, a laptop, and the Nextcloud web UI
 * all touch the same VEVENTs and VTODOs — so every write is a modification of the
 * original text rather than a fresh serialisation. If that ever regresses, the
 * symptom is not a crash: it is a family quietly losing their alarms, their
 * recurrence rules, and their Nextcloud sort order weeks later. So it is pinned.
 */

import { describe, expect, it } from 'vitest'
import {
  createObject,
  loadIcal,
  parseObject,
  readEvent,
  readTodo,
  toIcalTime,
  touch,
  writeCategories,
  writeText,
  writeWhen,
} from '../src/index.ts'

/**
 * A VEVENT of the kind a real server returns: a timezone definition, an alarm,
 * Nextcloud's private properties, and a recurrence rule — none of which the
 * butler understands, and all of which it must leave intact.
 */
const EVENT_FROM_SERVER = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Nextcloud//Calendar//EN',
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Amsterdam',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100',
  'TZOFFSETTO:+0200',
  'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'END:VTIMEZONE',
  'BEGIN:VEVENT',
  'UID:dentist-1234',
  'DTSTAMP:20260801T100000Z',
  'CREATED:20260801T100000Z',
  'SUMMARY:Dentist for Kit',
  'DESCRIPTION:Bring the referral letter',
  'LOCATION:Tandarts Centrum',
  'DTSTART;TZID=Europe/Amsterdam:20260824T143000',
  'DTEND;TZID=Europe/Amsterdam:20260824T151500',
  'RRULE:FREQ=MONTHLY;COUNT=3',
  'CATEGORIES:health,kit',
  'STATUS:CONFIRMED',
  'X-OC-INVITE-STATUS:accepted',
  'X-APPLE-SORT-ORDER:12',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder',
  'TRIGGER:-PT1H',
  'END:VALARM',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n')

/** A VTODO as the Nextcloud Tasks app writes one. */
const TODO_FROM_SERVER = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//Nextcloud//Tasks//EN',
  'BEGIN:VTODO',
  'UID:bins-9876',
  'DTSTAMP:20260801T100000Z',
  'CREATED:20260801T100000Z',
  'SUMMARY:Take the bins out',
  'DESCRIPTION:Green bin this week',
  'DUE;VALUE=DATE:20260825',
  'PRIORITY:1',
  'PERCENT-COMPLETE:0',
  'STATUS:NEEDS-ACTION',
  'CATEGORIES:weekly,alex',
  'RRULE:FREQ=WEEKLY;BYDAY=TU',
  'RELATED-TO:chores-parent-1',
  'X-OC-HIDESUBTASKS:0',
  'END:VTODO',
  'END:VCALENDAR',
].join('\r\n')

describe('readEvent', () => {
  it('reads the fields the calendar tools speak', async () => {
    const { target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    const fields = readEvent(target)
    expect(fields.uid).toBe('dentist-1234')
    expect(fields.summary).toBe('Dentist for Kit')
    expect(fields.description).toBe('Bring the referral letter')
    expect(fields.location).toBe('Tandarts Centrum')
    expect(fields.status).toBe('CONFIRMED')
  })

  it('resolves a zoned start to a real instant', async () => {
    const { target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    const fields = readEvent(target)
    // 14:30 in Amsterdam in August is 12:30Z.
    expect(fields.start).toBe('2026-08-24T12:30:00.000Z')
    expect(fields.end).toBe('2026-08-24T13:15:00.000Z')
    expect(fields.allDay).toBe(false)
  })

  it('reads categories as separate values', async () => {
    const { target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    expect([...readEvent(target).categories].sort()).toEqual(['health', 'kit'])
  })

  it('reads a recurrence rule back as text that can be written again', async () => {
    const { target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    expect(readEvent(target).rrule).toContain('FREQ=MONTHLY')
  })

  it('reports an all-day event as a plain date, not a midnight instant', async () => {
    const allDay = EVENT_FROM_SERVER
      .replace('DTSTART;TZID=Europe/Amsterdam:20260824T143000', 'DTSTART;VALUE=DATE:20260824')
      .replace('DTEND;TZID=Europe/Amsterdam:20260824T151500', 'DTEND;VALUE=DATE:20260825')
    const { target } = await parseObject(allDay, 'VEVENT')
    const fields = readEvent(target)
    expect(fields.allDay).toBe(true)
    expect(fields.start).toBe('2026-08-24')
  })

  it('rejects an object that does not contain the component asked for', async () => {
    await expect(parseObject(TODO_FROM_SERVER, 'VEVENT')).rejects.toThrow(/no VEVENT/)
  })

  it('reports unparseable text as a request failure rather than crashing', async () => {
    await expect(parseObject('this is not iCalendar', 'VEVENT')).rejects.toThrow()
  })
})

describe('readTodo', () => {
  it('reads the fields the chore tools speak', async () => {
    const { target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    const fields = readTodo(target)
    expect(fields.uid).toBe('bins-9876')
    expect(fields.summary).toBe('Take the bins out')
    expect(fields.priority).toBe(1)
    expect(fields.percentComplete).toBe(0)
    expect(fields.status).toBe('NEEDS-ACTION')
    expect(fields.relatedTo).toBe('chores-parent-1')
  })

  it('reads an all-day due date as a calendar date', async () => {
    const { target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    const fields = readTodo(target)
    expect(fields.due).toBe('2026-08-25')
    expect(fields.allDayDue).toBe(true)
  })

  it('carries the assignment tag through in categories', async () => {
    const { target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    expect([...readTodo(target).categories].sort()).toEqual(['alex', 'weekly'])
  })

  it('clamps a priority the server should never have sent', async () => {
    const { target } = await parseObject(TODO_FROM_SERVER.replace('PRIORITY:1', 'PRIORITY:99'), 'VTODO')
    expect(readTodo(target).priority).toBe(9)
  })

  it('treats a missing priority as none rather than as highest', async () => {
    const { target } = await parseObject(TODO_FROM_SERVER.replace('PRIORITY:1\r\n', ''), 'VTODO')
    expect(readTodo(target).priority).toBe(0)
  })
})

describe('read-modify-write preserves what the butler does not understand', () => {
  it('keeps VTIMEZONE, VALARM, and X- properties across an event edit', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeText(target, 'summary', 'Dentist for Kit (moved)')
    touch(ICAL, target, new Date('2026-08-22T09:00:00Z'))
    const written = root.toString()

    // The parts the butler has no opinion about must survive verbatim.
    expect(written).toContain('BEGIN:VTIMEZONE')
    expect(written).toContain('TZID:Europe/Amsterdam')
    expect(written).toContain('BEGIN:VALARM')
    expect(written).toContain('TRIGGER:-PT1H')
    expect(written).toContain('X-OC-INVITE-STATUS:accepted')
    expect(written).toContain('X-APPLE-SORT-ORDER:12')
    expect(written).toContain('RRULE:FREQ=MONTHLY;COUNT=3')
    // And the edit landed.
    expect(written).toContain('Dentist for Kit (moved)')
  })

  it('keeps the recurrence rule and Nextcloud properties across a chore edit', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeCategories(ICAL, target, ['weekly', 'sam'])
    touch(ICAL, target, new Date('2026-08-22T09:00:00Z'))
    const written = root.toString()

    expect(written).toContain('RRULE:FREQ=WEEKLY;BYDAY=TU')
    expect(written).toContain('X-OC-HIDESUBTASKS:0')
    expect(written).toContain('RELATED-TO:chores-parent-1')
    expect(written).toContain('DESCRIPTION:Green bin this week')
  })

  it('reassigns a chore by replacing the whole category set, not appending to it', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeCategories(ICAL, target, ['weekly', 'sam'])
    const fields = readTodo((await parseObject(root.toString(), 'VTODO')).target)
    // The previous assignee must be gone, or the chore would read as assigned twice.
    expect([...fields.categories].sort()).toEqual(['sam', 'weekly'])
  })

  it('survives repeated edits without accumulating duplicate properties', async () => {
    const ICAL = await loadIcal()
    let text = TODO_FROM_SERVER
    for (const assignee of ['sam', 'kit', 'alex']) {
      const { root, target } = await parseObject(text, 'VTODO')
      writeCategories(ICAL, target, ['weekly', assignee])
      writeText(target, 'summary', `Take the bins out (${assignee})`)
      touch(ICAL, target, new Date('2026-08-22T09:00:00Z'))
      text = root.toString()
    }
    // One of each, not three.
    expect(text.match(/^CATEGORIES:/gm)?.length).toBe(1)
    expect(text.match(/^SUMMARY:/gm)?.length).toBe(1)
    expect(text.match(/^LAST-MODIFIED:/gm)?.length).toBe(1)
    expect(readTodo((await parseObject(text, 'VTODO')).target).summary).toBe('Take the bins out (alex)')
  })
})

describe('writeText', () => {
  it('leaves a property alone when given undefined', async () => {
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeText(target, 'location', undefined)
    expect(root.toString()).toContain('LOCATION:Tandarts Centrum')
  })

  it('removes a property when given null or empty', async () => {
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeText(target, 'location', null)
    expect(root.toString()).not.toContain('LOCATION:')
  })
})

describe('writeWhen', () => {
  it('writes an instant as UTC', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeWhen(ICAL, target, 'dtstart', { value: '2026-08-25T09:00:00.000Z' })
    const written = root.toString()
    expect(written).toContain('DTSTART:20260825T090000Z')
    // The old zoned form must be gone, not sitting beside the new one.
    expect(written).not.toContain('DTSTART;TZID=Europe/Amsterdam')
  })

  it('writes an all-day value with VALUE=DATE', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeWhen(ICAL, target, 'dtstart', { value: '2026-08-25' })
    expect(root.toString()).toContain('DTSTART;VALUE=DATE:20260825')
  })

  it('writes VALUE=DATE exactly once', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(EVENT_FROM_SERVER, 'VEVENT')
    writeWhen(ICAL, target, 'dtstart', { value: '2026-08-25' })
    // ical.js records the parameter itself when the value is date-only. Setting
    // it a second time emitted `VALUE=DATE;VALUE=DATE`, which a strict server
    // may reject outright.
    const written = root.toString()
    expect(written).not.toContain('VALUE=DATE;VALUE=DATE')
    // Scoped to the VEVENT: the embedded VTIMEZONE has a DTSTART of its own.
    const lines = written.split(/\r?\n/).filter(entry => entry.startsWith('DTSTART'))
    expect(lines).toContain('DTSTART;VALUE=DATE:20260825')
  })

  it('removes the property when given null', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeWhen(ICAL, target, 'due', null)
    expect(root.toString()).not.toContain('DUE')
  })

  it('leaves the property alone when given undefined', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeWhen(ICAL, target, 'due', undefined)
    expect(root.toString()).toContain('DUE;VALUE=DATE:20260825')
  })

  it('round-trips an all-day date without shifting it by a day', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeWhen(ICAL, target, 'due', { value: '2026-12-31' })
    const reread = readTodo((await parseObject(root.toString(), 'VTODO')).target)
    expect(reread.due).toBe('2026-12-31')
  })
})

describe('writeCategories', () => {
  it('drops the property entirely when there are no categories', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeCategories(ICAL, target, [])
    expect(root.toString()).not.toContain('CATEGORIES')
  })

  it('trims and de-duplicates, so a tag cannot appear twice', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await parseObject(TODO_FROM_SERVER, 'VTODO')
    writeCategories(ICAL, target, [' weekly ', 'weekly', 'sam', ''])
    const fields = readTodo((await parseObject(root.toString(), 'VTODO')).target)
    expect([...fields.categories].sort()).toEqual(['sam', 'weekly'])
  })
})

describe('toIcalTime', () => {
  it('builds a date-only value from YYYY-MM-DD', async () => {
    const ICAL = await loadIcal()
    const time = toIcalTime(ICAL, { value: '2026-08-24' })
    expect(time.isDate).toBe(true)
    expect(time.year).toBe(2026)
    expect(time.month).toBe(8)
    expect(time.day).toBe(24)
  })

  it('builds an instant from an ISO date-time', async () => {
    const ICAL = await loadIcal()
    const time = toIcalTime(ICAL, { value: '2026-08-24T12:30:00.000Z' })
    expect(time.isDate).toBe(false)
    expect(time.toJSDate().toISOString()).toBe('2026-08-24T12:30:00.000Z')
  })

  it('honours an explicit all-day request on a date-time', async () => {
    const ICAL = await loadIcal()
    expect(toIcalTime(ICAL, { value: '2026-08-24T12:30:00.000Z', allDay: true }).isDate).toBe(true)
  })
})

describe('createObject', () => {
  it('builds a complete VCALENDAR around a new event', async () => {
    const ICAL = await loadIcal()
    const { root, target } = await createObject(ICAL, 'VEVENT', 'new-uid-1', new Date('2026-08-22T09:00:00Z'))
    writeText(target, 'summary', 'Swimming')
    writeWhen(ICAL, target, 'dtstart', { value: '2026-08-23T14:00:00.000Z' })
    const text = root.toString()
    expect(text).toContain('BEGIN:VCALENDAR')
    expect(text).toContain('VERSION:2.0')
    expect(text).toContain('BEGIN:VEVENT')
    expect(text).toContain('UID:new-uid-1')
    // A server will reject an object without these.
    expect(text).toContain('DTSTAMP')
    expect(text).toContain('CREATED')
    expect(readEvent((await parseObject(text, 'VEVENT')).target).summary).toBe('Swimming')
  })

  it('builds a VTODO when asked for one', async () => {
    const ICAL = await loadIcal()
    const { root } = await createObject(ICAL, 'VTODO', 'new-uid-2', new Date('2026-08-22T09:00:00Z'))
    expect(root.toString()).toContain('BEGIN:VTODO')
  })
})
