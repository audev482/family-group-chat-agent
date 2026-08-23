/**
 * The exported data file.
 *
 * This is the one output nobody reads directly: a model writes code against it, so a
 * wrong column or a flipped sign becomes a confidently wrong chart rather than a
 * visible error. Hence the two invariants asserted hardest here:
 *
 *   * the shares of an entry sum to the entry — which is what makes the long shape
 *     safe to total by category as well as by person;
 *   * `spend` is positive for money out and negative for money coming back, so an
 *     analysis that just sums it gets the right answer without reasoning about the
 *     API's storage convention.
 */

import { describe, expect, it } from 'vitest'
import {
  COLUMN_LEGEND,
  EXPORT_COLUMNS,
  ExportPathError,
  defaultExportPath,
  formatLegend,
  resolveExportPath,
  toCsv,
  toJson,
  toRows,
} from '../src/export.ts'
import type { Ledger, LedgerEntry, LedgerMember } from 'dsh-tricount'

const MEMBERS: LedgerMember[] = [
  { uuid: 'm-alex', id: 1, displayName: 'Alex', status: 'ACTIVE' },
  { uuid: 'm-sam', id: 2, displayName: 'Sam', status: 'ACTIVE' },
  { uuid: 'm-kit', id: 3, displayName: 'Kit', status: 'ACTIVE' },
]

/**
 * Build an entry without ceremony.
 *
 * An override of `undefined` means the field is absent, which is how a real entry with
 * no category arrives.
 */
function entry(overrides: Partial<Record<keyof LedgerEntry, unknown>> = {}): LedgerEntry {
  const merged: Record<string, unknown> = {
    id: 900,
    uuid: 'e1',
    description: 'Shell gas [ref:pTxN123]',
    title: 'Shell gas',
    ref: 'pTxN123',
    amount: { minor: -5420, currency: 'USD' },
    payerUuid: 'm-alex',
    allocations: [
      { memberUuid: 'm-alex', amount: { minor: -3252, currency: 'USD' }, type: 'RATIO', shareRatio: 3 },
      { memberUuid: 'm-sam', amount: { minor: -2168, currency: 'USD' }, type: 'RATIO', shareRatio: 2 },
    ],
    date: '2026-08-20 12:00:00.000000',
    day: '2026-08-20',
    status: 'ACTIVE',
    type: 'NORMAL',
    category: 'TRANSPORT',
    ...overrides,
  }
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) delete merged[key]
  }
  return merged as unknown as LedgerEntry
}

/** A ledger wrapping entries. */
function ledgerOf(entries: LedgerEntry[]): Ledger {
  return {
    id: 1, uuid: 'l', title: 'Household', currency: 'USD', token: 't',
    status: 'READ_WRITE', members: MEMBERS, entries,
  }
}

/** POSIX-ish path helpers, so the path tests do not depend on the host platform. */
const posix = {
  sep: '/',
  isAbsolute: (path: string) => path.startsWith('/'),
  join: (...parts: string[]) => parts.join('/'),
  resolve: (...parts: string[]) => {
    const joined = parts.reduce((run, part) => (part.startsWith('/') ? part : `${run}/${part}`), '')
    const stack: string[] = []
    for (const piece of joined.split('/')) {
      if (piece === '' || piece === '.') continue
      if (piece === '..') stack.pop()
      else stack.push(piece)
    }
    return `/${stack.join('/')}`
  },
}

