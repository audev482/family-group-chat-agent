/**
 * Money, as whole numbers of the smallest unit the currency has.
 *
 * This module exists because the ledger is about money and JavaScript numbers are
 * not. `0.1 + 0.2` is not `0.3`, and a shared expense ledger is precisely the place
 * where a hundredth of a unit accumulating over hundreds of entries turns into two
 * people disagreeing about what they owe each other. So nothing here holds a
 * fractional amount: amounts are integers of minor units — cents for dollars, yen
 * for yen — and the only floating point in the package is at the edges, where a
 * human types `54.20` and where the API is handed a decimal string.
 *
 * The other reason is splitting. An amount divided among members almost never
 * divides evenly, and the obvious implementation — round each share independently —
 * silently loses or invents money:
 *
 *     round(100.00 / 3) * 3  =  33.33 * 3  =  99.99
 *
 * That single missing cent means the allocations no longer sum to the entry total,
 * and the ledger's own arithmetic stops closing. {@link splitByRatio} distributes
 * the remainder instead of discarding it, so a split always sums to exactly the
 * amount that was split.
 *
 * @module
 */

/**
 * How many decimal places a currency has.
 *
 * Almost every currency has two, but not all, and the exceptions are common enough
 * to matter: a yen amount of `1500` is fifteen hundred yen, not fifteen. Getting
 * this wrong is a hundredfold error in the display and, worse, a split that rounds
 * to a unit that does not exist. Only the exceptions are listed; two is the default.
 *
 * @see https://en.wikipedia.org/wiki/ISO_4217
 */
const CURRENCY_EXPONENTS: Readonly<Record<string, number>> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
}

/** Decimal places for most currencies, and for any this module has not heard of. */
export const DEFAULT_EXPONENT = 2

/**
 * Decimal places in a currency's minor unit.
 *
 * An unknown code gets {@link DEFAULT_EXPONENT} rather than an error: a ledger in a
 * currency this table has never heard of should still be readable, and two decimals
 * is right far more often than it is wrong.
 *
 * @param currency - ISO 4217 code, case-insensitive.
 * @returns the number of decimal places.
 */
export function exponentOf(currency: string): number {
  return CURRENCY_EXPONENTS[currency.trim().toUpperCase()] ?? DEFAULT_EXPONENT
}

/** A quantity of money: whole minor units, plus the currency they are units of. */
export interface Money {
  /** Signed, in minor units. Negative for an expense, as the API stores it. */
  readonly minor: number
  /** ISO 4217 code. */
  readonly currency: string
}

/** Thrown when a string cannot be read as an amount of money. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MoneyError'
  }
}

/**
 * Read a decimal string into whole minor units.
 *
 * The parse is done on the digits rather than by multiplying a parsed float,
 * because `parseFloat('54.20') * 100` is `5419.999999999999` and truncating that
 * loses a cent — the exact failure this module exists to prevent. Working from the
 * text means `'54.20'` becomes `5420` by construction.
 *
 * More decimal places than the currency has is an error rather than a silent round:
 * a third of a cent in an expense means somebody has misunderstood something, and
 * quietly discarding it would hide that.
 *
 * @param text - a decimal number, optionally signed. Grouping separators are not accepted.
 * @param currency - decides how many decimal places are allowed.
 * @returns the amount in minor units.
 * @throws MoneyError if the text is not a plain decimal, or has too many decimals.
 */
