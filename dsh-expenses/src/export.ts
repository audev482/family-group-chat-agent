/**
 * Writing the ledger out as data, so it can be analysed rather than read.
 *
 * The other tools in this package answer a question in a sentence. That is right for
 * "who owes what" and useless for "show me where the money went this year" — which is
 * a chart, or at least a table nobody wants transcribed out of a chat message. The
 * harness the butler runs on already carries a filesystem and a shell, so the useful
 * thing this package can do is put the ledger somewhere those tools can reach it and
 * then get out of the way.
 *
 * Two decisions shape the file, and both exist to stop an analysis being quietly wrong:
 *
 * **One row per share, not per entry.** An expense split three ways becomes three
 * rows, with the entry's own columns repeated. This is the long shape that makes
 * grouping trivial, and it is only safe because a split sums exactly to its entry — so
 * totalling `share_minor` by category gives the same answer as totalling entries by
 * category, while also allowing "what did this cost *me*", which the entry-level shape
 * cannot answer at all. `allocation_index` is included so `allocation_index == 0`
 * recovers one row per entry when that is what is wanted.
 *
 * **Signs are pre-computed.** The API stores an expense as negative and a refund as
 * positive, which is correct and is also the single most likely thing for an analysis
 * to get backwards — the reference client for this API gets it wrong, and the mistake
 * makes refunds add to spending. So the file carries both the stored signed value and
 * a `spend` column that is positive for money out and negative for money coming back.
 * Summing `spend` gives what was actually spent, with no sign reasoning required.
 *
 * @module
 */

import { formatMinor } from 'dsh-tricount'
import type { Ledger, LedgerEntry } from 'dsh-tricount'
import { categoryLabel, nameOf } from './format.ts'

/** What an exported file is written as. */
export type ExportFormat = 'csv' | 'json'

/** The columns of the exported table, in order. */
export const EXPORT_COLUMNS = [
  'entry_id',
  'date',
  'month',
  'description',
  'kind',
  'status',
  'category',
  'source',
  'currency',
  'payer',
  'entry_amount',
  'entry_minor',
  'entry_spend',
  'allocation_index',
  'member',
  'share_amount',
  'share_minor',
  'share_spend',
  'share_percent',
] as const

/** One column name. */
export type ExportColumn = typeof EXPORT_COLUMNS[number]

/**
 * What each column means, for the model that is about to analyse the file.
 *
 * This is returned in the tool result rather than written as a sidecar file, so the
 * meaning arrives in the same context as the path and cannot be read without it.
 */
export const COLUMN_LEGEND: Readonly<Record<ExportColumn, string>> = {
  entry_id: 'Ledger entry id. Repeated across the rows of one entry.',
  date: 'The day of the entry, YYYY-MM-DD.',
  month: 'The month, YYYY-MM. Pre-computed for grouping.',
  description: 'What it was for. Machine tags are stripped.',
  kind: '"expense", "refund", or "transfer" (a settling-up payment between members).',
  status: 'active, inactive, or settled. Only active rows count towards balances.',
  category: 'Category, lower case with spaces, or "uncategorised".',
  source: '"feed" if filed automatically from the bank, "manual" if entered by hand.',
  currency: 'ISO 4217 code. One ledger is always one currency.',
  payer: 'Who put the money up (or received it, for a refund).',
  entry_amount: 'The entry total as stored: NEGATIVE for an expense, positive for a refund.',
  entry_minor: 'The same total as a whole number of minor units (cents). Exact — sum this, not entry_amount.',
  entry_spend: 'The entry total as spending: POSITIVE for money out, negative for money back.',
  allocation_index: 'Which share of the entry this row is, from 0. Filter to 0 for one row per entry.',
  member: 'Whose share this row is.',
  share_amount: 'This share as stored, signed like entry_amount.',
  share_minor: 'This share in minor units. Exact. Shares of one entry sum to entry_minor.',
  share_spend: 'This share as spending, positive for money out. Sum this for "what did X cost".',
  share_percent: 'This share as a percentage of the entry, rounded for reading.',
}

/** One row of the exported table. */
export interface ExportRow {
  /** Column values, keyed by name. Numbers stay numbers so JSON keeps them usable. */
  readonly [column: string]: string | number
}

/**
 * Flatten the ledger into one row per share.
 *
 * An entry with no allocations at all still produces one row — with an empty member
 * and a zero share — because dropping it would make the file disagree with the
 * ledger about how much was spent, which is worse than a row with a hole in it.
 *
 * @param ledger - for resolving member names and the currency.
 * @param entries - the entries to write, already filtered and ordered.
 * @returns the rows, in entry order then share order.
 */
