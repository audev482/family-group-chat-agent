/**
 * dsh-expenses — the family's shared money, as tools the butler can call.
 *
 * The household keeps one Tricount ledger: who paid for what, split how. This is the
 * meaning half of a pair, sitting on `ctx.tricount` exactly as `dsh-chores` sits on
 * `ctx.caldav` — it knows what a sensible split looks like and how to say a balance
 * out loud, and nothing about sessions or decimal strings.
 *
 * **The butler is not the only writer.** A separate agent runs the bank feed,
 * matching card transactions and filing them with a `[ref:<id>]` tag in the
 * description. That shapes three things here:
 *
 *   * The tag is never shown to the family and never written by the butler, so the
 *     two agents cannot collide over it — the feed's idempotency key is invisible to
 *     this side by construction.
 *   * Editing or removing a fed entry is allowed, because the family asked, but it
 *     says what will happen: the feed keeps its own index and will not re-file.
 *   * Adding an entry mentions any same-day, same-amount row already present, since
 *     the likeliest duplicate is one the feed has already filed.
 *
 * Tools: balances, list, summary, add, edit, refund, and remove.
 *
 * @module dsh-expenses
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ENTRY_CATEGORIES, asCategory, formatMoney, splitByRatio } from 'dsh-tricount'
import type { Ledger, LedgerEntry, LedgerMember } from 'dsh-tricount'
// Type-only: carries the `ctx.tricount` Context declaration.
import type {} from 'dsh-tricount'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'
import {
  ExpenseInputError,
  entryLine,
  feedWarning,
  formatBalances,
  formatSummary,
  matchEntries,
  parseAmount,
  parseSplit,
  readGrouping,
  resolveLedgerMember,
  similarEntries,
  summarise,
} from './format.ts'
import type { EntryFilter, SplitPart } from './format.ts'
import {
  ExportPathError,
  formatLegend,
  resolveExportPath,
  toCsv,
  toJson,
  toRows,
} from './export.ts'
import type { ExportFormat } from './export.ts'

export {
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
  readGrouping,
  resolveLedgerMember,
  similarEntries,
  summarise,
} from './format.ts'
export type {
  EntryFilter,
  MemberResolver,
  RosterLookup,
  SplitPart,
  SummaryGrouping,
  SummaryRow,
} from './format.ts'
export {
  COLUMN_LEGEND,
  EXPORT_COLUMNS,
  ExportPathError,
  defaultExportPath,
  formatLegend,
  resolveExportPath,
  toCsv,
  toJson,
  toRows,
} from './export.ts'
export type { ExportColumn, ExportFormat, ExportRow } from './export.ts'

/** Cordis plugin name. */
export const name = 'expenses'

/**
 * Services this plugin needs.
 *
 * `household` is here because the family's own names are the ones spoken in chat, and
 * they need not match the names on the ledger.
 */
export const inject = ['tricount', 'household', 'tools']

/** How many entries a list returns unless asked otherwise. */
export const DEFAULT_LIMIT = 20

/** How far back a summary looks unless asked otherwise. */
export const DEFAULT_SUMMARY_DAYS = 30

/** Tool output is prose, as everywhere else in the butler. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args: unknown, value: string) {
    return [{ type: 'text', text: value }] as never
  },
} as const

/** Configuration as an operator writes it. */
export interface ExpensesConfigDescriptor {
  /**
   * Maps a household member key to the name they have on the ledger, for the cases
   * where the two differ. Members whose names already match need no entry.
   */
  ledgerNames?: Record<string, string>
}

/** The validation schema. */
export const Config: z<ExpensesConfigDescriptor> = z.object({
  ledgerNames: z.dict(z.string()).default({}).description(
    'Household member key to the name on the Tricount ledger, only where they differ.',
  ),
}).description('The family\'s shared expense ledger, as tools.')

/**
 * Describe a thrown value for the family.
 *
 * @param error - whatever was caught.
 * @returns its message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Install the expense tools.
 *
 * @param ctx - the cordis context.
 * @param config - configuration as written.
 */