export function parseMinor(text: string, currency: string): number {
  const trimmed = text.trim()
  const match = /^(?<sign>[-+]?)(?<whole>\d*)(?:\.(?<fraction>\d*))?$/.exec(trimmed)
  if (match?.groups === undefined || (match.groups['whole'] === '' && (match.groups['fraction'] ?? '') === '')) {
    throw new MoneyError(`"${text}" is not an amount of money`)
  }
  const { sign, whole, fraction = '' } = match.groups as { sign: string; whole: string; fraction?: string }
  const exponent = exponentOf(currency)
  if (fraction.length > exponent) {
    const unit = exponent === 0 ? `whole ${currency.toUpperCase()}` : `${exponent} decimal places`
    throw new MoneyError(`"${text}" is more precise than ${currency.toUpperCase()} allows (${unit})`)
  }
  const padded = fraction.padEnd(exponent, '0')
  const minor = Number(`${whole === '' ? '0' : whole}${padded}`)
  if (!Number.isSafeInteger(minor)) throw new MoneyError(`"${text}" is too large to be an amount of money`)
  return sign === '-' ? -minor : minor
}

/**
 * Write whole minor units as the decimal string the API expects.
 *
 * @param minor - signed minor units.
 * @param currency - decides the number of decimal places emitted.
 * @returns a plain decimal string, e.g. `-54.20`. Zero-decimal currencies get no point.
 */
export function formatMinor(minor: number, currency: string): string {
  const exponent = exponentOf(currency)
  const sign = minor < 0 ? '-' : ''
  const digits = Math.abs(Math.trunc(minor)).toString().padStart(exponent + 1, '0')
  if (exponent === 0) return `${sign}${digits}`
  return `${sign}${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`
}

/**
 * Format an amount for a person to read, with its currency.
 *
 * @param money - the amount.
 * @returns e.g. `$54.20`, `€12.00`, `¥1500`, or `54.20 CHF` when the code has no symbol.
 */
export function formatMoney(money: Money): string {
  const code = money.currency.trim().toUpperCase()
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£', JPY: '¥', CAD: 'C$', AUD: 'A$' }
  const symbol = symbols[code]
  const digits = formatMinor(Math.abs(money.minor), code)
  const sign = money.minor < 0 ? '-' : ''
  return symbol !== undefined ? `${sign}${symbol}${digits}` : `${sign}${digits} ${code}`
}

/** One member's share of a split. */
export interface Share {
  /** Whatever key the caller used to identify the member. */
  readonly key: string
  /** This member's part of the whole, as a relative weight. */
  readonly ratio: number
  /** This member's amount, in minor units. Always sums with its siblings to the total. */
  readonly minor: number
}

/**
 * Divide an amount by relative weights so the parts sum to exactly the whole.
 *
 * Each share gets the floor of its exact value, which leaves a remainder of at most
 * one minor unit per member. Those units go to the members whose exact shares had
 * the largest fractional parts — the largest-remainder method — so the money that
 * is unavoidably indivisible lands where it was most nearly earned rather than
 * being dropped.
 *
 * Ties are broken by the order the members were given, which makes the result
 * deterministic: the same call twice produces the same split, so re-filing an entry
 * cannot silently move a cent. The alternative, distributing ties arbitrarily,
 * would make the function's output depend on hash ordering.
 *
 * @param minor - the total to divide, in minor units. May be negative; the sign is preserved.
 * @param weights - relative parts per member. Must be positive and total more than zero.
 * @returns one {@link Share} per member, in the order given, summing to `minor`.
 * @throws MoneyError if there are no members, or a weight is not a positive finite number.
 */
export function splitByRatio(minor: number, weights: readonly { key: string; ratio: number }[]): Share[] {
  if (weights.length === 0) throw new MoneyError('a split needs at least one member')
  for (const weight of weights) {
    if (!Number.isFinite(weight.ratio) || weight.ratio <= 0) {
      throw new MoneyError(`"${weight.key}" has share ${weight.ratio}; shares must be positive`)
    }
  }
  const total = weights.reduce((sum, weight) => sum + weight.ratio, 0)
  const sign = minor < 0 ? -1 : 1
  const magnitude = Math.abs(Math.trunc(minor))

  // Floor each share, and remember how much each one was owed beyond its floor.
  // Comparing remainders as integers (numerator against numerator) avoids deciding
  // who gets the last cent on the strength of a floating-point comparison.
  const floors = weights.map((weight) => {
    const numerator = magnitude * weight.ratio
    return { key: weight.key, ratio: weight.ratio, floor: Math.floor(numerator / total), remainder: numerator % total }
  })
  let left = magnitude - floors.reduce((sum, share) => sum + share.floor, 0)

  // Hand out the leftover units, largest remainder first, earlier member first on a tie.
  const order = floors
    .map((share, index) => ({ index, remainder: share.remainder }))
    .sort((a, b) => (b.remainder - a.remainder) || (a.index - b.index))
  const extra = new Array<number>(floors.length).fill(0)
  for (const { index } of order) {
    if (left <= 0) break
    extra[index] = 1
    left -= 1
  }

  return floors.map((share, index) => ({
    key: share.key,
    ratio: share.ratio,
    minor: sign * (share.floor + (extra[index] ?? 0)),
  }))
}

