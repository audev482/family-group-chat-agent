/**
 * Reading the family's shorthand, and saying the ledger back to them.
 *
 * All pure — no service, no clock, no network. The awkward parts are the ones worth
 * pinning: how a split is written down, what a summary does with a refund, and what
 * the butler says when it is about to touch a row the bank-feed agent owns.
 */

import { describe, expect, it } from 'vitest'
import {
  ExpenseInputError,
  balanceLine,
  categoryLabel,
  entryLine,
  feedWarning,
  formatBalances,
  formatSummary,
  matchEntries,
  nameOf,
  parseAmount,
  parseSplit,
  similarEntries,
  summarise,
} from '../src/format.ts'
import type { Ledger, LedgerEntry, LedgerMember } from 'dsh-tricount'

const ALEX: LedgerMember = { uuid: 'm-alex', id: 1, displayName: 'Alex', status: 'ACTIVE' }
const SAM: LedgerMember = { uuid: 'm-sam', id: 2, displayName: 'Sam', status: 'ACTIVE' }
const KIT: LedgerMember = { uuid: 'm-kit', id: 3, displayName: 'Kit', status: 'ACTIVE' }
const MEMBERS = [ALEX, SAM, KIT]

/** Resolve a name the way the plugin does, for the pure tests. */
const resolve = (name: string): LedgerMember => {
  const found = MEMBERS.find(member => member.displayName.toLowerCase() === name.trim().toLowerCase())
  if (found === undefined) throw new ExpenseInputError(`no ${name}`)
  return found
}

/**
 * Build an entry without ceremony.
 *
 * An override of `undefined` means the field is absent, which is how a real entry with
 * no category arrives.
 */
function entry(overrides: Partial<Record<keyof LedgerEntry, unknown>> = {}): LedgerEntry {
  const merged: Record<string, unknown> = {
    id: 1,
    uuid: 'e1',
    description: 'Shell gas',
    title: 'Shell gas',
    amount: { minor: -5420, currency: 'USD' },
    payerUuid: 'm-alex',
    allocations: [
      { memberUuid: 'm-alex', amount: { minor: -2710, currency: 'USD' }, type: 'RATIO', shareRatio: 1 },
      { memberUuid: 'm-sam', amount: { minor: -2710, currency: 'USD' }, type: 'RATIO', shareRatio: 1 },
    ],
    date: '2026-08-20 12:00:00.000000',
    day: '2026-08-20',
    status: 'ACTIVE',
    type: 'NORMAL',
    ...overrides,
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key]
  }
  return merged as unknown as LedgerEntry
}

/** A ledger wrapping some entries. */
function ledgerOf(entries: LedgerEntry[]): Ledger {
  return {
    id: 1, uuid: 'l', title: 'Household', currency: 'USD', token: 't',
    status: 'READ_WRITE', members: MEMBERS, entries,
  }
}

