/**
 * The prose the family actually reads.
 *
 * These functions are the only part of the package a person sees, so they are
 * tested as writing rather than as data: an ordinal that says "12rd", or a break
 * line that buries the one fact worth acting on, is a real defect even though
 * nothing throws.
 */

import { describe, expect, it } from 'vitest'
import { bestBridge, breakLine, describeDistance, formatUpcoming, occasionLine, ordinalSuffix, plural } from '../src/index.ts'
import { breakAround } from '../src/breaks.ts'
import type { Occasion } from '../src/occasions.ts'

function occasion(overrides: Partial<Occasion> = {}): Occasion {
  return {
    kind: 'birthday',
    id: 'birthday:kit',
    name: "Kit's birthday",
    date: '2026-08-30',
    daysAway: 8,
    ...overrides,
  }
}

describe('ordinalSuffix', () => {
  it('handles the ordinary cases', () => {
    expect(ordinalSuffix(1)).toBe('1st')
    expect(ordinalSuffix(2)).toBe('2nd')
    expect(ordinalSuffix(3)).toBe('3rd')
    expect(ordinalSuffix(4)).toBe('4th')
  })

  // The classic off-by-one-language bug: 11, 12 and 13 do not follow 1, 2, 3.
  it('handles the teens, which do not follow the units rule', () => {
    expect(ordinalSuffix(11)).toBe('11th')
    expect(ordinalSuffix(12)).toBe('12th')
    expect(ordinalSuffix(13)).toBe('13th')
  })

  it('handles the twenties', () => {
    expect(ordinalSuffix(21)).toBe('21st')
    expect(ordinalSuffix(22)).toBe('22nd')
    expect(ordinalSuffix(23)).toBe('23rd')
  })

  it('handles a hundred and its teens', () => {
    expect(ordinalSuffix(100)).toBe('100th')
    expect(ordinalSuffix(111)).toBe('111th')
    expect(ordinalSuffix(121)).toBe('121st')
  })

  it('handles a fortieth birthday and a tenth anniversary', () => {
    expect(ordinalSuffix(40)).toBe('40th')
    expect(ordinalSuffix(10)).toBe('10th')
  })
})

describe('describeDistance', () => {
  it('says today and tomorrow rather than counting', () => {
    expect(describeDistance(0)).toBe('today')
    expect(describeDistance(1)).toBe('tomorrow')
  })

  it('counts days for the near future', () => {
    expect(describeDistance(8)).toBe('in 8 days')
  })

  it('switches to weeks once days stop being useful', () => {
    expect(describeDistance(21)).toBe('in 3 weeks')
  })

  it('switches to months further out', () => {
    expect(describeDistance(90)).toBe('in 3 months')
  })
})

describe('occasionLine', () => {
  it('names the occasion, the date, and how far off it is', () => {
    expect(occasionLine(occasion())).toBe("- Kit's birthday: 2026-08-30, in 8 days")
  })

  it('says which one it is when the year is known', () => {
    expect(occasionLine(occasion({ ordinal: 10 }))).toContain('(10th)')
  })

  it('says nothing about which one when the year is not known', () => {
    expect(occasionLine(occasion())).not.toContain('(')
  })

  it('marks an adjusted date as observed rather than pretending', () => {
    expect(occasionLine(occasion({ adjusted: true }))).toContain('observed')
  })
})

describe('plural', () => {
  it('does not say one days', () => {
    expect(plural(1, 'day')).toBe('1 day')
  })

  it('pluralises everything else', () => {
    expect(plural(0, 'day')).toBe('0 days')
    expect(plural(3, 'day')).toBe('3 days')
  })
})