describe('toRows', () => {
  it('writes one row per share', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row['member'])).toEqual(['Alex', 'Sam'])
  })

  it('repeats the entry columns across its shares', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows.every(row => row['entry_id'] === 900)).toBe(true)
    expect(rows.every(row => row['date'] === '2026-08-20')).toBe(true)
    expect(rows.every(row => row['payer'] === 'Alex')).toBe(true)
  })

  it('numbers the shares so one row per entry can be recovered', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows.map(row => row['allocation_index'])).toEqual([0, 1])
    expect(rows.filter(row => row['allocation_index'] === 0)).toHaveLength(1)
  })

  /*
   * The invariant that makes the long shape safe: totalling shares by category gives
   * the same answer as totalling entries by category. Without it, one shape or the
   * other would be silently wrong.
   */
  it('has shares that sum to the entry', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    const shares = rows.reduce((sum, row) => sum + Number(row['share_minor']), 0)
    expect(shares).toBe(Number(rows[0]!['entry_minor']))
    expect(shares).toBe(-5420)
  })

  it('keeps minor units as exact integers', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows[0]!['entry_minor']).toBe(-5420)
    expect(rows[0]!['share_minor']).toBe(-3252)
    expect(Number.isInteger(rows[0]!['share_minor'])).toBe(true)
  })

  it('carries a decimal amount for reading', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows[0]!['entry_amount']).toBe(-54.2)
    expect(rows[0]!['share_amount']).toBe(-32.52)
  })

  // The sign the API stores is right and is also the likeliest thing for an analysis
  // to get backwards, so the file pre-computes the answer.
  it('makes spend positive for an expense', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows[0]!['entry_spend']).toBe(54.2)
    expect(rows[0]!['share_spend']).toBe(32.52)
  })

  it('makes spend negative for a refund', () => {
    const refund = entry({
      type: 'INCOME',
      amount: { minor: 3804, currency: 'USD' },
      allocations: [
        { memberUuid: 'm-alex', amount: { minor: 1902, currency: 'USD' }, type: 'RATIO', shareRatio: 1 },
        { memberUuid: 'm-sam', amount: { minor: 1902, currency: 'USD' }, type: 'RATIO', shareRatio: 1 },
      ],
    })
    const rows = toRows(ledgerOf([]), [refund])
    expect(rows[0]!['entry_spend']).toBe(-38.04)
    expect(rows[0]!['kind']).toBe('refund')
  })

  // Summing spend across an expense and its refund must come to zero, or a budget
  // chart shows money that was returned as money that was spent.
  it('nets an expense and its refund to nothing when spend is summed', () => {
    const expense = entry({ id: 1 })
    const refund = entry({
      id: 2, type: 'INCOME', amount: { minor: 5420, currency: 'USD' },
      allocations: [
        { memberUuid: 'm-alex', amount: { minor: 3252, currency: 'USD' }, type: 'RATIO', shareRatio: 3 },
        { memberUuid: 'm-sam', amount: { minor: 2168, currency: 'USD' }, type: 'RATIO', shareRatio: 2 },
      ],
    })
    const rows = toRows(ledgerOf([]), [expense, refund])
    const total = rows.reduce((sum, row) => sum - Number(row['share_minor']), 0)
    expect(total).toBe(0)
  })

  it('pre-computes the month for grouping', () => {
    expect(toRows(ledgerOf([]), [entry()])[0]!['month']).toBe('2026-08')
  })

  it('says whether an entry came from the feed', () => {
    expect(toRows(ledgerOf([]), [entry()])[0]!['source']).toBe('feed')
    expect(toRows(ledgerOf([]), [entry({ ref: undefined })])[0]!['source']).toBe('manual')
  })

  it('never writes the machine tag into the description', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows[0]!['description']).toBe('Shell gas')
    expect(JSON.stringify(rows)).not.toContain('ref:')
  })

  it('reports each share as a percentage', () => {
    const rows = toRows(ledgerOf([]), [entry()])
    expect(rows[0]!['share_percent']).toBe(60)
    expect(rows[1]!['share_percent']).toBe(40)
  })

  it('names a transfer as one', () => {
    expect(toRows(ledgerOf([]), [entry({ type: 'BALANCE' })])[0]!['kind']).toBe('transfer')
  })

  it('uses a custom category when the entry has one', () => {
    expect(toRows(ledgerOf([]), [entry({ categoryCustom: 'Coffee ☕️' })])[0]!['category']).toBe('Coffee ☕️')
  })

  it('calls an uncategorised entry so', () => {
    expect(toRows(ledgerOf([]), [entry({ category: undefined })])[0]!['category']).toBe('uncategorised')
  })

  // Dropping it would make the file disagree with the ledger about the total, which is
  // worse than a row with a hole in it.
  it('still writes a row for an entry with no shares at all', () => {
    const rows = toRows(ledgerOf([]), [entry({ allocations: [] })])
    expect(rows).toHaveLength(1)
    expect(rows[0]!['member']).toBe('')
    expect(rows[0]!['entry_minor']).toBe(-5420)
  })

  it('names a departed member rather than leaking a uuid', () => {
    const orphan = entry({
      allocations: [{ memberUuid: 'm-vanished', amount: { minor: -5420, currency: 'USD' }, type: 'AMOUNT' }],
    })
    expect(toRows(ledgerOf([]), [orphan])[0]!['member']).toBe('someone no longer on the ledger')
  })

  it('writes nothing for no entries', () => {
    expect(toRows(ledgerOf([]), [])).toEqual([])
  })
})

describe('toCsv', () => {
  it('writes a header even with no rows, so the file is still loadable', () => {
    expect(toCsv([])).toBe(`${EXPORT_COLUMNS.join(',')}\n`)
  })

  it('writes the columns in the declared order', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry()]))
    expect(csv.split('\n')[0]).toBe(EXPORT_COLUMNS.join(','))
  })

  it('writes one line per row plus the header, and ends with a newline', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry()]))
    expect(csv.split('\n')).toHaveLength(4)
    expect(csv.endsWith('\n')).toBe(true)
  })

  // A description like `Dinner, "the good place"` is completely ordinary and would
  // otherwise shift every column after it.
  it('quotes a value containing a comma', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry({ title: 'Dinner, then drinks' })]))
    expect(csv).toContain('"Dinner, then drinks"')
  })

  it('doubles an embedded quote', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry({ title: 'The "good" place' })]))
    expect(csv).toContain('"The ""good"" place"')
  })

  it('quotes a value containing a newline', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry({ title: 'Line one\nline two' })]))
    expect(csv).toContain('"Line one\nline two"')
  })

  it('leaves plain values unquoted', () => {
    const csv = toCsv(toRows(ledgerOf([]), [entry()]))
    expect(csv).toContain('900,2026-08-20,2026-08,Shell gas,expense,active,transport,feed,USD,Alex')
  })
})