describe('parseSplit', () => {
  // A household splitting evenly should not have to say so arithmetically.
  it('splits evenly between everybody when nothing is said', () => {
    expect(parseSplit(undefined, MEMBERS, resolve)).toEqual([
      { memberUuid: 'm-alex', parts: 1, displayName: 'Alex' },
      { memberUuid: 'm-sam', parts: 1, displayName: 'Sam' },
      { memberUuid: 'm-kit', parts: 1, displayName: 'Kit' },
    ])
  })

  it('treats an empty string the same as nothing', () => {
    expect(parseSplit('   ', MEMBERS, resolve)).toHaveLength(3)
  })

  it('splits evenly between the people named', () => {
    expect(parseSplit('Alex, Sam', MEMBERS, resolve).map(part => part.displayName)).toEqual(['Alex', 'Sam'])
    expect(parseSplit('Alex, Sam', MEMBERS, resolve).every(part => part.parts === 1)).toBe(true)
  })

  it('accepts "and" between names, because people write it', () => {
    expect(parseSplit('Alex and Sam', MEMBERS, resolve).map(part => part.displayName)).toEqual(['Alex', 'Sam'])
  })

  it('reduces percentages to whole parts', () => {
    expect(parseSplit('Alex=60, Sam=40', MEMBERS, resolve)).toEqual([
      { memberUuid: 'm-alex', parts: 3, displayName: 'Alex' },
      { memberUuid: 'm-sam', parts: 2, displayName: 'Sam' },
    ])
  })

  it('accepts a percent sign and a colon', () => {
    expect(parseSplit('Alex: 60%, Sam: 40%', MEMBERS, resolve).map(part => part.parts)).toEqual([3, 2])
  })

  it('refuses percentages that do not total a hundred', () => {
    expect(() => parseSplit('Alex=60, Sam=30', MEMBERS, resolve)).toThrow(/90%, not 100%/)
  })

  it('refuses a share it cannot read', () => {
    expect(() => parseSplit('Alex=lots, Sam=40', MEMBERS, resolve)).toThrow(ExpenseInputError)
  })

  it('names the person it does not recognise', () => {
    expect(() => parseSplit('Bob=100', MEMBERS, resolve)).toThrow(/no Bob/)
  })

  it('refuses an even split when the ledger is empty', () => {
    expect(() => parseSplit(undefined, [], resolve)).toThrow(/nobody on it/)
  })

  it('handles one person taking the whole thing', () => {
    expect(parseSplit('Alex=100', MEMBERS, resolve)).toEqual([{ memberUuid: 'm-alex', parts: 1, displayName: 'Alex' }])
  })
})

describe('parseAmount', () => {
  it('reads a plain amount', () => {
    expect(parseAmount('54.20', 'USD')).toBe(5420)
  })

  // Somebody will type a currency symbol and a thousands separator; refusing would be pedantry.
  it('accepts a symbol and grouping', () => {
    expect(parseAmount('$1,234.56', 'USD')).toBe(123456)
    expect(parseAmount('€12.00', 'EUR')).toBe(1200)
  })

  it('takes the magnitude of a negative amount', () => {
    expect(parseAmount('-54.20', 'USD')).toBe(5420)
  })

  it('refuses zero, which is not an entry', () => {
    expect(() => parseAmount('0', 'USD')).toThrow(/greater than zero/)
  })

  it('refuses text that is not an amount', () => {
    expect(() => parseAmount('a lot', 'USD')).toThrow(ExpenseInputError)
  })

  it('refuses more precision than the currency has', () => {
    expect(() => parseAmount('1.005', 'USD')).toThrow(ExpenseInputError)
  })

  it('reads a zero-decimal currency', () => {
    expect(parseAmount('1500', 'JPY')).toBe(1500)
  })
})

describe('balanceLine', () => {
  it('says who is owed', () => {
    expect(balanceLine({ member: ALEX, minor: 2710 }, 'USD')).toBe('Alex is owed $27.10')
  })

  it('says who owes', () => {
    expect(balanceLine({ member: SAM, minor: -2710 }, 'USD')).toBe('Sam owes $27.10')
  })

  it('says when somebody is square', () => {
    expect(balanceLine({ member: KIT, minor: 0 }, 'USD')).toBe('Kit is square')
  })
})

describe('formatBalances', () => {
  it('says so plainly when nobody owes anything', () => {
    const balances = MEMBERS.map(member => ({ member, minor: 0 }))
    expect(formatBalances(balances, [], 'USD')).toBe('Everybody is square — nothing is owed either way.')
  })

  it('lists positions and then what settles them', () => {
    const balances = [{ member: ALEX, minor: 2710 }, { member: SAM, minor: -2710 }, { member: KIT, minor: 0 }]
    const text = formatBalances(balances, [{ from: SAM, to: ALEX, minor: 2710 }], 'USD')
    expect(text).toContain('Alex is owed $27.10')
    expect(text).toContain('Sam owes $27.10')
    expect(text).toContain('Sam pays Alex $27.10')
    expect(text).not.toContain('Kit')
  })

  it('leaves out anybody already square', () => {
    const balances = [{ member: ALEX, minor: 100 }, { member: SAM, minor: -100 }, { member: KIT, minor: 0 }]
    expect(formatBalances(balances, [], 'USD')).not.toContain('Kit')
  })
})

