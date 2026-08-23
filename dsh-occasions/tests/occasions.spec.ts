/**
 * Birthdays, anniversaries, and the merged occasion list.
 *
 * The reference date is pinned in every test. An earlier version of this suite
 * elsewhere in the workspace passed only because the real date happened to agree
 * with it, and broke the following morning — so nothing here reads the clock.
 *
 * The leap-day cases get disproportionate attention because the failure is
 * invisible: a birthday that silently does not appear for three years running is
 * not something anyone notices until it is too late to matter.
 */

import { describe, expect, it } from 'vitest'
import {
  birthdayOccasions,
  dayDiff,
  householdOccasions,
  nextOccurrence,
  parseRecurring,
  upcomingOccasions,
} from '../src/occasions.ts'
import type { BirthdayPerson, HouseholdOccasion } from '../src/occasions.ts'

/** A Saturday, deliberately fixed. Nothing in this file may read the clock. */
const TODAY = '2026-08-22'

const FAMILY: readonly BirthdayPerson[] = [
  { key: 'alex', displayName: 'Alex', birthday: '1985-03-14' },
  { key: 'sam', displayName: 'Sam', birthday: '09-02' },
  { key: 'kit', displayName: 'Kit', birthday: '2016-08-30' },
  { key: 'robin', displayName: 'Robin' },
]

describe('parseRecurring', () => {
  it('reads a month and day', () => {
    expect(parseRecurring('03-14')).toEqual({ month: 3, day: 14 })
  })

  it('reads a full date and keeps the year', () => {
    expect(parseRecurring('1985-03-14')).toEqual({ month: 3, day: 14, year: 1985 })
  })

  it('accepts the 29th of February as a pattern', () => {
    expect(parseRecurring('02-29')).toEqual({ month: 2, day: 29 })
  })

  it('rejects a day the month never has', () => {
    expect(parseRecurring('02-30')).toBeUndefined()
    expect(parseRecurring('04-31')).toBeUndefined()
  })

  it('rejects an impossible month', () => {
    expect(parseRecurring('13-01')).toBeUndefined()
    expect(parseRecurring('00-10')).toBeUndefined()
  })

  it('rejects anything that is not one of the two forms', () => {
    expect(parseRecurring('14th March')).toBeUndefined()
    expect(parseRecurring('3-14')).toBeUndefined()
    expect(parseRecurring('')).toBeUndefined()
  })
})

describe('dayDiff', () => {
  it('counts forward', () => {
    expect(dayDiff('2026-08-22', '2026-08-30')).toBe(8)
  })

  it('is zero for the same day', () => {
    expect(dayDiff(TODAY, TODAY)).toBe(0)
  })

  it('counts backward as negative', () => {
    expect(dayDiff('2026-08-22', '2026-08-20')).toBe(-2)
  })

  it('crosses a year boundary', () => {
    expect(dayDiff('2026-12-31', '2027-01-01')).toBe(1)
  })

  it('counts a leap year correctly', () => {
    expect(dayDiff('2028-01-01', '2029-01-01')).toBe(366)
  })
})

describe('nextOccurrence', () => {
  it('finds a date later this year', () => {
    expect(nextOccurrence({ month: 8, day: 30 }, TODAY)).toEqual({ date: '2026-08-30', adjusted: false })
  })

  it('rolls into next year when the date has passed', () => {
    expect(nextOccurrence({ month: 3, day: 14 }, TODAY)).toEqual({ date: '2027-03-14', adjusted: false })
  })

  // Asking about a birthday on the morning it happens must not skip a year.
  it('counts today as the next occurrence', () => {
    expect(nextOccurrence({ month: 8, day: 22 }, TODAY)).toEqual({ date: '2026-08-22', adjusted: false })
  })

  it('marks a leap-day date on the 28th in a common year', () => {
    expect(nextOccurrence({ month: 2, day: 29 }, '2027-01-01')).toEqual({
      date: '2027-02-28',
      adjusted: true,
    })
  })

  it('uses the real date in a leap year, unadjusted', () => {
    expect(nextOccurrence({ month: 2, day: 29 }, '2028-01-01')).toEqual({
      date: '2028-02-29',
      adjusted: false,
    })
  })

  // The failure that would go unnoticed: a leap-day birthday must appear every
  // year, not one year in four.
  it('produces an occurrence for a leap-day date in every year', () => {
    for (let year = 2026; year <= 2033; year += 1) {
      const next = nextOccurrence({ month: 2, day: 29 }, `${year}-01-01`)
      expect(next.date.slice(0, 4)).toBe(String(year))
      expect(next.date.slice(5, 7)).toBe('02')
    }
  })
})

