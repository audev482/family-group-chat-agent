/**
 * Holiday arithmetic, checked against dates that can be looked up independently.
 *
 * The tests name real years on purpose. A rule engine that is self-consistent but
 * wrong is the failure mode here — `nthWeekdayOf` returning a plausible Monday
 * that is not actually Memorial Day would pass any test written by asking the
 * code what it thinks. So the expected values come from the calendar, not from
 * the implementation.
 *
 * Weekend observation gets the most attention because it is the part that decides
 * whether the family gets a long weekend, and because it is the part with an edge
 * case: the observed day can land in a different year.
 */

import { describe, expect, it } from 'vitest'
import {
  addDays,
  daysInMonth,
  federalHolidays,
  holidaysBetween,
  lastWeekdayOf,
  MONDAY,
  nthWeekdayOf,
  observedDate,
  SATURDAY,
  SUNDAY,
  THURSDAY,
  weekdayOf,
} from '../src/holidays.ts'

/** The holiday with this id in a given year, for readable assertions. */
function holiday(year: number, id: string) {
  const found = federalHolidays(year).find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no ${id} in ${year}`)
  return found
}

describe('weekdayOf', () => {
  it('reads the weekday of a known date', () => {
    // 2026-08-22 is a Saturday.
    expect(weekdayOf('2026-08-22')).toBe(SATURDAY)
  })

  it('reads a Sunday', () => {
    expect(weekdayOf('2026-08-23')).toBe(SUNDAY)
  })

  it('rejects a value that is not a calendar date', () => {
    expect(() => weekdayOf('next tuesday')).toThrow(/YYYY-MM-DD/)
  })
})

describe('daysInMonth', () => {
  it('knows the short months', () => {
    expect(daysInMonth(2026, 4)).toBe(30)
  })

  it('knows February in a common year', () => {
    expect(daysInMonth(2026, 2)).toBe(28)
  })

  it('knows February in a leap year', () => {
    expect(daysInMonth(2028, 2)).toBe(29)
  })

  // 2000 was a leap year and 1900 was not; a naive divisible-by-four rule gets
  // one of them wrong.
  it('gets the century rule right', () => {
    expect(daysInMonth(2000, 2)).toBe(29)
    expect(daysInMonth(1900, 2)).toBe(28)
  })
})

describe('nthWeekdayOf', () => {
  it('finds a first Monday that is the 1st of the month', () => {
    // 2026-06-01 is itself a Monday.
    expect(nthWeekdayOf(2026, 6, MONDAY, 1)).toBe('2026-06-01')
  })

  it('finds the third Monday in January 2026', () => {
    expect(nthWeekdayOf(2026, 1, MONDAY, 3)).toBe('2026-01-19')
  })

  it('finds the fourth Thursday in November 2026', () => {
    expect(nthWeekdayOf(2026, 11, THURSDAY, 4)).toBe('2026-11-26')
  })

  it('refuses to invent a fifth weekday the month does not have', () => {
    // February 2026 starts on a Sunday and has 28 days: exactly four Mondays.
    expect(() => nthWeekdayOf(2026, 2, MONDAY, 5)).toThrow(/no 5th weekday/)
  })
})

describe('lastWeekdayOf', () => {
  it('finds the last Monday in May 2026', () => {
    expect(lastWeekdayOf(2026, 5, MONDAY)).toBe('2026-05-25')
  })

  // The distinction that makes Memorial Day its own rule: May 2027 has five
  // Mondays, so "last" and "fourth" are different days.
  it('is not the same as the fourth when the month has five', () => {
    expect(lastWeekdayOf(2027, 5, MONDAY)).toBe('2027-05-31')
    expect(nthWeekdayOf(2027, 5, MONDAY, 4)).toBe('2027-05-24')
  })

  it('handles a last day that is itself the weekday', () => {
    expect(lastWeekdayOf(2027, 5, MONDAY)).toBe('2027-05-31')
  })
})

describe('observedDate', () => {
  it('leaves a weekday holiday alone', () => {
    // 2026-07-04 is a Saturday, so use a year where it is not: 2028-07-04 is a Tuesday.
    expect(observedDate('2028-07-04')).toEqual({ observed: '2028-07-04' })
  })

  it('moves a Saturday holiday back to the Friday', () => {
    expect(observedDate('2026-07-04')).toEqual({
      observed: '2026-07-03',
      shift: 'saturday-to-friday',
    })
  })

  it('moves a Sunday holiday forward to the Monday', () => {
    // 2027-07-04 is a Sunday.
    expect(observedDate('2027-07-04')).toEqual({
      observed: '2027-07-05',
      shift: 'sunday-to-monday',
    })
  })

  // The edge case: a Saturday New Year's Day is observed in the previous year.
  it('can move an observed date into the previous year', () => {
    // 2028-01-01 is a Saturday.
    expect(observedDate('2028-01-01')).toEqual({
      observed: '2027-12-31',
      shift: 'saturday-to-friday',
    })
  })
})

describe('federalHolidays', () => {
  it('returns the eleven current federal holidays', () => {
    expect(federalHolidays(2026)).toHaveLength(11)
  })

  it('places them in calendar order', () => {
    const dates = federalHolidays(2026).map(entry => entry.date)
    expect([...dates].sort()).toEqual(dates)
  })

  it('gets Thanksgiving 2026 right', () => {
    expect(holiday(2026, 'thanksgiving').date).toBe('2026-11-26')
  })

  it('gets Memorial Day 2026 right', () => {
    expect(holiday(2026, 'memorial-day').date).toBe('2026-05-25')
  })

  it('gets Labor Day 2026 right', () => {
    expect(holiday(2026, 'labor-day').date).toBe('2026-09-07')
  })

  it('gets Christmas right and needs no shift in 2026', () => {
    // 2026-12-25 is a Friday.
    const christmas = holiday(2026, 'christmas-day')
    expect(christmas.date).toBe('2026-12-25')
    expect(christmas.observed).toBe('2026-12-25')
    expect(christmas.shift).toBeUndefined()
  })

  it('reports the observed day separately when Independence Day is a Saturday', () => {
    const independence = holiday(2026, 'independence-day')
    expect(independence.date).toBe('2026-07-04')
    expect(independence.observed).toBe('2026-07-03')
    expect(independence.shift).toBe('saturday-to-friday')
  })

  it('omits Juneteenth before it was a federal holiday', () => {
    expect(federalHolidays(2020).some(entry => entry.id === 'juneteenth')).toBe(false)
    expect(federalHolidays(2021).some(entry => entry.id === 'juneteenth')).toBe(true)
  })

  it('keeps the weekday-rule holidays off the weekend, so they never shift', () => {
    for (const year of [2026, 2027, 2028, 2029, 2030]) {
      const ruleBased = federalHolidays(year).filter(entry => entry.shift === undefined)
      for (const entry of ruleBased) {
        expect(weekdayOf(entry.date)).not.toBe(SATURDAY)
        expect(weekdayOf(entry.date)).not.toBe(SUNDAY)
      }
    }
  })

  it('never observes a holiday on a weekend, in any year it will be asked about', () => {
    for (let year = 2026; year <= 2040; year += 1) {
      for (const entry of federalHolidays(year)) {
        const weekday = weekdayOf(entry.observed)
        expect(weekday).not.toBe(SATURDAY)
        expect(weekday).not.toBe(SUNDAY)
      }
    }
  })
})

describe('holidaysBetween', () => {
  it('finds a holiday inside the range', () => {
    const found = holidaysBetween('2026-11-01', '2026-11-30')
    expect(found.map(entry => entry.id)).toEqual(['veterans-day', 'thanksgiving'])
  })

  it('excludes a holiday outside the range', () => {
    expect(holidaysBetween('2026-08-01', '2026-08-31')).toEqual([])
  })

  it('includes a holiday observed on the first day of the range', () => {
    expect(holidaysBetween('2026-11-26', '2026-11-30').map(entry => entry.id)).toEqual(['thanksgiving'])
  })

  it('includes a holiday observed on the last day of the range', () => {
    expect(holidaysBetween('2026-11-01', '2026-11-11').map(entry => entry.id)).toEqual(['veterans-day'])
  })

  // The reason the scan covers neighbouring years: this range contains no
  // statutory holiday from 2027, but it does contain a day off.
  it('finds a New Years Day observed in the previous year', () => {
    const found = holidaysBetween('2027-12-28', '2027-12-31')
    expect(found.map(entry => entry.id)).toEqual(['new-years-day'])
    expect(found[0]?.date).toBe('2028-01-01')
    expect(found[0]?.observed).toBe('2027-12-31')
  })

  it('spans a year boundary', () => {
    const found = holidaysBetween('2026-12-20', '2027-01-05')
    expect(found.map(entry => entry.id)).toEqual(['christmas-day', 'new-years-day'])
  })

  it('orders by the observed date, not the statutory one', () => {
    const observed = holidaysBetween('2026-01-01', '2028-12-31').map(entry => entry.observed)
    expect([...observed].sort()).toEqual(observed)
  })
})

describe('addDays', () => {
  it('crosses a month boundary', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
  })

  it('goes backwards across a year boundary', () => {
    expect(addDays('2027-01-01', -1)).toBe('2026-12-31')
  })

  it('crosses a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
    expect(addDays('2028-02-29', 1)).toBe('2028-03-01')
  })

  it('rejects a value that is not a calendar date', () => {
    expect(() => addDays('tomorrow', 1)).toThrow(/YYYY-MM-DD/)
  })
})
