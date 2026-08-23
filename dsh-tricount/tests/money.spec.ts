/**
 * Money arithmetic: the invariants a shared ledger cannot violate.
 *
 * Two of these tests encode bugs that exist in the Python CLI this package
 * replaces, and they are the reason the module is written in integer minor units
 * rather than floats:
 *
 *   * `round(100.00 / 3)` three times sums to 99.99, so the allocations of an entry
 *     no longer add up to the entry, and the ledger's own arithmetic stops closing.
 *   * `parseFloat('54.20') * 100` is 5419.999999999999, so truncating it loses a cent
 *     on an amount a person typed exactly.
 *
 * The central property is stated once and then checked across a range of awkward
 * amounts and splits: a split always sums to exactly what was split.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPONENT,
  MoneyError,
  exponentOf,
  formatMinor,
  formatMoney,
  gcd,
  parseMinor,
  reduceToParts,
  requireHundred,
  round2,
  splitByRatio,
} from '../src/money.ts'

describe('exponentOf', () => {
  it('gives most currencies two decimals', () => {
    expect(exponentOf('USD')).toBe(2)
    expect(exponentOf('EUR')).toBe(2)
    expect(DEFAULT_EXPONENT).toBe(2)
  })

  // 1500 JPY is fifteen hundred yen, not fifteen. Treating it as two-decimal is a
  // hundredfold error, and worse, splits it into a unit that does not exist.
  it('knows the currencies with no decimals', () => {
    expect(exponentOf('JPY')).toBe(0)
    expect(exponentOf('KRW')).toBe(0)
    expect(exponentOf('VND')).toBe(0)
  })

  it('knows the currencies with three', () => {
    expect(exponentOf('KWD')).toBe(3)
    expect(exponentOf('BHD')).toBe(3)
  })

  it('is case and space insensitive', () => {
    expect(exponentOf(' jpy ')).toBe(0)
  })

  // A ledger in a currency this table has not heard of should still be readable.
  it('assumes two decimals for anything unknown', () => {
    expect(exponentOf('ZZZ')).toBe(2)
  })
})

describe('parseMinor', () => {
  it('reads a plain amount', () => {
    expect(parseMinor('54.20', 'USD')).toBe(5420)
  })

  // parseFloat('54.20') * 100 is 5419.999999999999. Parsing the digits avoids it.
  it('does not lose a cent to binary floating point', () => {
    for (const text of ['54.20', '0.07', '1.10', '2.30', '8.29', '1234.56', '0.29']) {
      const minor = parseMinor(text, 'USD')
      expect(minor).toBe(Math.round(Number(text) * 100))
      expect(Number.isInteger(minor)).toBe(true)
    }
  })

  it('reads a negative amount', () => {
    expect(parseMinor('-38.04', 'USD')).toBe(-3804)
  })

  it('accepts an explicit plus', () => {
    expect(parseMinor('+38.04', 'USD')).toBe(3804)
  })

  it('pads a short fraction', () => {
    expect(parseMinor('5.5', 'USD')).toBe(550)
  })

  it('reads a whole number with no point', () => {
    expect(parseMinor('40', 'USD')).toBe(4000)
  })

  it('reads a zero-decimal currency as whole units', () => {
    expect(parseMinor('1500', 'JPY')).toBe(1500)
  })

  it('reads a three-decimal currency', () => {
    expect(parseMinor('1.234', 'KWD')).toBe(1234)
  })

  it('accepts a leading point', () => {
    expect(parseMinor('.50', 'USD')).toBe(50)
  })

  it('accepts a trailing point', () => {
    expect(parseMinor('50.', 'USD')).toBe(5000)
  })

  it('reads zero', () => {
    expect(parseMinor('0', 'USD')).toBe(0)
    expect(parseMinor('0.00', 'USD')).toBe(0)
  })

  // A third of a cent in an expense means somebody misunderstood something.
  // Rounding it away silently would hide that.
  it('refuses more precision than the currency has', () => {
    expect(() => parseMinor('1.005', 'USD')).toThrow(MoneyError)
    expect(() => parseMinor('1500.5', 'JPY')).toThrow(/whole JPY/)
  })

  it('refuses text that is not a number', () => {
    for (const bad of ['', ' ', 'ten', '1,234.00', '$5.00', '1.2.3', '--5', '5-']) {
      expect(() => parseMinor(bad, 'USD'), bad).toThrow(MoneyError)
    }
  })

  it('refuses an amount too large to be exact', () => {
    expect(() => parseMinor('99999999999999999999', 'USD')).toThrow(/too large/)
  })
})

describe('formatMinor', () => {
  it('writes a plain amount', () => {
    expect(formatMinor(5420, 'USD')).toBe('54.20')
  })

  it('writes a negative amount', () => {
    expect(formatMinor(-3804, 'USD')).toBe('-38.04')
  })

  it('pads amounts below one unit', () => {
    expect(formatMinor(7, 'USD')).toBe('0.07')
    expect(formatMinor(-7, 'USD')).toBe('-0.07')
  })

  it('writes zero', () => {
    expect(formatMinor(0, 'USD')).toBe('0.00')
  })

  it('writes a zero-decimal currency with no point', () => {
    expect(formatMinor(1500, 'JPY')).toBe('1500')
  })

  it('writes a three-decimal currency', () => {
    expect(formatMinor(1234, 'KWD')).toBe('1.234')
  })

  it('round-trips every amount it can parse', () => {
    for (const text of ['54.20', '-38.04', '0.07', '0.00', '1234.56', '999999.99']) {
      expect(formatMinor(parseMinor(text, 'USD'), 'USD')).toBe(text === '0.00' ? '0.00' : text)
    }
  })

  it('round-trips zero-decimal currencies', () => {
    expect(formatMinor(parseMinor('1500', 'JPY'), 'JPY')).toBe('1500')
  })
})

describe('formatMoney', () => {
  it('uses a symbol when there is one', () => {
    expect(formatMoney({ minor: 5420, currency: 'USD' })).toBe('$54.20')
    expect(formatMoney({ minor: 1200, currency: 'EUR' })).toBe('€12.00')
    expect(formatMoney({ minor: 1500, currency: 'JPY' })).toBe('¥1500')
  })

  it('falls back to the code when there is no symbol', () => {
    expect(formatMoney({ minor: 5420, currency: 'CHF' })).toBe('54.20 CHF')
  })

  // The minus belongs outside the symbol: -$5.00, not $-5.00.
  it('puts the sign before the symbol', () => {
    expect(formatMoney({ minor: -500, currency: 'USD' })).toBe('-$5.00')
  })
})

describe('splitByRatio', () => {
  // The property the whole module exists for.
  it('always sums to exactly what was split', () => {
    const amounts = [1, 7, 99, 100, 101, 3333, 10000, 12345, 999999, 100000001]
    const splits = [[1], [1, 1], [1, 2], [1, 1, 1], [2, 1, 1], [1, 1, 1, 1, 1], [3, 2], [7, 11, 13], [1, 999]]
    for (const amount of amounts) {
      for (const weights of splits) {
        const shares = splitByRatio(amount, weights.map((ratio, i) => ({ key: `m${i}`, ratio })))
        const sum = shares.reduce((run, share) => run + share.minor, 0)
        expect(sum, `${amount} by ${weights.join('/')}`).toBe(amount)
      }
    }
  })

  // The CLI's per-share rounding gives 33.33 three times = 99.99, losing a cent.
  it('loses no cent splitting 100.00 three ways', () => {
    const shares = splitByRatio(10000, [
      { key: 'alex', ratio: 1 }, { key: 'sam', ratio: 1 }, { key: 'kit', ratio: 1 },
    ])
    expect(shares.map(s => s.minor)).toEqual([3334, 3333, 3333])
    expect(shares.reduce((r, s) => r + s.minor, 0)).toBe(10000)
  })

  it('splits evenly when it divides evenly', () => {
    const shares = splitByRatio(5000, [{ key: 'alex', ratio: 1 }, { key: 'sam', ratio: 1 }])
    expect(shares.map(s => s.minor)).toEqual([2500, 2500])
  })

  it('honours unequal weights', () => {
    const shares = splitByRatio(10000, [{ key: 'alex', ratio: 3 }, { key: 'sam', ratio: 2 }])
    expect(shares.map(s => s.minor)).toEqual([6000, 4000])
  })

  it('gives one member the whole amount', () => {
    expect(splitByRatio(4200, [{ key: 'alex', ratio: 1 }]).map(s => s.minor)).toEqual([4200])
  })

  it('preserves a negative sign, and still sums exactly', () => {
    const shares = splitByRatio(-10000, [
      { key: 'alex', ratio: 1 }, { key: 'sam', ratio: 1 }, { key: 'kit', ratio: 1 },
    ])
    expect(shares.map(s => s.minor)).toEqual([-3334, -3333, -3333])
    expect(shares.reduce((r, s) => r + s.minor, 0)).toBe(-10000)
  })

  // Determinism matters: re-filing an entry must not silently move a cent between
  // two people, so ties go to the earlier member rather than to whoever hashes first.
  it('breaks ties towards the member given first', () => {
    const once = splitByRatio(10, [{ key: 'a', ratio: 1 }, { key: 'b', ratio: 1 }, { key: 'c', ratio: 1 }])
    const again = splitByRatio(10, [{ key: 'a', ratio: 1 }, { key: 'b', ratio: 1 }, { key: 'c', ratio: 1 }])
    expect(once.map(s => s.minor)).toEqual([4, 3, 3])
    expect(again.map(s => s.minor)).toEqual(once.map(s => s.minor))
  })

  it('gives the odd unit to the larger share, not the earlier one', () => {
    const shares = splitByRatio(101, [{ key: 'small', ratio: 1 }, { key: 'large', ratio: 99 }])
    expect(shares.map(s => s.minor)).toEqual([1, 100])
  })

  it('keeps the members in the order given', () => {
    const shares = splitByRatio(300, [{ key: 'zoe', ratio: 1 }, { key: 'alex', ratio: 1 }])
    expect(shares.map(s => s.key)).toEqual(['zoe', 'alex'])
  })

  it('reports the ratio it used', () => {
    expect(splitByRatio(300, [{ key: 'a', ratio: 2 }, { key: 'b', ratio: 1 }]).map(s => s.ratio)).toEqual([2, 1])
  })

  it('splits zero into zeroes', () => {
    expect(splitByRatio(0, [{ key: 'a', ratio: 1 }, { key: 'b', ratio: 1 }]).map(s => s.minor)).toEqual([0, 0])
  })

  it('refuses a split with nobody in it', () => {
    expect(() => splitByRatio(100, [])).toThrow(MoneyError)
  })

  it('refuses a zero or negative share', () => {
    expect(() => splitByRatio(100, [{ key: 'a', ratio: 0 }])).toThrow(/must be positive/)
    expect(() => splitByRatio(100, [{ key: 'a', ratio: -1 }])).toThrow(/must be positive/)
  })

  it('refuses a share that is not a number', () => {
    expect(() => splitByRatio(100, [{ key: 'a', ratio: Number.NaN }])).toThrow(MoneyError)
  })
})

describe('reduceToParts', () => {
  it('reduces a sixty forty split to three parts against two', () => {
    expect(reduceToParts([{ key: 'alex', percent: 60 }, { key: 'sam', percent: 40 }]))
      .toEqual([{ key: 'alex', parts: 3 }, { key: 'sam', parts: 2 }])
  })

  it('reduces an even split to one each', () => {
    expect(reduceToParts([{ key: 'alex', percent: 50 }, { key: 'sam', percent: 50 }]))
      .toEqual([{ key: 'alex', parts: 1 }, { key: 'sam', parts: 1 }])
  })

  it('reduces three equal shares to one each', () => {
    expect(reduceToParts([
      { key: 'a', percent: 33.34 }, { key: 'b', percent: 33.33 }, { key: 'c', percent: 33.33 },
    ]).map(p => p.parts)).toEqual([3334, 3333, 3333])
  })

  it('keeps proportions when the percentages do not total 100', () => {
    expect(reduceToParts([{ key: 'a', percent: 2 }, { key: 'b', percent: 1 }]).map(p => p.parts)).toEqual([2, 1])
  })

  it('handles fractional percentages', () => {
    expect(reduceToParts([{ key: 'a', percent: 62.5 }, { key: 'b', percent: 37.5 }]).map(p => p.parts)).toEqual([5, 3])
  })

  it('keeps the order given', () => {
    expect(reduceToParts([{ key: 'zoe', percent: 50 }, { key: 'alex', percent: 50 }]).map(p => p.key))
      .toEqual(['zoe', 'alex'])
  })

  it('refuses an empty split', () => {
    expect(() => reduceToParts([])).toThrow(MoneyError)
  })

  it('refuses a zero or negative percentage', () => {
    expect(() => reduceToParts([{ key: 'a', percent: 0 }])).toThrow(/more than zero/)
    expect(() => reduceToParts([{ key: 'a', percent: -5 }])).toThrow(/more than zero/)
  })

  // Parts feed splitByRatio, so the two together must still be exact.
  it('produces parts that split an amount exactly', () => {
    const parts = reduceToParts([{ key: 'a', percent: 33.34 }, { key: 'b', percent: 33.33 }, { key: 'c', percent: 33.33 }])
    const shares = splitByRatio(10000, parts.map(p => ({ key: p.key, ratio: p.parts })))
    expect(shares.reduce((r, s) => r + s.minor, 0)).toBe(10000)
  })
})

describe('gcd', () => {
  it('finds the common divisor', () => {
    expect(gcd(6000, 4000)).toBe(2000)
    expect(gcd(3, 2)).toBe(1)
    expect(gcd(12, 18)).toBe(6)
  })

  it('treats zero as the identity, so a fold can start there', () => {
    expect(gcd(0, 5)).toBe(5)
    expect(gcd(5, 0)).toBe(5)
  })
})

describe('requireHundred', () => {
  it('accepts a split that totals a hundred', () => {
    expect(requireHundred([60, 40])).toBe(100)
  })

  // Thirds cannot be written exactly as percentages, and this is what a person types.
  it('accepts thirds within tolerance', () => {
    expect(requireHundred([33.34, 33.33, 33.33])).toBeCloseTo(100)
  })

  it('rejects a split that does not total a hundred, naming the total', () => {
    expect(() => requireHundred([60, 30])).toThrow(/90%, not 100%/)
  })

  it('rejects a split that totals more than a hundred', () => {
    expect(() => requireHundred([60, 60])).toThrow(/120%/)
  })
})

describe('round2', () => {
  it('rounds to two decimals for display', () => {
    expect(round2(33.333333)).toBe(33.33)
    expect(round2(100.005)).toBe(100.01)
  })
})
