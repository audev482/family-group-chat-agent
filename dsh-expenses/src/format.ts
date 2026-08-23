/**
 * Turning the ledger into sentences, and reading the family's shorthand back.
 *
 * Everything here is pure: no service, no network, no clock. That is what makes the
 * awkward parts — how a split is written down, what counts as a duplicate, how a
 * month's spending is grouped — testable as arithmetic rather than through a mock.
 *
 * @module
 */

import { formatMoney, parseMinor, reduceToParts, requireHundred } from 'dsh-tricount'
import type { Balance, Ledger, LedgerEntry, LedgerMember, Settlement } from 'dsh-tricount'

/** Resolves whatever a person typed to somebody on the ledger. */
export type MemberResolver = (name: string) => LedgerMember

/** The part of the household roster this module needs. Structural, so no import. */
export interface RosterLookup {
  /** Find a household member by any name the family uses, or undefined. */
  resolve: (name: string) => { key: string; displayName: string } | undefined
}

/**
 * Turn a name from chat into somebody on the ledger.
 *
 * The household roster is tried first, so an alias the family actually says — "mum",
 * "dad" — reaches the right person even though the ledger has never heard of it. Each
 * candidate name is then matched against the ledger exactly, and only then by prefix,
 * because a prefix match that beats an exact one would resolve "Sam" to "Samantha".
 *
 * The last candidate is the raw text, which matters more than it looks: somebody can
 * be on the ledger without being in the household config, and refusing to name them
 * would make their entries unreadable rather than merely unattributed.
 *
 * @param ledger - the snapshot to search.
 * @param spoken - the name as typed.
 * @param roster - the household, for aliases.
 * @param ledgerNames - household key to ledger name, where the two differ.
 * @returns the ledger member.
 * @throws ExpenseInputError when nothing matches, or a prefix is ambiguous.
 */
export function resolveLedgerMember(
  ledger: Ledger,
  spoken: string,
  roster: RosterLookup,
  ledgerNames: Readonly<Record<string, string>> = {},
): LedgerMember {
  const member = roster.resolve(spoken)
  const candidates = member !== undefined
    ? [ledgerNames[member.key], member.displayName, member.key, spoken]
    : [spoken]
  const active = ledger.members.filter(candidate => candidate.status === 'ACTIVE')

  for (const wanted of candidates) {
    if (wanted === undefined || wanted.trim() === '') continue
    const lowered = wanted.trim().toLowerCase()
    const exact = active.find(candidate => candidate.displayName.toLowerCase() === lowered)
    if (exact !== undefined) return exact
  }
  for (const wanted of candidates) {
    if (wanted === undefined || wanted.trim() === '') continue
    const lowered = wanted.trim().toLowerCase()
    const prefixed = active.filter(candidate => candidate.displayName.toLowerCase().startsWith(lowered))
    if (prefixed.length === 1) return prefixed[0]!
    if (prefixed.length > 1) {
      throw new ExpenseInputError(
        `"${spoken}" could be any of ${prefixed.map(candidate => candidate.displayName).join(', ')} on the ledger — which one?`,
      )
    }
  }
  throw new ExpenseInputError(
    `Nobody on the expense ledger is called "${spoken}". `
    + `The ledger has: ${active.map(candidate => candidate.displayName).join(', ')}.`,
  )
}

/**
 * Narrow a grouping name the model asked for.
 *
 * Synonyms are accepted because the model is paraphrasing a person: "monthly", "by
 * month" and "month" are the same request, and rejecting two of the three would make
 * the tool feel arbitrary.
 *
 * @param value - what was asked for.
 * @returns the grouping, or undefined when it is not one this package knows.
 */
export function readGrouping(value: string | undefined): SummaryGrouping | undefined {
  const wanted = (value ?? 'category').trim().toLowerCase()
  if (wanted === '') return 'category'
  const known: Record<string, SummaryGrouping> = {
    category: 'category', categories: 'category',
    month: 'month', months: 'month', monthly: 'month',
    payer: 'payer', payers: 'payer', 'who paid': 'payer',
    member: 'member', members: 'member', person: 'member', people: 'member', share: 'member',
  }
  return known[wanted]
}