describe('birthdayOccasions', () => {
  it('finds the nearest birthday first', () => {
    const found = birthdayOccasions(FAMILY, TODAY)
    expect(found[0]?.name).toBe("Kit's birthday")
    expect(found[0]?.date).toBe('2026-08-30')
    expect(found[0]?.daysAway).toBe(8)
  })

  it('skips a member with no birthday recorded rather than guessing', () => {
    expect(birthdayOccasions(FAMILY, TODAY).some(entry => entry.name.startsWith('Robin'))).toBe(false)
  })

  it('works from a month-and-day birthday with no year', () => {
    const sam = birthdayOccasions(FAMILY, TODAY).find(entry => entry.id === 'birthday:sam')
    expect(sam?.date).toBe('2026-09-02')
    expect(sam?.ordinal).toBeUndefined()
  })

  it('reports the age being turned when the year is known', () => {
    const kit = birthdayOccasions(FAMILY, TODAY).find(entry => entry.id === 'birthday:kit')
    expect(kit?.ordinal).toBe(10)
  })

  it('rolls a birthday earlier in the year into next year', () => {
    const alex = birthdayOccasions(FAMILY, TODAY).find(entry => entry.id === 'birthday:alex')
    expect(alex?.date).toBe('2027-03-14')
    expect(alex?.ordinal).toBe(42)
  })

  it('gives every occasion a stable id', () => {
    const ids = birthdayOccasions(FAMILY, TODAY).map(entry => entry.id)
    expect(ids).toContain('birthday:kit')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('ignores a birthday that is not a date at all', () => {
    const found = birthdayOccasions([{ key: 'x', displayName: 'X', birthday: 'sometime in May' }], TODAY)
    expect(found).toEqual([])
  })

  it('does not claim an ordinal when the stored year is in the future', () => {
    const found = birthdayOccasions([{ key: 'x', displayName: 'X', birthday: '2030-01-05' }], TODAY)
    expect(found[0]?.ordinal).toBeUndefined()
  })
})

describe('householdOccasions', () => {
  const OCCASIONS: readonly HouseholdOccasion[] = [
    { id: 'wedding', name: 'Wedding anniversary', date: '2014-09-20' },
    { id: 'moved-in', name: 'The day we moved in', date: '10-01' },
  ]

  it('finds the next occurrence in date order', () => {
    const found = householdOccasions(OCCASIONS, TODAY)
    expect(found.map(entry => entry.id)).toEqual(['anniversary:wedding', 'anniversary:moved-in'])
  })

  it('counts the years being marked', () => {
    const wedding = householdOccasions(OCCASIONS, TODAY)[0]
    expect(wedding?.date).toBe('2026-09-20')
    expect(wedding?.ordinal).toBe(12)
  })

  it('carries no ordinal when no year was given', () => {
    const movedIn = householdOccasions(OCCASIONS, TODAY)[1]
    expect(movedIn?.ordinal).toBeUndefined()
  })

  it('reports the kind as an anniversary', () => {
    expect(householdOccasions(OCCASIONS, TODAY).every(entry => entry.kind === 'anniversary')).toBe(true)
  })
})

describe('upcomingOccasions', () => {
  const SOURCES = {
    people: FAMILY,
    occasions: [{ id: 'wedding', name: 'Wedding anniversary', date: '2014-09-20' }],
  }

  it('merges holidays, birthdays and anniversaries into one list in date order', () => {
    const found = upcomingOccasions(TODAY, 45, SOURCES)
    expect(found.map(entry => entry.id)).toEqual([
      'birthday:kit',       // 2026-08-30
      'birthday:sam',       // 2026-09-02
      'holiday:labor-day',  // 2026-09-07
      'anniversary:wedding',// 2026-09-20
    ])
  })

  it('excludes anything past the window', () => {
    const found = upcomingOccasions(TODAY, 10, SOURCES)
    expect(found.map(entry => entry.id)).toEqual(['birthday:kit'])
  })

  it('includes something falling exactly on the last day of the window', () => {
    const found = upcomingOccasions(TODAY, 8, SOURCES)
    expect(found.map(entry => entry.id)).toEqual(['birthday:kit'])
  })

  it('includes something happening today', () => {
    const found = upcomingOccasions('2026-08-30', 1, SOURCES)
    expect(found[0]?.id).toBe('birthday:kit')
    expect(found[0]?.daysAway).toBe(0)
  })

  it('can be asked to leave holidays out', () => {
    const found = upcomingOccasions(TODAY, 45, { ...SOURCES, holidays: false })
    expect(found.every(entry => entry.kind !== 'holiday')).toBe(true)
  })

  it('returns nothing rather than failing when the household is empty', () => {
    expect(upcomingOccasions(TODAY, 3, { holidays: false })).toEqual([])
  })

  it('marks a weekend-shifted holiday as adjusted', () => {
    // Independence Day 2026 is a Saturday, observed on the Friday.
    const found = upcomingOccasions('2026-07-01', 7, { holidays: true })
    const independence = found.find(entry => entry.id === 'holiday:independence-day')
    expect(independence?.date).toBe('2026-07-03')
    expect(independence?.adjusted).toBe(true)
  })

  it('never reports a negative distance', () => {
    const found = upcomingOccasions(TODAY, 400, SOURCES)
    expect(found.every(entry => entry.daysAway >= 0)).toBe(true)
  })

  it('orders by date with a stable tie-break', () => {
    const dates = upcomingOccasions(TODAY, 365, SOURCES).map(entry => entry.date)
    expect([...dates].sort()).toEqual(dates)
  })
})