describe('entryLine', () => {
  it('gives the day, amount, payer and split', () => {
    const line = entryLine(ledgerOf([entry()]), entry())
    expect(line).toContain('2026-08-20')
    expect(line).toContain('$54.20')
    expect(line).toContain('Alex')
    expect(line).toContain('50%')
  })

  it('includes the id when asked, because the editing tools need it', () => {
    expect(entryLine(ledgerOf([entry()]), entry(), { showId: true })).toContain('#1')
  })

  // The tag is bookkeeping for the other agent; a person should never see it. But
  // that an entry came from the feed changes what the family should do about it.
  it('never shows the machine tag, but does say the entry came from the feed', () => {
    const fed = entry({ description: 'Shell gas [ref:pTxN123]', title: 'Shell gas', ref: 'pTxN123' })
    const line = entryLine(ledgerOf([fed]), fed)
    expect(line).not.toContain('ref:')
    expect(line).toContain('from the bank feed')
  })

  it('marks a refund as one', () => {
    const refund = entry({ type: 'INCOME', amount: { minor: 3804, currency: 'USD' } })
    expect(entryLine(ledgerOf([refund]), refund)).toContain('refund')
  })

  it('shows a fixed share as an amount rather than a percentage', () => {
    const fixed = entry({
      allocations: [{ memberUuid: 'm-alex', amount: { minor: -5420, currency: 'USD' }, type: 'AMOUNT' }],
    })
    expect(entryLine(ledgerOf([fixed]), fixed)).toContain('$54.20')
  })

  it('says so when a member has left the ledger', () => {
    const orphan = entry({ payerUuid: 'm-vanished' })
    expect(entryLine(ledgerOf([orphan]), orphan)).toContain('no longer on the ledger')
  })

  it('copes with an entry that has no description', () => {
    expect(entryLine(ledgerOf([entry()]), entry({ title: '' }))).toContain('(no description)')
  })

  it('notes a status that is not active', () => {
    expect(entryLine(ledgerOf([entry()]), entry({ status: 'SETTLED' }))).toContain('settled')
  })
})

describe('categoryLabel', () => {
  it('says a stored category the way a person would', () => {
    expect(categoryLabel('RENT_AND_UTILITIES')).toBe('rent and utilities')
    expect(categoryLabel('TRANSPORT')).toBe('transport')
  })
})

describe('nameOf', () => {
  it('names a member', () => {
    expect(nameOf(ledgerOf([]), 'm-sam')).toBe('Sam')
  })

  it('says so plainly when the member has gone', () => {
    expect(nameOf(ledgerOf([]), 'm-nope')).toBe('someone no longer on the ledger')
  })
})

describe('matchEntries', () => {
  const entries = [
    entry({ id: 1, day: '2026-08-01', title: 'Groceries', category: 'GROCERIES' }),
    entry({ id: 2, day: '2026-08-15', title: 'Shell gas', category: 'TRANSPORT', ref: 'pTxN1' }),
    entry({ id: 3, day: '2026-08-20', title: 'Dinner', category: 'FOOD_AND_DRINK', payerUuid: 'm-sam' }),
    entry({ id: 4, day: '2026-08-22', title: 'Old thing', status: 'INACTIVE' }),
  ]

  it('returns newest first, because that is what "what have we spent" means', () => {
    expect(matchEntries(entries, {}).map(e => e.id)).toEqual([3, 2, 1])
  })

  it('leaves out inactive entries by default', () => {
    expect(matchEntries(entries, {}).map(e => e.id)).not.toContain(4)
  })

  it('includes inactive entries when asked', () => {
    expect(matchEntries(entries, { includeInactive: true }).map(e => e.id)).toContain(4)
  })

  it('filters by category', () => {
    expect(matchEntries(entries, { category: 'TRANSPORT' }).map(e => e.id)).toEqual([2])
  })

  it('filters by date window, inclusively at both ends', () => {
    expect(matchEntries(entries, { since: '2026-08-15', until: '2026-08-20' }).map(e => e.id)).toEqual([3, 2])
  })

  it('searches the description case-insensitively', () => {
    expect(matchEntries(entries, { search: 'GAS' }).map(e => e.id)).toEqual([2])
  })

  // A member is "involved" as payer or in the split, because both are things a person
  // means by "what did I spend on".
  it('finds entries a person paid for or shares in', () => {
    expect(matchEntries(entries, { memberUuid: 'm-sam' }).map(e => e.id)).toEqual([3, 2, 1])
    expect(matchEntries(entries, { memberUuid: 'm-kit' })).toEqual([])
  })

  it('separates bank-fed entries from hand-entered ones', () => {
    expect(matchEntries(entries, { source: 'feed' }).map(e => e.id)).toEqual([2])
    expect(matchEntries(entries, { source: 'manual' }).map(e => e.id)).toEqual([3, 1])
  })

  it('combines filters', () => {
    expect(matchEntries(entries, { category: 'GROCERIES', since: '2026-08-10' })).toEqual([])
  })
})

