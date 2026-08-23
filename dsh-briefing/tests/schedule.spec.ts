/**
 * The daily schedule.
 *
 * The DST tests are the reason this module exists separately at all. Scheduling
 * by "now + 24 hours" is the obvious implementation and it drifts an hour twice a
 * year, so the digest arrives at 06:30 all summer or 08:30 all winter. Deriving
 * the next run from the *local day* keeps it at breakfast.
 */

import { describe, expect, it } from 'vitest'
import { nextRun, parseTimeOfDay } from '../src/schedule.ts'
import type { ScheduleClock } from '../src/schedule.ts'

/**
 * A clock for one time zone, using the platform's own zone database.
 * @param zone - IANA time zone.
 * @returns the clock.
 */
function clock(zone: string): ScheduleClock {
  const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: zone, dateStyle: 'short' })
  return {
    timezone: zone,
    today: (now = new Date()) => dayFormat.format(now),
    shiftDay: (dayIso, days) => {
      const date = new Date(`${dayIso}T12:00:00Z`)
      date.setUTCDate(date.getUTCDate() + days)
      return date.toISOString().slice(0, 10)
    },
  }
}

const AMSTERDAM = clock('Europe/Amsterdam')

describe('parseTimeOfDay', () => {
  it('parses a 24-hour time', () => {
    expect(parseTimeOfDay('07:30')).toEqual({ hour: 7, minute: 30 })
    expect(parseTimeOfDay('23:59')).toEqual({ hour: 23, minute: 59 })
    expect(parseTimeOfDay('00:00')).toEqual({ hour: 0, minute: 0 })
  })

  it('accepts a single-digit hour and surrounding space', () => {
    expect(parseTimeOfDay(' 7:05 ')).toEqual({ hour: 7, minute: 5 })
  })

  it('refuses a time that is not a time, rather than scheduling nothing', () => {
    // A silent failure here means a digest that simply never arrives.
    expect(() => parseTimeOfDay('half past seven')).toThrow(RangeError)
    expect(() => parseTimeOfDay('7')).toThrow(RangeError)
    expect(() => parseTimeOfDay('7.30')).toThrow(RangeError)
    expect(() => parseTimeOfDay('')).toThrow(RangeError)
  })

  it('refuses an hour or minute outside the clock', () => {
    expect(() => parseTimeOfDay('24:00')).toThrow(/not a real time/)
    expect(() => parseTimeOfDay('07:60')).toThrow(/not a real time/)
  })
})

describe('nextRun', () => {
  const at = { hour: 7, minute: 30 }

  it('schedules later today when the time has not passed', () => {
    // 03:00Z on 22 August is 05:00 local, before 07:30.
    const due = nextRun(AMSTERDAM, at, new Date('2026-08-22T03:00:00Z'))
    expect(due.toISOString()).toBe('2026-08-22T05:30:00.000Z')
  })

  it('schedules tomorrow when the time has already passed', () => {
    const due = nextRun(AMSTERDAM, at, new Date('2026-08-22T09:00:00Z'))
    expect(due.toISOString()).toBe('2026-08-23T05:30:00.000Z')
  })

  it('always returns an instant strictly in the future', () => {
    for (const iso of [
      '2026-08-22T00:00:00Z',
      '2026-08-22T05:29:59Z',
      '2026-08-22T05:30:00Z',
      '2026-08-22T23:59:59Z',
    ]) {
      const now = new Date(iso)
      expect(nextRun(AMSTERDAM, at, now).getTime()).toBeGreaterThan(now.getTime())
    }
  })

  it('keeps arriving at 07:30 local across the spring-forward', () => {
    // 28 March is CET (+01:00); 29 March is CEST (+02:00).
    const beforeChange = nextRun(AMSTERDAM, at, new Date('2026-03-28T03:00:00Z'))
    const afterChange = nextRun(AMSTERDAM, at, new Date('2026-03-29T03:00:00Z'))
    expect(beforeChange.toISOString()).toBe('2026-03-28T06:30:00.000Z')
    expect(afterChange.toISOString()).toBe('2026-03-29T05:30:00.000Z')
    // Naively adding 24 hours would have produced 06:30Z, an hour late locally.
    expect(afterChange.getTime() - beforeChange.getTime()).toBe(23 * 3_600_000)
  })

  it('keeps arriving at 07:30 local across the autumn fall-back', () => {
    const beforeChange = nextRun(AMSTERDAM, at, new Date('2026-10-24T03:00:00Z'))
    const afterChange = nextRun(AMSTERDAM, at, new Date('2026-10-25T03:00:00Z'))
    expect(beforeChange.toISOString()).toBe('2026-10-24T05:30:00.000Z')
    expect(afterChange.toISOString()).toBe('2026-10-25T06:30:00.000Z')
    expect(afterChange.getTime() - beforeChange.getTime()).toBe(25 * 3_600_000)
  })

  it('handles midnight', () => {
    const due = nextRun(AMSTERDAM, { hour: 0, minute: 0 }, new Date('2026-08-22T09:00:00Z'))
    // Local midnight on the 23rd is 22:00Z on the 22nd.
    expect(due.toISOString()).toBe('2026-08-22T22:00:00.000Z')
  })

  it('works in a zone with no daylight saving at all', () => {
    const tokyo = clock('Asia/Tokyo')
    const due = nextRun(tokyo, at, new Date('2026-08-21T20:00:00Z'))
    // 07:30 in Tokyo is 22:30Z the previous day.
    expect(due.toISOString()).toBe('2026-08-21T22:30:00.000Z')
  })

  it('works in a zone behind UTC', () => {
    const newYork = clock('America/New_York')
    const due = nextRun(newYork, at, new Date('2026-08-22T09:00:00Z'))
    // 07:30 in New York in August is 11:30Z.
    expect(due.toISOString()).toBe('2026-08-22T11:30:00.000Z')
  })
})