/**
 * Reduce percentages to the smallest whole parts that preserve their proportions.
 *
 * Tricount stores a split either as fixed amounts or as ratios, and ratios are what
 * the app displays as shares. Filing `60/40` as the parts `3/2` rather than as the
 * amounts `32.52/21.68` keeps the split readable in the app and — more importantly —
 * keeps it *meaningful*, because a ratio still describes the household's intent
 * after somebody edits the total.
 *
 * @param percentages - percentage per member. Need not sum to 100; only proportions matter.
 * @returns one whole part per member, in the order given, with no common factor.
 * @throws MoneyError if there are no members, or a percentage is not positive.
 */
export function reduceToParts(percentages: readonly { key: string; percent: number }[]): { key: string; parts: number }[] {
  if (percentages.length === 0) throw new MoneyError('a split needs at least one member')
  for (const entry of percentages) {
    if (!Number.isFinite(entry.percent) || entry.percent <= 0) {
      throw new MoneyError(`"${entry.key}" has ${entry.percent}%; every share must be more than zero`)
    }
  }
  // Two decimal places of percentage is finer than any household split, and scaling
  // by 100 makes the integer gcd exact rather than a float comparison.
  const scaled = percentages.map(entry => ({ key: entry.key, parts: Math.max(1, Math.round(entry.percent * 100)) }))
  const divisor = scaled.reduce((run, entry) => gcd(run, entry.parts), 0)
  return scaled.map(entry => ({ key: entry.key, parts: entry.parts / (divisor === 0 ? 1 : divisor) }))
}

/**
 * Greatest common divisor of two non-negative integers.
 *
 * @param a - first value.
 * @param b - second value.
 * @returns the largest integer dividing both; `b` when `a` is zero.
 */
export function gcd(a: number, b: number): number {
  let x = Math.abs(a)
  let y = Math.abs(b)
  while (y !== 0) {
    const next = x % y
    x = y
    y = next
  }
  return x
}

/**
 * Check that percentages add up to 100.
 *
 * A tolerance is allowed because thirds cannot be written exactly as percentages and
 * `33.33 + 33.33 + 33.34` is what a person would naturally type. The tolerance is
 * only about the *statement* of the split — the money itself is divided by
 * {@link splitByRatio}, which is exact, so a hundredth of a percent here never
 * becomes a lost unit of currency.
 *
 * @param percentages - the stated percentages.
 * @param tolerance - how far from 100 is acceptable. Defaults to a hundredth of a percent.
 * @returns the total, when it is within tolerance.
 * @throws MoneyError naming the actual total, so the caller can see what was wrong.
 */
export function requireHundred(percentages: readonly number[], tolerance = 0.01): number {
  const total = percentages.reduce((sum, percent) => sum + percent, 0)
  if (Math.abs(total - 100) > tolerance) {
    throw new MoneyError(`the split adds up to ${round2(total)}%, not 100%`)
  }
  return total
}

/**
 * Round to two decimals for display in a message.
 *
 * @param value - the number to round.
 * @returns the value with at most two decimal places.
 */
export function round2(value: number): number {
  return Math.round(value * 100) / 100
}