describe('toJson', () => {
  it('carries the ledger, the legend, and the rows', () => {
    const parsed = JSON.parse(toJson(ledgerOf([]), toRows(ledgerOf([]), [entry()]))) as {
      ledger: { title: string; currency: string; members: string[] }
      columns: Record<string, string>
      rowCount: number
      rows: unknown[]
    }
    expect(parsed.ledger).toEqual({ title: 'Household', currency: 'USD', members: ['Alex', 'Sam', 'Kit'] })
    expect(parsed.rowCount).toBe(2)
    expect(parsed.rows).toHaveLength(2)
    expect(Object.keys(parsed.columns)).toEqual([...EXPORT_COLUMNS])
  })

  it('keeps numbers as numbers so a program can use them directly', () => {
    const parsed = JSON.parse(toJson(ledgerOf([]), toRows(ledgerOf([]), [entry()]))) as { rows: Record<string, unknown>[] }
    expect(typeof parsed.rows[0]!['share_minor']).toBe('number')
  })

  it('leaves out members who have left', () => {
    const ledger = {
      ...ledgerOf([]),
      members: [...MEMBERS, { uuid: 'm-gone', id: 9, displayName: 'Departed', status: 'DELETED' }],
    }
    const parsed = JSON.parse(toJson(ledger, [])) as { ledger: { members: string[] } }
    expect(parsed.ledger.members).not.toContain('Departed')
  })
})

describe('the legend', () => {
  it('documents every column and nothing else', () => {
    expect(Object.keys(COLUMN_LEGEND).sort()).toEqual([...EXPORT_COLUMNS].sort())
  })

  it('renders one line per column', () => {
    expect(formatLegend().split('\n')).toHaveLength(EXPORT_COLUMNS.length)
  })

  // The sign convention is the thing most likely to be got wrong, so the legend has
  // to state it rather than leave it to be inferred.
  it('spells out the sign convention', () => {
    expect(COLUMN_LEGEND.entry_amount).toMatch(/NEGATIVE for an expense/)
    expect(COLUMN_LEGEND.entry_spend).toMatch(/POSITIVE for money out/)
  })

  it('says which columns are exact', () => {
    expect(COLUMN_LEGEND.entry_minor).toMatch(/Exact/)
    expect(COLUMN_LEGEND.share_minor).toMatch(/Exact/)
  })
})

describe('defaultExportPath', () => {
  it('names the file by the day it was taken', () => {
    expect(defaultExportPath('2026-08-22', 'csv')).toBe('expenses/ledger-2026-08-22.csv')
    expect(defaultExportPath('2026-08-22', 'json')).toBe('expenses/ledger-2026-08-22.json')
  })
})

describe('resolveExportPath', () => {
  it('defaults to a dated file under the workspace', () => {
    const target = resolveExportPath(undefined, '/work', '2026-08-22', 'csv', posix)
    expect(target.absolute).toBe('/work/expenses/ledger-2026-08-22.csv')
    expect(target.display).toBe('expenses/ledger-2026-08-22.csv')
  })

  it('resolves a relative path against the workspace', () => {
    expect(resolveExportPath('out/spend.csv', '/work', '2026-08-22', 'csv', posix).absolute)
      .toBe('/work/out/spend.csv')
  })

  it('accepts an absolute path already inside the workspace', () => {
    expect(resolveExportPath('/work/spend.csv', '/work', '2026-08-22', 'csv', posix).absolute)
      .toBe('/work/spend.csv')
  })

  // The path comes from a model. A mistake should cost a file in the workspace, not
  // something on the host.
  it('refuses a path that climbs out of the workspace', () => {
    expect(() => resolveExportPath('../../etc/passwd', '/work', '2026-08-22', 'csv', posix))
      .toThrow(ExportPathError)
  })

  it('refuses an absolute path outside the workspace', () => {
    expect(() => resolveExportPath('/etc/passwd', '/work', '2026-08-22', 'csv', posix))
      .toThrow(/only write inside the working directory/)
  })

  // "/work-other" starts with "/work" as a string but is a different directory.
  it('is not fooled by a sibling directory with a shared prefix', () => {
    expect(() => resolveExportPath('/work-other/spend.csv', '/work', '2026-08-22', 'csv', posix))
      .toThrow(ExportPathError)
  })

  it('allows the workspace directory itself', () => {
    expect(resolveExportPath('spend.csv', '/work', '2026-08-22', 'csv', posix).absolute).toBe('/work/spend.csv')
  })

  it('treats an empty path as no path', () => {
    expect(resolveExportPath('   ', '/work', '2026-08-22', 'csv', posix).display)
      .toBe('expenses/ledger-2026-08-22.csv')
  })

  it('permits climbing that stays inside', () => {
    expect(resolveExportPath('a/../b.csv', '/work', '2026-08-22', 'csv', posix).absolute).toBe('/work/b.csv')
  })
})