export function apply(ctx: Context, config: ExpensesConfigDescriptor = {}): void {
  const settings = Config(config)

  /**
   * Turn a name from chat into somebody on the ledger.
   *
   * @param ledger - the snapshot to search.
   * @param spoken - the name as typed.
   * @returns the ledger member.
   */
  const resolveMember = (ledger: Ledger, spoken: string): LedgerMember =>
    resolveLedgerMember(ledger, spoken, ctx.household, settings.ledgerNames ?? {})

  /** Everybody active on the ledger. */
  const activeMembers = (ledger: Ledger): LedgerMember[] =>
    ledger.members.filter(member => member.status === 'ACTIVE')

  /**
   * Build allocations from a split and a total, exactly.
   *
   * @param totalMinor - the signed total.
   * @param parts - the agreed shares.
   * @returns allocations summing exactly to the total, each carrying its share.
   */
  const allocate = (totalMinor: number, parts: readonly SplitPart[]) =>
    splitByRatio(totalMinor, parts.map(part => ({ key: part.memberUuid, ratio: part.parts })))
      .map(share => ({ memberUuid: share.key, minor: share.minor, shareRatio: share.ratio }))

  /** Describe a split for the confirmation message. */
  const describeSplit = (parts: readonly SplitPart[]): string => {
    const total = parts.reduce((sum, part) => sum + part.parts, 0)
    if (parts.every(part => part.parts === parts[0]!.parts)) {
      return `evenly between ${parts.map(part => part.displayName).join(', ')}`
    }
    return parts.map(part => `${part.displayName} ${Math.round((part.parts / total) * 100)}%`).join(', ')
  }

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_balances',
        description:
          'Who owes whom on the family expense ledger, and the payments that would settle it. Call this for '
          + '"who owes what", "are we square", "how much do I owe", or "settle up".',
        parameters: {},
        output: TEXT_OUTPUT,
        presentCall: () => ({ card: 'generic' as const, title: 'Expense balances', kind: 'read' as const }),
        execute: async () => {
          try {
            const ledger = await ctx.tricount.ledger()
            const balances = await ctx.tricount.balances()
            const settlement = await ctx.tricount.settlement()
            const body = formatBalances(balances, settlement, ledger.currency)
            return `${ledger.title} (${ledger.currency}):\n${body}`
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_list',
        description:
          'Read entries from the family expense ledger, newest first. Call this for "what have we spent", '
          + '"what did I pay for", "find the grocery entry", or before editing or removing one, because it '
          + 'reports the entry ids the other expense tools need.',
        parameters: {
          person: {
            type: 'string',
            description: 'Only entries this person paid for or shares in. Any name the family uses works.',
          },
          category: {
            type: 'string',
            description: `Only this category. One of: ${ENTRY_CATEGORIES.join(', ')}.`,
          },
          since: { type: 'string', description: 'Only entries on or after this date, YYYY-MM-DD.' },
          until: { type: 'string', description: 'Only entries on or before this date, YYYY-MM-DD.' },
          search: { type: 'string', description: 'Only entries whose description contains this text.' },
          source: {
            type: 'string',
            description: 'Use "feed" for entries filed automatically from the bank, or "manual" for hand-entered ones.',
          },
          limit: { type: 'number', description: `Most entries to return. Defaults to ${DEFAULT_LIMIT}.` },
        },
        presentCall: args => ({
          card: 'generic' as const,
          title: `Expenses${args.person !== undefined ? ` for ${args.person}` : ''}`,
          kind: 'read' as const,
        }),
        output: TEXT_OUTPUT,
        execute: async (args) => {
          let ledger: Ledger
          try {
            ledger = await ctx.tricount.ledger()
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
          const filter: EntryFilter = {}
          try {
            Object.assign(filter, buildFilter(ledger, args, resolveMember))
          } catch (error) {
            return describe(error)
          }
          const matched = matchEntries(ledger.entries, filter)
          if (matched.length === 0) return 'No ledger entries match that.'
          const limit = Math.max(1, Math.trunc(args.limit ?? DEFAULT_LIMIT))
          const shown = matched.slice(0, limit)
          const lines = shown.map(entry => entryLine(ledger, entry, { showId: true })).join('\n')
          const more = matched.length > shown.length
            ? `\n\n${matched.length - shown.length} more match; ask for a higher limit or narrow it down.`
            : ''
          return `${shown.length} of ${matched.length} matching entries on "${ledger.title}":\n${lines}${more}`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_summary',
        description:
          'Total up the family expense ledger along one dimension. Call this for "what did we spend on groceries", '
          + '"where is the money going", "how much last month", or "what has this cost me". Refunds are netted off, '
          + 'so the totals are what was actually spent.',
        parameters: {
          group_by: {
            type: 'string',
            description:
              'One of "category", "month", "payer" (who put the money up), or "member" (whose share it was). '
              + 'Defaults to category.',
          },
          person: { type: 'string', description: 'Only entries this person paid for or shares in.' },
          since: { type: 'string', description: `Only entries on or after this date. Defaults to ${DEFAULT_SUMMARY_DAYS} days ago.` },
          until: { type: 'string', description: 'Only entries on or before this date.' },
          category: { type: 'string', description: 'Only this category.' },
          search: { type: 'string', description: 'Only entries whose description contains this text.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Expense totals by ${args.group_by ?? 'category'}`,
          kind: 'read' as const,
        }),
        execute: async (args) => {
          let ledger: Ledger
          try {
            ledger = await ctx.tricount.ledger()
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
          const grouping = readGrouping(args.group_by)
          if (grouping === undefined) {
            return `I can total by category, month, payer, or member — not by "${args.group_by}".`
          }
          const filter: EntryFilter = {}
          try {
            Object.assign(filter, buildFilter(ledger, args, resolveMember))
          } catch (error) {
            return describe(error)
          }
          // Default to a recent window rather than all time: "where is the money
          // going" means lately, and the whole ledger would bury that.
          if (filter.since === undefined && filter.until === undefined) {
            Object.assign(filter, { since: ctx.household.shiftDay(ctx.household.today(), -DEFAULT_SUMMARY_DAYS) })
          }
          const matched = matchEntries(ledger.entries, filter)
          const rows = summarise(ledger, matched, grouping)
          const window = filter.since !== undefined
            ? ` from ${filter.since}${filter.until !== undefined ? ` to ${filter.until}` : ''}`
            : filter.until !== undefined ? ` up to ${filter.until}` : ''
          return `${ledger.title}${window}:\n${formatSummary(rows, ledger.currency, grouping)}`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_add',
        description:
          'Add an expense to the family ledger. Call this when the family says they paid for something shared — '
          + '"I paid 54.20 for gas, split it", "put dinner on the ledger". Say who paid; the split defaults to '
          + 'evenly between everybody.',
        parameters: {
          description: {
            type: 'string',
            description: 'What it was for, as the family would say it.',
            required: true,
          },
          amount: { type: 'string', description: 'The total, e.g. "54.20". Always positive.', required: true },
          payer: { type: 'string', description: 'Who paid. Any name the family uses works.', required: true },
          split: {
            type: 'string',
            description:
              'How to share it. Omit for evenly between everybody, name people for evenly between them '
              + '("Alex, Sam"), or give percentages that total 100 ("Alex=60, Sam=40").',
          },
          category: { type: 'string', description: `Optional. One of: ${ENTRY_CATEGORIES.join(', ')}.` },
          date: { type: 'string', description: 'The day it happened, YYYY-MM-DD. Defaults to today.' },
          duplicate_ok: {
            type: 'boolean',
            description: 'Set true to file it even though a matching entry already exists that day.',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Add expense: ${args.description}`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          let ledger: Ledger
          try {
            ledger = await ctx.tricount.ledger()
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
          let payer: LedgerMember
          let parts: SplitPart[]
          let magnitude: number
          let day: string
          try {
            payer = resolveMember(ledger, args.payer)
            parts = parseSplit(args.split, activeMembers(ledger), name => resolveMember(ledger, name))
            magnitude = parseAmount(args.amount, ledger.currency)
            day = args.date !== undefined && args.date.trim() !== ''
              ? ctx.household.requireDay(args.date)
              : ctx.household.today()
          } catch (error) {
            return describe(error)
          }
          const category = args.category !== undefined ? asCategory(args.category) : undefined
          if (args.category !== undefined && args.category.trim() !== '' && category === undefined) {
            return `"${args.category}" is not a category the ledger has. Use one of: ${ENTRY_CATEGORIES.join(', ')}.`
          }

          // The likeliest duplicate is one the bank feed already filed, so mention it
          // rather than quietly adding a second copy of the same expense.
          if (args.duplicate_ok !== true) {
            const clashes = similarEntries(ledger.entries, { day, minor: magnitude })
            if (clashes.length > 0) {
              const lines = clashes.map(entry => entryLine(ledger, entry, { showId: true })).join('\n')
              return `There is already an entry for that amount on ${day}:\n${lines}\n\n`
                + 'I have not added anything. If this really is a second one, say so and I will file it; if the '
                + 'existing entry is wrong, I can change it instead.'
            }
          }

          const total = -magnitude
          try {
            const id = await ctx.tricount.add({
              description: args.description.trim(),
              minor: total,
              payerUuid: payer.uuid,
              allocations: allocate(total, parts),
              type: 'NORMAL',
              day,
              ...(category !== undefined ? { category } : {}),
            })
            const money = formatMoney({ minor: magnitude, currency: ledger.currency })
            return `Added "${args.description.trim()}" — ${money} paid by ${payer.displayName} on ${day}, `
              + `split ${describeSplit(parts)}. Entry #${id}.`
          } catch (error) {
            return `I could not add that to the ledger: ${describe(error)}`
          }
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_edit',
        description:
          'Change an entry on the family ledger — its description, amount, payer, date, category, or split. '
          + 'Get the entry id from expenses_list first. Anything you do not mention is left exactly as it is, '
          + 'including the split.',
        parameters: {
          entry_id: { type: 'number', description: 'The entry id, from expenses_list.', required: true },
          description: { type: 'string', description: 'New description.' },
          amount: { type: 'string', description: 'New total, positive. The split is re-divided to match.' },
          payer: { type: 'string', description: 'Who paid, if that was wrong.' },
          split: { type: 'string', description: 'A new split, in the same forms expenses_add accepts.' },
          category: { type: 'string', description: `New category. One of: ${ENTRY_CATEGORIES.join(', ')}.` },
          date: { type: 'string', description: 'New date, YYYY-MM-DD.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Edit expense #${args.entry_id}`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          let ledger: Ledger
          let existing: LedgerEntry
          try {
            ledger = await ctx.tricount.ledger()
            existing = await ctx.tricount.entry(args.entry_id, ledger)
          } catch (error) {
            return `I could not find that entry: ${describe(error)}`
          }
          const patch: Record<string, unknown> = {}
          const changes: string[] = []
          try {
            if (args.description !== undefined && args.description.trim() !== '') {
              patch['title'] = args.description.trim()
              changes.push(`description to "${args.description.trim()}"`)
            }
            if (args.amount !== undefined && args.amount.trim() !== '') {
              const magnitude = parseAmount(args.amount, ledger.currency)
              patch['amountMinor'] = magnitude
              changes.push(`amount to ${formatMoney({ minor: magnitude, currency: ledger.currency })}`)
            }
            if (args.payer !== undefined && args.payer.trim() !== '') {
              const payer = resolveMember(ledger, args.payer)
              patch['payerUuid'] = payer.uuid
              changes.push(`payer to ${payer.displayName}`)
            }
            if (args.date !== undefined && args.date.trim() !== '') {
              const day = ctx.household.requireDay(args.date)
              patch['day'] = day
              changes.push(`date to ${day}`)
            }
            if (args.category !== undefined && args.category.trim() !== '') {
              const category = asCategory(args.category)
              if (category === undefined) {
                return `"${args.category}" is not a category the ledger has. Use one of: ${ENTRY_CATEGORIES.join(', ')}.`
              }
              patch['category'] = category
              changes.push(`category to ${category.toLowerCase().replace(/_/g, ' ')}`)
            }
            if (args.split !== undefined && args.split.trim() !== '') {
              const parts = parseSplit(args.split, activeMembers(ledger), name => resolveMember(ledger, name))
              patch['split'] = parts.map(part => ({ memberUuid: part.memberUuid, parts: part.parts }))
              changes.push(`split to ${describeSplit(parts)}`)
            }
          } catch (error) {
            return describe(error)
          }
          if (changes.length === 0) return 'Nothing to change — tell me what about that entry is wrong.'

          try {
            await ctx.tricount.edit(args.entry_id, patch)
          } catch (error) {
            return `I could not change that entry: ${describe(error)}`
          }
          const warning = feedWarning(existing, 'changed')
          return `Changed entry #${args.entry_id} ("${existing.title}"): ${changes.join(', ')}.`
            + `${warning !== undefined ? `\n\n${warning}` : ''}`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_refund',
        description:
          'Record money coming back — a return, a refund, a reimbursement. This adds a separate credit entry and '
          + 'leaves the original expense alone, so the ledger keeps the whole story. Split it the same way as the '
          + 'original so it cancels out proportionally.',
        parameters: {
          description: { type: 'string', description: 'What was refunded.', required: true },
          amount: { type: 'string', description: 'The amount coming back, positive.', required: true },
          receiver: {
            type: 'string',
            description: 'Who got the money back — usually whoever paid originally.',
            required: true,
          },
          split: {
            type: 'string',
            description: 'How to credit it, in the same forms expenses_add accepts. Use the original expense\'s split.',
          },
          category: { type: 'string', description: `Optional. One of: ${ENTRY_CATEGORIES.join(', ')}.` },
          date: { type: 'string', description: 'The day the money came back. Defaults to today.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Record refund: ${args.description}`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          let ledger: Ledger
          try {
            ledger = await ctx.tricount.ledger()
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
          let receiver: LedgerMember
          let parts: SplitPart[]
          let magnitude: number
          let day: string
          try {
            receiver = resolveMember(ledger, args.receiver)
            parts = parseSplit(args.split, activeMembers(ledger), name => resolveMember(ledger, name))
            magnitude = parseAmount(args.amount, ledger.currency)
            day = args.date !== undefined && args.date.trim() !== ''
              ? ctx.household.requireDay(args.date)
              : ctx.household.today()
          } catch (error) {
            return describe(error)
          }
          const category = args.category !== undefined ? asCategory(args.category) : undefined
          if (args.category !== undefined && args.category.trim() !== '' && category === undefined) {
            return `"${args.category}" is not a category the ledger has. Use one of: ${ENTRY_CATEGORIES.join(', ')}.`
          }
          // Income is stored positive: that sign is what makes it cancel the expense
          // rather than add to it.
          const total = magnitude
          try {
            const id = await ctx.tricount.add({
              description: args.description.trim(),
              minor: total,
              payerUuid: receiver.uuid,
              allocations: allocate(total, parts),
              type: 'INCOME',
              day,
              ...(category !== undefined ? { category } : {}),
            })
            const money = formatMoney({ minor: magnitude, currency: ledger.currency })
            return `Recorded a refund of ${money} to ${receiver.displayName} on ${day} for `
              + `"${args.description.trim()}", credited ${describeSplit(parts)}. Entry #${id}. `
              + 'The original expense is untouched, so both show on the ledger.'
          } catch (error) {
            return `I could not record that refund: ${describe(error)}`
          }
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_remove',
        description:
          'Delete an entry from the family ledger. Get the id from expenses_list first. For money coming back on a '
          + 'real purchase use expenses_refund instead — deleting the expense hides that it ever happened, where a '
          + 'refund shows both sides.',
        parameters: {
          entry_id: { type: 'number', description: 'The entry id, from expenses_list.', required: true },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Remove expense #${args.entry_id}`,
          kind: 'delete' as const,
        }),
        execute: async (args) => {
          let ledger: Ledger
          let existing: LedgerEntry
          try {
            ledger = await ctx.tricount.ledger()
            existing = await ctx.tricount.entry(args.entry_id, ledger)
          } catch (error) {
            return `I could not find that entry: ${describe(error)}`
          }
          try {
            await ctx.tricount.remove(args.entry_id)
          } catch (error) {
            return `I could not remove that entry: ${describe(error)}`
          }
          const money = formatMoney({ minor: Math.abs(existing.amount.minor), currency: existing.amount.currency })
          const warning = feedWarning(existing, 'removed')
          return `Removed entry #${args.entry_id}: "${existing.title}", ${money} from ${existing.day}.`
            + `${warning !== undefined ? `\n\n${warning}` : ''}`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'expenses_export',
        description:
          'Write the expense ledger to a file so it can be analysed with code — totals, trends, charts, '
          + 'anything the other tools cannot say in a sentence. Call this for "chart our spending", '
          + '"analyse the ledger", "break this down by month and category", or any question needing real '
          + 'computation. Then use the filesystem and shell tools on the file it writes. '
          + 'One row per person per entry, so it groups by category, month, payer, or member directly.',
        parameters: {
          format: { type: 'string', description: 'Either "csv" (default, opens anywhere) or "json".' },
          path: {
            type: 'string',
            description:
              'Where to write, relative to the working directory. Defaults to expenses/ledger-<today>.csv. '
              + 'Must stay inside the working directory.',
          },
          person: { type: 'string', description: 'Only entries this person paid for or shares in.' },
          category: { type: 'string', description: 'Only this category.' },
          since: { type: 'string', description: 'Only entries on or after this date, YYYY-MM-DD. Omit for the whole ledger.' },
          until: { type: 'string', description: 'Only entries on or before this date, YYYY-MM-DD.' },
          search: { type: 'string', description: 'Only entries whose description contains this text.' },
          source: { type: 'string', description: '"feed" for bank-filed entries, "manual" for hand-entered ones.' },
          include_inactive: {
            type: 'boolean',
            description: 'Include deleted and settled entries. Defaults to false, which is what totals should use.',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Export expenses${args.format === 'json' ? ' as JSON' : ''}`,
          kind: 'edit' as const,
        }),
        execute: async (args, exec) => {
          let ledger: Ledger
          try {
            ledger = await ctx.tricount.ledger()
          } catch (error) {
            return `I could not read the expense ledger: ${describe(error)}`
          }
          const format: ExportFormat = String(args.format ?? 'csv').trim().toLowerCase() === 'json' ? 'json' : 'csv'
          const filter: EntryFilter = {}
          try {
            Object.assign(filter, buildFilter(ledger, args, resolveMember))
          } catch (error) {
            return describe(error)
          }
          if (args.include_inactive === true) Object.assign(filter, { includeInactive: true })

          // Oldest first: a file that is read as a time series should be in time order,
          // where the chat listing wants newest first. Different jobs, different order.
          const matched = matchEntries(ledger.entries, filter).slice().reverse()
          const rows = toRows(ledger, matched)

          // The session's own working directory, so the file lands where this session's
          // filesystem and shell tools resolve relative paths.
          const workspace = exec.agent?.session.header.cwd ?? process.cwd()
          let target: { absolute: string; display: string }
          try {
            target = resolveExportPath(args.path, workspace, ctx.household.today(), format, { join, resolve, isAbsolute, sep })
          } catch (error) {
            if (error instanceof ExportPathError) return error.message
            return `I could not work out where to write that: ${describe(error)}`
          }

          const contents = format === 'json' ? toJson(ledger, rows) : toCsv(rows)
          try {
            await mkdir(dirname(target.absolute), { recursive: true })
            await writeFile(target.absolute, contents, 'utf8')
          } catch (error) {
            return `I could not write ${target.display}: ${describe(error)}`
          }

          const window = filter.since !== undefined || filter.until !== undefined
            ? ` covering ${filter.since ?? 'the start'} to ${filter.until ?? 'today'}`
            : ' covering the whole ledger'
          const legend = format === 'csv'
            ? `\n\nColumns:\n${formatLegend()}`
            : '\n\nThe file carries the same column legend inside it.'
          return `Wrote ${rows.length} ${rows.length === 1 ? 'row' : 'rows'} from ${matched.length} `
            + `${matched.length === 1 ? 'entry' : 'entries'}${window} to ${target.display} `
            + `(${format.toUpperCase()}, ${ledger.currency}).${legend}\n\n`
            + 'One row per person per entry: filter to allocation_index == 0 for one row per entry, or sum '
            + 'share_spend for what something cost a particular person. Sum the *_minor columns for exact '
            + 'arithmetic; the decimal columns are for reading.'
        },
      }),
    ),
  )
}
/**
 * Build an entry filter from tool arguments.
 *
 * Shared by list and summary so the two narrow the ledger identically — a summary
 * that counted different entries from the list that produced it would be worse than
 * no summary.
 *
 * @param ledger - the snapshot, for resolving names.
 * @param args - the tool arguments.
 * @param resolve - turns a spoken name into a member.
 * @returns the filter.
 * @throws ExpenseInputError when a name or category cannot be read.
 */
function buildFilter(
  ledger: Ledger,
  args: { person?: string; category?: string; since?: string; until?: string; search?: string; source?: string },
  resolve: (ledger: Ledger, name: string) => LedgerMember,
): EntryFilter {
  const filter: Record<string, unknown> = {}
  if (args.person !== undefined && args.person.trim() !== '') {
    filter['memberUuid'] = resolve(ledger, args.person).uuid
  }
  if (args.category !== undefined && args.category.trim() !== '') {
    const category = asCategory(args.category)
    if (category === undefined) {
      throw new ExpenseInputError(
        `"${args.category}" is not a category the ledger has. Use one of: ${ENTRY_CATEGORIES.join(', ')}.`,
      )
    }
    filter['category'] = category
  }
  if (args.since !== undefined && args.since.trim() !== '') filter['since'] = args.since.trim().slice(0, 10)
  if (args.until !== undefined && args.until.trim() !== '') filter['until'] = args.until.trim().slice(0, 10)
  if (args.search !== undefined && args.search.trim() !== '') filter['search'] = args.search.trim()
  if (args.source === 'feed' || args.source === 'manual') filter['source'] = args.source
  return filter as EntryFilter
}