describe('bestBridge', () => {
  // Thanksgiving is the textbook bridge: one day of leave reaches the weekend,
  // so the family gets two days they did not pay for.
  it('finds the bridge that gains days beyond the leave spent', () => {
    const bridge = bestBridge(breakAround('2026-11-26'))
    expect(bridge?.leave).toEqual(['2026-11-27'])
    expect(bridge?.days).toBe(4)
    expect(bridge?.bonus).toBe(2)
  })

  // The cheapest option here spends a day of leave to gain exactly that day,
  // which is not a bridge; two days reaches the weekend before.
  it('prefers a costlier option that actually gains something', () => {
    const entry = breakAround('2026-11-11')
    expect(entry.options[0]?.leave).toHaveLength(1)
    expect(entry.options[0]?.bonus).toBe(0)
    const bridge = bestBridge(entry)
    expect(bridge?.leave).toHaveLength(2)
    expect(bridge?.bonus).toBe(2)
  })

  // A holiday weekend already flush against the weekend has no bridge: taking
  // the Thursday off is just taking a day off, and the family knows that.
  it('finds nothing when leave would only buy itself', () => {
    expect(bestBridge(breakAround('2026-07-03'))).toBeUndefined()
    expect(bestBridge(breakAround('2026-09-07'))).toBeUndefined()
  })

  it('finds nothing for an ordinary weekend', () => {
    expect(bestBridge(breakAround('2026-08-22'))).toBeUndefined()
  })
})

describe('breakLine', () => {
  it('names the holiday, the length, and what leave would buy', () => {
    const line = breakLine(breakAround('2026-11-26'))
    expect(line).toContain('Thanksgiving')
    expect(line).toContain('1 day off')
    expect(line).toContain('makes it 4 days')
    expect(line).toContain('2026-11-27')
  })

  it('says nothing about leave when none of it would gain anything', () => {
    const line = breakLine(breakAround('2026-07-03'))
    expect(line).toBe('- Independence Day: 2026-07-03 to 2026-07-05, 3 days off')
  })

  it('spells out multiple leave days rather than just counting them', () => {
    const line = breakLine(breakAround('2026-11-11'))
    expect(line).toMatch(/2 days off \(2026-11-\d\d, 2026-11-\d\d\)/)
    expect(line).toContain('makes it 5 days')
  })

  it('never says one days', () => {
    for (const date of ['2026-11-26', '2026-11-11', '2026-01-01', '2026-07-03']) {
      expect(breakLine(breakAround(date))).not.toContain('1 days')
    }
  })

  it('describes a plain weekend without inventing a holiday name', () => {
    const line = breakLine(breakAround('2026-08-22'))
    expect(line).toContain('A long weekend')
    expect(line).toContain('2 days off')
  })

  it('omits the leave sentence when there are no options at all', () => {
    const line = breakLine({ start: '2026-08-22', end: '2026-08-23', days: 2, holidays: [], options: [] })
    expect(line).toBe('- A long weekend: 2026-08-22 to 2026-08-23, 2 days off')
  })
})

describe('formatUpcoming', () => {
  it('leads with the occasions, then the breaks', () => {
    const text = formatUpcoming([occasion()], [breakAround('2026-11-26')], 45)
    expect(text.indexOf('Coming up')).toBeLessThan(text.indexOf('Breaks worth planning'))
  })

  it('says plainly when there is nothing, rather than returning empty text', () => {
    const text = formatUpcoming([], [], 30)
    expect(text).toContain('Nothing notable in the next 30 days')
  })

  it('omits the breaks section entirely when there are none', () => {
    expect(formatUpcoming([occasion()], [], 45)).not.toContain('Breaks worth planning')
  })

  it('omits the occasions section entirely when there are none', () => {
    expect(formatUpcoming([], [breakAround('2026-11-26')], 45)).not.toContain('Coming up')
  })

  it('lists every occasion it is given', () => {
    const text = formatUpcoming(
      [occasion(), occasion({ id: 'birthday:sam', name: "Sam's birthday", date: '2026-09-02', daysAway: 11 })],
      [],
      45,
    )
    expect(text).toContain("Kit's birthday")
    expect(text).toContain("Sam's birthday")
  })
})