describe('summarise', () => {
  const ledger = ledgerOf([])

  it('totals by category', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, category: 'GROCERIES', amount: { minor: -3000, currency: 'USD' } }),
      entry({ id: 2, category: 'GROCERIES', amount: { minor: -2000, currency: 'USD' } }),
      entry({ id: 3, category: 'TRANSPORT', amount: { minor: -1000, currency: 'USD' } }),
    ], 'category')
    expect(rows).toEqual([
      { label: 'groceries', minor: 5000, count: 2 },
      { label: 'transport', minor: 1000, count: 1 },
    ])
  })

  /*
   * The reason this is not a one-line sum. A month with a large return in it did not
   * spend that money, and reporting the gross would tell the family they are over
   * budget when they are not.
   */
  it('nets a refund off rather than counting it as spending', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, category: 'SHOPPING', amount: { minor: -10000, currency: 'USD' } }),
      entry({ id: 2, category: 'SHOPPING', amount: { minor: 3804, currency: 'USD' }, type: 'INCOME' }),
    ], 'category')
    expect(rows).toEqual([{ label: 'shopping', minor: 6196, count: 2 }])
  })

  it('drops a row that nets to nothing', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, category: 'SHOPPING', amount: { minor: -5000, currency: 'USD' } }),
      entry({ id: 2, category: 'SHOPPING', amount: { minor: 5000, currency: 'USD' }, type: 'INCOME' }),
    ], 'category')
    expect(rows).toEqual([])
  })

  // Moving money between members is not spending; counting it would inflate every total.
  it('ignores a settling-up transfer', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, amount: { minor: -2500, currency: 'USD' }, type: 'BALANCE' }),
    ], 'category')
    expect(rows).toEqual([])
  })

  it('totals by month', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, day: '2026-07-15', amount: { minor: -1000, currency: 'USD' } }),
      entry({ id: 2, day: '2026-08-01', amount: { minor: -3000, currency: 'USD' } }),
    ], 'month')
    expect(rows).toEqual([
      { label: '2026-08', minor: 3000, count: 1 },
      { label: '2026-07', minor: 1000, count: 1 },
    ])
  })

  it('totals by who put the money up', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, payerUuid: 'm-alex', amount: { minor: -3000, currency: 'USD' } }),
      entry({ id: 2, payerUuid: 'm-sam', amount: { minor: -1000, currency: 'USD' } }),
    ], 'payer')
    expect(rows).toEqual([
      { label: 'Alex', minor: 3000, count: 1 },
      { label: 'Sam', minor: 1000, count: 1 },
    ])
  })

  // "What did this cost me" and "what did I pay for" are different questions, and
  // grouping by member answers the first.
  it('totals each person their share, not what they paid', () => {
    const rows = summarise(ledger, [
      entry({
        id: 1, payerUuid: 'm-alex', amount: { minor: -10000, currency: 'USD' },
        allocations: [
          { memberUuid: 'm-alex', amount: { minor: -6000, currency: 'USD' }, type: 'RATIO', shareRatio: 3 },
          { memberUuid: 'm-sam', amount: { minor: -4000, currency: 'USD' }, type: 'RATIO', shareRatio: 2 },
        ],
      }),
    ], 'member')
    expect(rows).toEqual([
      { label: 'Alex', minor: 6000, count: 1 },
      { label: 'Sam', minor: 4000, count: 1 },
    ])
  })

  it('uses a custom category when the entry has one', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, categoryCustom: 'Coffee ☕️', amount: { minor: -500, currency: 'USD' } }),
    ], 'category')
    expect(rows[0]!.label).toBe('Coffee ☕️')
  })

  it('calls an entry with no category uncategorised', () => {
    const rows = summarise(ledger, [entry({ id: 1, category: undefined })], 'category')
    expect(rows[0]!.label).toBe('uncategorised')
  })

  it('ignores an inactive entry', () => {
    expect(summarise(ledger, [entry({ status: 'INACTIVE' })], 'category')).toEqual([])
  })

  it('puts the largest total first', () => {
    const rows = summarise(ledger, [
      entry({ id: 1, category: 'GROCERIES', amount: { minor: -1000, currency: 'USD' } }),
      entry({ id: 2, category: 'TRANSPORT', amount: { minor: -9000, currency: 'USD' } }),
    ], 'category')
    expect(rows[0]!.label).toBe('transport')
  })
})