export function toRows(ledger: Ledger, entries: readonly LedgerEntry[]): ExportRow[] {
  const rows: ExportRow[] = []
  for (const entry of entries) {
    const shared: Omit<ExportRow, 'allocation_index' | 'member' | 'share_amount' | 'share_minor' | 'share_spend' | 'share_percent'> = {
      entry_id: entry.id,
      date: entry.day,
      month: entry.day.slice(0, 7),
      description: entry.title,
      kind: kindOf(entry),
      status: entry.status.toLowerCase(),
      category: entry.categoryCustom ?? (entry.category !== undefined ? categoryLabel(entry.category) : 'uncategorised'),
      source: entry.ref !== undefined ? 'feed' : 'manual',
      currency: entry.amount.currency,
      payer: nameOf(ledger, entry.payerUuid),
      entry_amount: Number(formatMinor(entry.amount.minor, entry.amount.currency)),
      entry_minor: entry.amount.minor,
      entry_spend: Number(formatMinor(-entry.amount.minor, entry.amount.currency)),
    }
    if (entry.allocations.length === 0) {
      rows.push({
        ...shared,
        allocation_index: 0,
        member: '',
        share_amount: 0,
        share_minor: 0,
        share_spend: 0,
        share_percent: 0,
      })
      continue
    }
    const total = Math.abs(entry.amount.minor)
    entry.allocations.forEach((allocation, index) => {
      rows.push({
        ...shared,
        allocation_index: index,
        member: nameOf(ledger, allocation.memberUuid),
        share_amount: Number(formatMinor(allocation.amount.minor, allocation.amount.currency)),
        share_minor: allocation.amount.minor,
        share_spend: Number(formatMinor(-allocation.amount.minor, allocation.amount.currency)),
        share_percent: total === 0 ? 0 : Math.round((Math.abs(allocation.amount.minor) / total) * 1000) / 10,
      })
    })
  }
  return rows
}

/**
 * Say what an entry is in words a person would use.
 *
 * @param entry - the entry.
 * @returns expense, refund, or transfer.
 */
function kindOf(entry: LedgerEntry): string {
  return entry.type === 'INCOME' ? 'refund' : entry.type === 'BALANCE' ? 'transfer' : 'expense'
}

/**
 * Render rows as CSV.
 *
 * Quoting follows RFC 4180 — double the quote, wrap anything containing a delimiter,
 * quote, or newline — because a description like `Dinner, "the good place"` is
 * completely ordinary and would otherwise shift every column after it.
 *
 * @param rows - the rows.
 * @returns the file contents, with a header row and a trailing newline.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const header = EXPORT_COLUMNS.join(',')
  const body = rows.map(row => EXPORT_COLUMNS.map(column => csvCell(row[column])).join(',')).join('\n')
  return rows.length === 0 ? `${header}\n` : `${header}\n${body}\n`
}

/**
 * Quote one CSV value if it needs it.
 *
 * @param value - the cell value.
 * @returns the cell, quoted and escaped when necessary.
 */
function csvCell(value: string | number | undefined): string {
  if (value === undefined) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * Render rows as JSON, with the legend alongside.
 *
 * JSON gets the legend embedded because a JSON consumer is usually a program, and a
 * program that has the column meanings in the same document cannot read the data
 * without them. CSV cannot carry that without breaking every parser, so there the
 * legend travels in the tool result instead.
 *
 * @param ledger - for the header block.
 * @param rows - the rows.
 * @returns pretty-printed JSON.
 */
export function toJson(ledger: Ledger, rows: readonly ExportRow[]): string {
  return `${JSON.stringify({
    ledger: { title: ledger.title, currency: ledger.currency, members: ledger.members.filter(m => m.status === 'ACTIVE').map(m => m.displayName) },
    columns: COLUMN_LEGEND,
    rowCount: rows.length,
    rows,
  }, undefined, 2)}\n`
}

/**
 * Build a default filename for an export.
 *
 * Named by the day it was taken, so successive exports sit beside each other rather
 * than overwriting — a family comparing this month with last month should not have to
 * think about filenames.
 *
 * @param today - the day, `YYYY-MM-DD`.
 * @param format - the file format.
 * @returns a relative path under an `expenses` directory.
 */
export function defaultExportPath(today: string, format: ExportFormat): string {
  return `expenses/ledger-${today}.${format}`
}

/** Thrown when a requested export path is not somewhere this tool will write. */
export class ExportPathError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportPathError'
  }
}

/**
 * Work out where to write, keeping it inside the workspace.
 *
 * The path comes from a model, and a model that has been told about a ledger has no
 * business writing to `/etc`. This is not about trusting the family — they can already
 * ask for anything — but about the difference between a mistake that costs a file in
 * the workspace and one that costs the host. So a path is resolved against the
 * workspace and refused if it escapes.
 *
 * @param requested - the path the caller asked for, or undefined for the default.
 * @param workspace - the session's working directory.
 * @param today - for the default filename.
 * @param format - for the default extension.
 * @param resolve - path resolution, injected so this stays testable on any platform.
 * @returns the absolute path to write, and the path to show the caller.
 * @throws ExportPathError when the path would land outside the workspace.
 */
export function resolveExportPath(
  requested: string | undefined,
  workspace: string,
  today: string,
  format: ExportFormat,
  resolve: { join: (...parts: string[]) => string; resolve: (...parts: string[]) => string; isAbsolute: (path: string) => boolean; sep: string },
): { absolute: string; display: string } {
  const wanted = (requested ?? '').trim()
  const relative = wanted === '' ? defaultExportPath(today, format) : wanted
  const base = resolve.resolve(workspace)
  const absolute = resolve.isAbsolute(relative) ? resolve.resolve(relative) : resolve.resolve(base, relative)
  const withSep = base.endsWith(resolve.sep) ? base : `${base}${resolve.sep}`
  if (absolute !== base && !absolute.startsWith(withSep)) {
    throw new ExportPathError(
      `I will only write inside the working directory (${base}), and "${relative}" is outside it. `
      + 'Give a path relative to it, like "expenses/ledger.csv".',
    )
  }
  return { absolute, display: relative }
}

/**
 * Render the legend for a tool result.
 *
 * @returns the column meanings, one per line.
 */
export function formatLegend(): string {
  return EXPORT_COLUMNS.map(column => `  ${column}: ${COLUMN_LEGEND[column]}`).join('\n')
}
