/**
 * Household clock behaviour: the arithmetic every answer about "tomorrow"
 * depends on. Pure functions, so no service is mounted.
 */

import { describe, expect, it } from 'vitest'
import {
  addDays,
  dayWindow,
  describeDueness,
  formatTimeOfDay,
  formatWhen,
  resolveDay,
  todayIso,
  zonedParts,
  zonedToInstant,
} from '../src/clock.ts'

const AMSTERDAM = 'Europe/Amsterdam'

describe('zonedParts', () => {
  it('reads wall-clock fields in the requested zone, not UTC', () => {
    // 22:30 UTC is already the next day in Amsterdam (UTC+2 in August).
    const parts = zonedParts(new Date('2026-08-22T22:30:00Z'), AMSTERDAM)
    expect(parts).toEqual({ year: 2026, month: 8, day: 23, hour: 0, minute: 30 })
  })

  it('reports local midnight as hour 0 rather than 24', () => {
    expect(zonedParts(new Date('2026-08-21T22:00:00Z'), AMSTERDAM).hour).toBe(0)
  })
})

describe('zonedToInstant', () => {
  it('resolves a summer wall-clock time at the summer offset', () => {
    const instant = zonedToInstant({ year: 2026, month: 8, day: 22, hour: 9 }, AMSTERDAM)
    expect(instant.toISOString()).toBe('2026-08-22T07:00:00.000Z')
  })

  it('resolves a winter wall-clock time at the winter offset', () => {
    const instant = zonedToInstant({ year: 2026, month: 1, day: 22, hour: 9 }, AMSTERDAM)
    expect(instant.toISOString()).toBe('2026-01-22T08:00:00.000Z')
  })

  it('lands on the correct offset for the morning after a spring-forward', () => {
    // The Netherlands springs forward on 2026-03-29; 07:30 that morning is CEST.
    const instant = zonedToInstant({ year: 2026, month: 3, day: 29, hour: 7, minute: 30 }, AMSTERDAM)
    expect(instant.toISOString()).toBe('2026-03-29T05:30:00.000Z')
  })
})

describe('todayIso', () => {
  it('uses the family time zone to decide which day it is', () => {
    const lateEvening = new Date('2026-08-22T23:30:00Z')
    expect(todayIso(lateEvening.toISOString() === '' ? '' : AMSTERDAM, lateEvening)).toBe('2026-08-23')
    expect(todayIso('UTC', lateEvening)).toBe('2026-08-22')
  })
})

describe('addDays', () => {
  it('crosses month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
  })

  it('rejects anything that is not a calendar date', () => {
    expect(() => addDays('tomorrow', 1)).toThrow(RangeError)
  })
})

describe('dayWindow', () => {
  it('spans local midnight to local midnight', () => {
    const window = dayWindow('2026-08-22', 1, AMSTERDAM)
    expect(window.start.toISOString()).toBe('2026-08-21T22:00:00.000Z')
    expect(window.end.toISOString()).toBe('2026-08-22T22:00:00.000Z')
  })

  it('spans a week when asked for seven days', () => {
    const window = dayWindow('2026-08-22', 7, AMSTERDAM)
    expect(window.end.getTime() - window.start.getTime()).toBe(7 * 86_400_000)
  })

  it('covers 23 hours across a spring-forward, because that local day is shorter', () => {
    const window = dayWindow('2026-03-29', 1, AMSTERDAM)
    expect(window.end.getTime() - window.start.getTime()).toBe(23 * 3_600_000)
  })

  it('treats a span below one day as one day', () => {
    const window = dayWindow('2026-08-22', 0, AMSTERDAM)
    expect(window.end.getTime() - window.start.getTime()).toBe(86_400_000)
  })
})

describe('resolveDay', () => {
  // A Saturday.
  const now = new Date('2026-08-22T09:00:00Z')

  it('understands the words a family actually uses', () => {
    expect(resolveDay('today', AMSTERDAM, now)).toBe('2026-08-22')
    expect(resolveDay('', AMSTERDAM, now)).toBe('2026-08-22')
    expect(resolveDay('tonight', AMSTERDAM, now)).toBe('2026-08-22')
    expect(resolveDay('tomorrow', AMSTERDAM, now)).toBe('2026-08-23')
    expect(resolveDay('yesterday', AMSTERDAM, now)).toBe('2026-08-21')
  })

  it('reads a weekday as the next such day, counting today', () => {
    expect(resolveDay('saturday', AMSTERDAM, now)).toBe('2026-08-22')
    expect(resolveDay('Monday', AMSTERDAM, now)).toBe('2026-08-24')
    expect(resolveDay('friday', AMSTERDAM, now)).toBe('2026-08-28')
  })

  it('passes an explicit date through', () => {
    expect(resolveDay('2026-12-25', AMSTERDAM, now)).toBe('2026-12-25')
  })

  it('returns undefined rather than guessing at a phrase it does not know', () => {
    expect(resolveDay('the day after the school fete', AMSTERDAM, now)).toBeUndefined()
    expect(resolveDay('next week', AMSTERDAM, now)).toBeUndefined()
  })
})

describe('formatWhen', () => {
  it('renders an instant in the family zone', () => {
    expect(formatWhen('2026-08-22T12:00:00Z', AMSTERDAM)).toContain('14:00')
  })

  it('renders an all-day date without inventing a time', () => {
    const text = formatWhen('2026-08-22', AMSTERDAM)
    expect(text).toContain('22')
    expect(text).not.toContain(':')
  })

  it('returns an unparseable value unchanged instead of throwing', () => {
    expect(formatWhen('soon', AMSTERDAM)).toBe('soon')
  })
})

describe('formatTimeOfDay', () => {
  it('gives the local clock time', () => {
    expect(formatTimeOfDay('2026-08-22T12:00:00Z', AMSTERDAM)).toBe('14:00')
  })

  it('says "all day" for a date-only value', () => {
    expect(formatTimeOfDay('2026-08-22', AMSTERDAM)).toBe('all day')
  })
})

describe('describeDueness', () => {
  const now = new Date('2026-08-22T09:00:00Z')

  it('phrases the near dates the way a person would', () => {
    expect(describeDueness('2026-08-22', AMSTERDAM, now)).toBe('due today')
    expect(describeDueness('2026-08-23', AMSTERDAM, now)).toBe('due tomorrow')
    expect(describeDueness('2026-08-21', AMSTERDAM, now)).toBe('overdue since yesterday')
  })

  it('counts days for anything further out', () => {
    expect(describeDueness('2026-08-19', AMSTERDAM, now)).toBe('overdue by 3 days')
    expect(describeDueness('2026-08-27', AMSTERDAM, now)).toBe('in 5 days')
  })
})
