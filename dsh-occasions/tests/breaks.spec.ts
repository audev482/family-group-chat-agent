/**
 * Break and bridge-day arithmetic.
 *
 * The scenarios are named by weekday because that is what determines the answer,
 * and the expected spans are worked out from the calendar rather than from the
 * implementation. A bridge search that quietly suggests leave the family already
 * has off, or claims a four-day weekend that is really three, is the failure this
 * covers.
 */

import { describe, expect, it } from 'vitest'
import { breakAround, breaksBetween, notableBreaks } from '../src/breaks.ts'

describe('breakAround', () => {
  // 2026-08-22 is a Saturday with no holiday near it.
  it('describes an ordinary weekend as two days', () => {
    const span = breakAround('2026-08-22')
    expect(span.start).toBe('2026-08-22')
    expect(span.end).toBe('2026-08-23')
    expect(span.days).toBe(2)
    expect(span.holidays).toEqual([])
  })

  it('reports no break at all on a working day', () => {
    // 2026-08-19 is a Wednesday.
    const span = breakAround('2026-08-19')
    expect(span.days).toBe(0)
    expect(span.options).toEqual([])
  })

  // Independence Day 2026 is a Saturday, observed on Friday the 3rd, so the
  // break runs Friday to Sunday: the three-day weekend.
  it('finds the three-day weekend when a holiday is observed on a Friday', () => {
    const span = breakAround('2026-07-03')
    expect(span.start).toBe('2026-07-03')
    expect(span.end).toBe('2026-07-05')
    expect(span.days).toBe(3)
    expect(span.holidays.map(entry => entry.id)).toEqual(['independence-day'])
  })

  it('offers one day of leave to turn that into four', () => {
    const span = breakAround('2026-07-03')
    const cheapest = span.options[0]
    expect(cheapest?.leave).toHaveLength(1)
    expect(cheapest?.days).toBe(4)
    // Either side buys the same four days, so the tie is broken toward starting
    // the break earlier — the Thursday before.
    expect(cheapest?.leave).toEqual(['2026-07-02'])
    expect(cheapest?.start).toBe('2026-07-02')
    expect(cheapest?.end).toBe('2026-07-05')
  })

  // Labor Day is always a Monday, so the break is Saturday to Monday. The
  // Friday before and the Tuesday after both buy a fourth day, and the tie goes
  // to the earlier one: start the break sooner, which also suits travelling.
  it('bridges a Monday holiday with the Friday before it', () => {
    const span = breakAround('2026-09-07')
    expect(span.days).toBe(3)
    expect(span.start).toBe('2026-09-05')
    const cheapest = span.options[0]
    expect(cheapest?.leave).toEqual(['2026-09-04'])
    expect(cheapest?.days).toBe(4)
    expect(cheapest?.start).toBe('2026-09-04')
    expect(cheapest?.end).toBe('2026-09-07')
  })

  // Thanksgiving is a Thursday: the Friday is the classic single bridge day, and
  // it reaches all the way to Sunday.
  it('turns Thanksgiving into a four-day weekend with one day of leave', () => {
    const span = breakAround('2026-11-26')
    expect(span.days).toBe(1)
    const cheapest = span.options[0]
    expect(cheapest?.leave).toEqual(['2026-11-27'])
    expect(cheapest?.days).toBe(4)
    expect(cheapest?.end).toBe('2026-11-29')
  })

  // A midweek holiday needs bridging in both directions at once, and neither
  // side alone reaches a weekend.
  it('bridges both directions around a Wednesday holiday', () => {
    // 2026-06-19 (Juneteenth) is a Friday, so use Veterans Day: 2026-11-11 is a Wednesday.
    const span = breakAround('2026-11-11')
    expect(span.days).toBe(1)
    const twoDays = span.options.find(option => option.leave.length === 2)
    expect(twoDays?.days).toBe(5)
    // Monday and Tuesday reach the weekend before; Thursday and Friday reach the
    // one after. Both buy five days, and the tie goes to the earlier pair.
    expect(twoDays?.leave).toEqual(['2026-11-09', '2026-11-10'])
    expect(twoDays?.start).toBe('2026-11-07')
    expect(twoDays?.end).toBe('2026-11-11')
  })

  it('never suggests leave on a day that is already off', () => {
    for (const date of ['2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']) {
      const span = breakAround(date)
      for (const option of span.options) {
        for (const day of option.leave) {
          expect(day < span.start || day > span.end).toBe(true)
        }
      }
    }
  })

  it('offers options in ascending cost, each buying more than the last', () => {
    const span = breakAround('2026-12-25')
    const costs = span.options.map(option => option.leave.length)
    expect([...costs].sort((a, b) => a - b)).toEqual(costs)
    const spans = span.options.map(option => option.days)
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]!).toBeGreaterThan(spans[index - 1]!)
    }
  })

  // A bridge buys more than it costs — that is the entire point. Leave spent
  // next to a break also picks up whatever days off lie beyond it, so the
  // resulting span is at least the break plus the leave, and usually more.
  it('never reports a span smaller than the break plus the leave spent', () => {
    for (const date of ['2026-07-03', '2026-09-07', '2026-11-26', '2026-11-11']) {
      const span = breakAround(date)
      for (const option of span.options) {
        expect(option.days).toBeGreaterThanOrEqual(span.days + option.leave.length)
      }
    }
  })

  it('buys strictly more than it costs when bridging to a weekend', () => {
    // Thanksgiving is one day off; one day of leave reaches the weekend, so the
    // family gets four days for one.
    const span = breakAround('2026-11-26')
    const cheapest = span.options[0]
    expect(cheapest?.days).toBeGreaterThan(span.days + cheapest!.leave.length)
  })

  // The bonus is what separates a bridge from simply taking a day off, so it
  // must agree with the spans it is derived from rather than drifting.
  it('reports a bonus consistent with the spans', () => {
    for (const date of ['2026-07-03', '2026-09-07', '2026-11-26', '2026-11-11', '2026-01-01']) {
      const span = breakAround(date)
      for (const option of span.options) {
        expect(option.bonus).toBe(option.days - span.days - option.leave.length)
        expect(option.bonus).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('reports no bonus where the break already meets the weekend on both sides', () => {
    // Independence Day 2026 is observed Friday, so Friday to Sunday is already
    // maximal: any leave buys only itself.
    expect(breakAround('2026-07-03').options.every(option => option.bonus === 0)).toBe(true)
  })

  it('respects a household that does not work Fridays', () => {
    // With Friday already off, an ordinary weekend is three days long.
    const span = breakAround('2026-08-22', { workdays: [1, 2, 3, 4] })
    expect(span.start).toBe('2026-08-21')
    expect(span.days).toBe(3)
  })

  it('honours a tighter leave budget', () => {
    const span = breakAround('2026-11-11', { maxLeave: 1 })
    expect(span.options.every(option => option.leave.length <= 1)).toBe(true)
  })

  it('offers no leave at all when there is no break to extend', () => {
    expect(breakAround('2026-08-19').options).toEqual([])
  })

  it('finds no worthwhile leave for an ordinary weekend within one day', () => {
    // One day either side of a plain weekend only makes three days, which is an
    // improvement, so it is offered — but it must never claim more than that.
    const span = breakAround('2026-08-22', { maxLeave: 1 })
    expect(span.options.every(option => option.days === 3)).toBe(true)
  })
})

describe('breaksBetween', () => {
  it('reports each break once, however many of its days fall in the range', () => {
    const found = breaksBetween('2026-08-01', '2026-08-31')
    const starts = found.map(entry => entry.start)
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('finds the weekends in a quiet month', () => {
    // August 2026 has five weekends, the first starting Saturday the 1st.
    const found = breaksBetween('2026-08-01', '2026-08-31')
    expect(found[0]?.start).toBe('2026-08-01')
    expect(found.every(entry => entry.days === 2)).toBe(true)
  })

  it('returns breaks in calendar order', () => {
    const starts = breaksBetween('2026-06-01', '2026-12-31').map(entry => entry.start)
    expect([...starts].sort()).toEqual(starts)
  })

  it('reports a break whole even when it straddles the end of the range', () => {
    // The range ends mid-weekend; the break should still show both days.
    const found = breaksBetween('2026-08-17', '2026-08-22')
    const weekend = found.find(entry => entry.start === '2026-08-22')
    expect(weekend?.end).toBe('2026-08-23')
    expect(weekend?.days).toBe(2)
  })
})

describe('notableBreaks', () => {
  it('says nothing about a month of ordinary weekends', () => {
    expect(notableBreaks('2026-08-01', '2026-08-31')).toEqual([])
  })

  it('picks out the holiday weekend', () => {
    const found = notableBreaks('2026-07-01', '2026-07-31')
    expect(found).toHaveLength(1)
    expect(found[0]?.holidays.map(entry => entry.id)).toEqual(['independence-day'])
    expect(found[0]?.days).toBe(3)
  })

  it('picks out Thanksgiving even though the holiday itself is one day', () => {
    const found = notableBreaks('2026-11-20', '2026-11-30')
    expect(found.some(entry => entry.holidays.some(holiday => holiday.id === 'thanksgiving'))).toBe(true)
  })

  // The weekend after a Thursday holiday is a separate break whose bridge day
  // reaches back to that holiday, so an earlier version announced Thanksgiving
  // twice: once as the Thursday and again as the weekend after it. One
  // opportunity must produce one conversation.
  it('reports a Thursday holiday once, not again as the weekend after it', () => {
    const found = notableBreaks('2026-11-20', '2026-12-05')
    expect(found).toHaveLength(1)
    expect(found[0]?.start).toBe('2026-11-26')
  })

  it('does not report the weekend after New Years Day as its own opportunity', () => {
    const found = notableBreaks('2026-01-01', '2026-01-10')
    expect(found).toHaveLength(1)
    expect(found[0]?.holidays.map(entry => entry.id)).toEqual(['new-years-day'])
  })

  it('finds every holiday break in a year and no ordinary weekends', () => {
    const found = notableBreaks('2026-01-01', '2026-12-31')
    expect(found.every(entry => entry.holidays.length > 0)).toBe(true)
    // All eleven holidays land in some notable break; Christmas and New Year's
    // observed days can share one, so the count of breaks is lower.
    const ids = new Set(found.flatMap(entry => entry.holidays.map(holiday => holiday.id)))
    expect(ids.size).toBe(11)
  })
})