/** One member's agreed part of an entry. */
export interface SplitPart {
  /** The ledger membership uuid. */
  readonly memberUuid: string
  /** The relative weight. */
  readonly parts: number
  /** The name, for reporting back what was understood. */
  readonly displayName: string
}

/** Thrown when the family's shorthand cannot be read. */
export class ExpenseInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExpenseInputError'
  }
}

/**
 * Read a split the way a person would write one.
 *
 * Three forms are accepted, in rising order of specificity, because a household
 * splitting evenly should not have to say so arithmetically:
 *
 *   * **nothing** — split evenly between everybody active on the ledger;
 *   * **`Alex, Sam`** — split evenly between those named;
 *   * **`Alex=60, Sam=40`** — split by those percentages, which must total 100.
 *
 * Percentages are reduced to whole parts (`60/40` becomes `3/2`) before being filed,
 * so the Tricount app shows shares rather than frozen amounts, and the split still
 * means something if somebody later corrects the total.
 *
 * @param spec - the shorthand, or undefined for an even split among everyone.
 * @param members - everybody active on the ledger, for the default.
 * @param resolve - turns a typed name into a member.
 * @returns the parts, in the order given.
 * @throws ExpenseInputError when the shorthand is unreadable or the percentages do not total 100.
 */
export function parseSplit(
  spec: string | undefined,
  members: readonly LedgerMember[],
  resolve: MemberResolver,
): SplitPart[] {
  const trimmed = (spec ?? '').trim()
  if (trimmed === '') {
    if (members.length === 0) throw new ExpenseInputError('The ledger has nobody on it to split between.')
    return members.map(member => ({ memberUuid: member.uuid, parts: 1, displayName: member.displayName }))
  }

  const pieces = trimmed.split(/[,;]|\s+and\s+/).map(piece => piece.trim()).filter(piece => piece !== '')
  if (pieces.length === 0) throw new ExpenseInputError(`I could not read "${spec}" as a split.`)

  const named = pieces.some(piece => piece.includes('=') || /:\s*\d/.test(piece))
  if (!named) {
    // "Alex, Sam" — an even split between the people mentioned.
    return pieces.map((piece) => {
      const member = resolve(piece)
      return { memberUuid: member.uuid, parts: 1, displayName: member.displayName }
    })
  }

  const percentages: { key: string; percent: number; member: LedgerMember }[] = []
  for (const piece of pieces) {
    const match = /^(?<name>.+?)\s*[=:]\s*(?<percent>[\d.]+)\s*%?$/.exec(piece)
    if (match?.groups === undefined) {
      throw new ExpenseInputError(
        `I could not read "${piece}" as a share. Write it like "Alex=60, Sam=40", or just name the people to split evenly.`,
      )
    }
    const percent = Number(match.groups['percent'])
    if (!Number.isFinite(percent)) throw new ExpenseInputError(`"${piece}" does not give a number I can use as a share.`)
    const member = resolve(match.groups['name']!)
    percentages.push({ key: member.uuid, percent, member })
  }
  requireHundred(percentages.map(entry => entry.percent))
  const parts = reduceToParts(percentages.map(entry => ({ key: entry.key, percent: entry.percent })))
  return parts.map((part, index) => ({
    memberUuid: part.key,
    parts: part.parts,
    displayName: percentages[index]!.member.displayName,
  }))
}

/**
 * Read an amount a person typed.
 *
 * A leading currency symbol and thousands separators are stripped, because someone
 * will type `$1,234.56` and refusing it would be pedantry. Everything after that is
 * the strict digit parse, so no precision is invented.
 *
 * @param text - the amount as typed.
 * @param currency - the ledger currency, which decides the allowed precision.
 * @returns the amount in minor units, always positive.
 * @throws ExpenseInputError when it is not a usable positive amount.
 */