describe('formatSummary', () => {
  it('says so plainly when there is nothing to total', () => {
    expect(formatSummary([], 'USD', 'category')).toContain('nothing to total')
  })

  it('lists rows and a grand total', () => {
    const text = formatSummary([
      { label: 'groceries', minor: 5000, count: 2 },
      { label: 'transport', minor: 1000, count: 1 },
    ], 'USD', 'category')
    expect(text).toContain('groceries')
    expect(text).toContain('$50.00')
    expect(text).toContain('2 entries')
    expect(text).toContain('1 entry')
    expect(text).toContain('All together: $60.00')
  })

  it('names the dimension it grouped by', () => {
    expect(formatSummary([{ label: 'Alex', minor: 100, count: 1 }], 'USD', 'member')).toContain('share')
    expect(formatSummary([{ label: 'x', minor: 100, count: 1 }], 'USD', 'month')).toContain('by month')
  })
})

describe('similarEntries', () => {
  const entries = [
    entry({ id: 1, day: '2026-08-20', amount: { minor: -5420, currency: 'USD' } }),
    entry({ id: 2, day: '2026-08-21', amount: { minor: -5420, currency: 'USD' } }),
    entry({ id: 3, day: '2026-08-20', amount: { minor: -1000, currency: 'USD' } }),
  ]

  it('finds an entry matching on both day and amount', () => {
    expect(similarEntries(entries, { day: '2026-08-20', minor: 5420 }).map(e => e.id)).toEqual([1])
  })

  it('finds nothing when only the day matches', () => {
    expect(similarEntries(entries, { day: '2026-08-20', minor: 9999 })).toEqual([])
  })

  it('finds nothing when only the amount matches', () => {
    expect(similarEntries(entries, { day: '2026-08-25', minor: 5420 })).toEqual([])
  })

  it('compares magnitudes, so a stored sign does not hide a duplicate', () => {
    expect(similarEntries(entries, { day: '2026-08-20', minor: -5420 }).map(e => e.id)).toEqual([1])
  })

  it('ignores an inactive entry, which is not a duplicate of anything', () => {
    const withDeleted = [entry({ id: 9, day: '2026-08-20', amount: { minor: -5420, currency: 'USD' }, status: 'INACTIVE' })]
    expect(similarEntries(withDeleted, { day: '2026-08-20', minor: 5420 })).toEqual([])
  })
})

describe('feedWarning', () => {
  // The hazard is specific: the feed agent keeps its own index, so a removed entry is
  // simply gone. That is worth spelling out rather than hinting at.
  it('warns that a removed feed entry will not come back', () => {
    const warning = feedWarning(entry({ ref: 'pTxN1' }), 'removed')
    expect(warning).toMatch(/will not put this back/)
    expect(warning).toMatch(/add it again by hand/)
  })

  it('warns more mildly about a change', () => {
    expect(feedWarning(entry({ ref: 'pTxN1' }), 'changed')).toMatch(/original wording may come back/)
  })

  it('says nothing about a hand-entered entry', () => {
    expect(feedWarning(entry(), 'removed')).toBeUndefined()
    expect(feedWarning(entry(), 'changed')).toBeUndefined()
  })
})