export function parseAmount(text: string, currency: string): number {
  const cleaned = text.trim().replace(/^[^\d.\-+]+/, '').replace(/,(?=\d{3}\b)/g, '')
  let minor: number
  try {
    minor = parseMinor(cleaned, currency)
  } catch (error) {
    throw new ExpenseInputError(`I could not read "${text}" as an amount: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (minor === 0) throw new ExpenseInputError('An entry needs an amount greater than zero.')
  return Math.abs(minor)
}

/**
 * Describe where one member stands.
 *
 * @param balance - the member's position.
 * @param currency - for formatting.
 * @returns a sentence fragment, e.g. `Sam owes $21.68`.
 */
export function balanceLine(balance: Balance, currency: string): string {
  const money = formatMoney({ minor: Math.abs(balance.minor), currency })
  if (balance.minor === 0) return `${balance.member.displayName} is square`
  return balance.minor > 0
    ? `${balance.member.displayName} is owed ${money}`
    : `${balance.member.displayName} owes ${money}`
}

/**
 * Describe where everybody stands, and what would settle it.
 *
 * The settlement is the part the family actually acts on, so it comes last and is
 * phrased as an instruction rather than as a table.
 *
 * @param balances - every member's position.
 * @param settlement - the suggested payments.
 * @param currency - for formatting.
 * @returns the whole answer.
 */
export function formatBalances(
  balances: readonly Balance[],
  settlement: readonly Settlement[],
  currency: string,
): string {
  const interesting = balances.filter(balance => balance.minor !== 0)
  if (interesting.length === 0) return 'Everybody is square — nothing is owed either way.'
  const positions = interesting
    .slice()
    .sort((a, b) => b.minor - a.minor)
    .map(balance => `- ${balanceLine(balance, currency)}`)
    .join('\n')
  if (settlement.length === 0) return positions
  const payments = settlement
    .map(payment => `- ${payment.from.displayName} pays ${payment.to.displayName} ${formatMoney({ minor: payment.minor, currency })}`)
    .join('\n')
  return `${positions}\n\nTo settle up:\n${payments}`
}

/**
 * Describe one entry as a line.
 *
 * The `[ref:...]` tag never appears — it is bookkeeping for the other agent — but
 * whether an entry came from the bank feed does, because that changes what the family
 * should do about it.
 *
 * @param ledger - for resolving member names.
 * @param entry - the entry.
 * @param options - whether to include the id, which the editing tools need.
 * @returns one line.
 */
export function entryLine(ledger: Ledger, entry: LedgerEntry, options: { showId?: boolean } = {}): string {
  const money = formatMoney({ minor: Math.abs(entry.amount.minor), currency: entry.amount.currency })
  const payer = nameOf(ledger, entry.payerUuid)
  const verb = entry.type === 'INCOME' ? 'refunded to' : entry.type === 'BALANCE' ? 'paid by' : 'paid by'
  const shares = entry.allocations
    .map(allocation => `${nameOf(ledger, allocation.memberUuid)} ${describeShare(entry, allocation.amount.minor, allocation.shareRatio)}`)
    .join(', ')
  const parts = [
    `${entry.day}`,
    options.showId === true ? `#${entry.id}` : undefined,
    `${entry.title || '(no description)'}`,
    `${money} ${verb} ${payer}`,
    shares === '' ? undefined : `split ${shares}`,
    entry.category !== undefined ? categoryLabel(entry.category) : undefined,
    entry.categoryCustom,
    entry.ref !== undefined ? 'from the bank feed' : undefined,
    entry.type === 'INCOME' ? 'refund' : undefined,
    entry.status !== 'ACTIVE' ? entry.status.toLowerCase() : undefined,
  ].filter((piece): piece is string => piece !== undefined && piece !== '')
  return `- ${parts.join(' · ')}`
}

/**
 * Describe one member's share.
 *
 * A ratio split says the share; a fixed one says the amount. Reporting a ratio as an
 * amount would hide the thing that makes it survive an edit.
 *
 * @param entry - the entry the share belongs to.
 * @param minor - the share in minor units.
 * @param shareRatio - the relative part, when there is one.
 * @returns a fragment like `3 parts` or `$21.68`.
 */
function describeShare(entry: LedgerEntry, minor: number, shareRatio?: number): string {
  if (shareRatio !== undefined) {
    const total = entry.allocations.reduce((sum, allocation) => sum + (allocation.shareRatio ?? 0), 0)
    return total > 0 ? `${Math.round((shareRatio / total) * 100)}%` : `${shareRatio} parts`
  }
  return formatMoney({ minor: Math.abs(minor), currency: entry.amount.currency })
}

/**
 * A category as a person would say it.
 *
 * @param category - the stored category.
 * @returns lower case with spaces, e.g. `rent and utilities`.
 */
export function categoryLabel(category: string): string {
  return category.toLowerCase().replace(/_/g, ' ')
}

/**
 * The display name for a membership uuid.
 *
 * @param ledger - the snapshot.
 * @param uuid - the membership uuid.
 * @returns the name, or a note that the member has gone.
 */
export function nameOf(ledger: Ledger, uuid: string): string {
  return ledger.members.find(member => member.uuid === uuid)?.displayName ?? 'someone no longer on the ledger'
}

/** How the entries should be narrowed. */
export interface EntryFilter {
  /** Only entries involving this member, as payer or in the split. */
  readonly memberUuid?: string
  /** Only entries in this category. */
  readonly category?: string
  /** Only entries on or after this day, `YYYY-MM-DD`. */
  readonly since?: string
  /** Only entries on or before this day. */
  readonly until?: string
  /** Only entries whose description contains this text, case-insensitively. */
  readonly search?: string
  /** Include entries that are not ACTIVE. Defaults to false. */
  readonly includeInactive?: boolean
  /** Only entries from the bank feed, or only hand-entered ones. */
  readonly source?: 'feed' | 'manual'
}

/**
 * Narrow and order the ledger.
 *
 * Newest first, because "what did we spend" almost always means recently, and an
 * entry's day is what the family remembers it by rather than when it was filed.
 *
 * @param entries - every entry.
 * @param filter - how to narrow.
 * @returns the matching entries, newest first.
 */
export function matchEntries(entries: readonly LedgerEntry[], filter: EntryFilter): LedgerEntry[] {
  const search = filter.search?.trim().toLowerCase()
  const matched = entries.filter((entry) => {
    if (filter.includeInactive !== true && entry.status !== 'ACTIVE') return false
    if (filter.memberUuid !== undefined) {
      const involved = entry.payerUuid === filter.memberUuid
        || entry.allocations.some(allocation => allocation.memberUuid === filter.memberUuid)
      if (!involved) return false
    }
    if (filter.category !== undefined && entry.category !== filter.category) return false
    if (filter.since !== undefined && entry.day < filter.since) return false
    if (filter.until !== undefined && entry.day > filter.until) return false
    if (search !== undefined && search !== '' && !entry.title.toLowerCase().includes(search)) return false
    if (filter.source === 'feed' && entry.ref === undefined) return false
    if (filter.source === 'manual' && entry.ref !== undefined) return false
    return true
  })
  return matched.sort((a, b) => (b.day < a.day ? -1 : b.day > a.day ? 1 : b.id - a.id))
}

/** What to group a summary by. */
export type SummaryGrouping = 'category' | 'payer' | 'month' | 'member'

/** One row of a summary. */
export interface SummaryRow {
  /** What this row is about. */
  readonly label: string
  /** Total spent, in minor units, always positive. */
  readonly minor: number
  /** How many entries contributed. */
  readonly count: number
}

/**
 * Total up the ledger along one dimension.
 *
 * Refunds are subtracted rather than counted, which is the whole reason this is not
 * a one-line sum: a month with a large return in it did not spend that money, and
 * reporting the gross would tell the family they are over budget when they are not.
 *
 * Grouping by `member` attributes each person their **share** rather than what they
 * paid — those are different questions, and "what did this cost me" is the one people
 * usually mean. `payer` answers the other one.
 *
 * @param ledger - for member names.
 * @param entries - the entries to total, already filtered.
 * @param grouping - the dimension.
 * @returns rows, largest first. Rows netting to zero are dropped.
 */
export function summarise(ledger: Ledger, entries: readonly LedgerEntry[], grouping: SummaryGrouping): SummaryRow[] {
  const totals = new Map<string, { minor: number; count: number }>()

  /** Add to a row, creating it if needed. */
  const add = (label: string, minor: number): void => {
    const row = totals.get(label) ?? { minor: 0, count: 0 }
    totals.set(label, { minor: row.minor + minor, count: row.count + 1 })
  }

  for (const entry of entries) {
    if (entry.status !== 'ACTIVE') continue
    if (entry.type === 'BALANCE') continue // A transfer between members is not spending.
    // An expense is stored negative and a refund positive, so negating gives money
    // out as positive and money back as negative — which is what a total should net.
    const spend = -entry.amount.minor
    if (grouping === 'member') {
      for (const allocation of entry.allocations) {
        add(nameOf(ledger, allocation.memberUuid), -allocation.amount.minor)
      }
      continue
    }
    const label = grouping === 'category'
      ? (entry.categoryCustom ?? (entry.category !== undefined ? categoryLabel(entry.category) : 'uncategorised'))
      : grouping === 'payer' ? nameOf(ledger, entry.payerUuid)
        : entry.day.slice(0, 7)
    add(label, spend)
  }

  return [...totals.entries()]
    .map(([label, row]) => ({ label, minor: row.minor, count: row.count }))
    .filter(row => row.minor !== 0)
    .sort((a, b) => (b.minor - a.minor) || a.label.localeCompare(b.label))
}

/**
 * Render a summary, with a total.
 *
 * @param rows - from {@link summarise}.
 * @param currency - for formatting.
 * @param grouping - names the dimension in the total line.
 * @returns the summary as text.
 */
export function formatSummary(rows: readonly SummaryRow[], currency: string, grouping: SummaryGrouping): string {
  if (rows.length === 0) return 'Nothing matches that, so there is nothing to total.'
  const total = rows.reduce((sum, row) => sum + row.minor, 0)
  const width = Math.max(...rows.map(row => row.label.length))
  const lines = rows.map((row) => {
    const money = formatMoney({ minor: row.minor, currency })
    const entries = `${row.count} ${row.count === 1 ? 'entry' : 'entries'}`
    return `- ${row.label.padEnd(width)}  ${money}  (${entries})`
  }).join('\n')
  const noun = grouping === 'member' ? 'each person\'s share' : `by ${grouping}`
  return `Totals ${noun}:\n${lines}\n\nAll together: ${formatMoney({ minor: total, currency })}`
}

/**
 * Find entries that look like one about to be filed.
 *
 * This exists because the butler files at the family's word, in a room where the
 * same request is easily made twice — and because the bank-feed agent is filing into
 * the same ledger from the other direction. An exact match on day and amount is a
 * strong enough signal to mention, and weak enough not to block anything the family
 * insists on.
 *
 * @param entries - the ledger.
 * @param candidate - the day and amount about to be filed.
 * @returns the entries that match on both.
 */
export function similarEntries(
  entries: readonly LedgerEntry[],
  candidate: { day: string; minor: number },
): LedgerEntry[] {
  const wanted = Math.abs(candidate.minor)
  return entries.filter(entry =>
    entry.status === 'ACTIVE'
    && entry.day === candidate.day
    && Math.abs(entry.amount.minor) === wanted)
}

/**
 * Warn when an entry belongs to the bank-feed agent.
 *
 * The hazard is specific and worth spelling out rather than hinting at: that agent
 * keeps its own index of what it has filed, so an entry the butler removes will not
 * be filed again. The expense simply disappears from the ledger. This is information
 * for the family, not a refusal — they asked.
 *
 * @param entry - the entry about to be changed or removed.
 * @param action - what is being done to it.
 * @returns a sentence to append, or undefined when the entry is the butler's to touch.
 */
export function feedWarning(entry: LedgerEntry, action: 'changed' | 'removed'): string | undefined {
  if (entry.ref === undefined) return undefined
  return action === 'removed'
    ? 'Note: this entry came from the bank feed, and the agent that files those keeps its own record of what it has '
      + 'already done — so it will not put this back. If it should be on the ledger, add it again by hand.'
    : 'Note: this entry came from the bank feed. The change will stay, but if that feed re-files the expense the '
      + 'original wording may come back.'
}
