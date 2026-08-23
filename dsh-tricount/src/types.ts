/**
 * The shapes above the Tricount wire, and the errors the seam raises.
 *
 * Nothing here mentions HTTP, JSON envelopes, or bunq. The point of the seam is
 * that `dsh-expenses` reads a ledger of entries with signed amounts and named
 * members, and would not have to change if Tricount were replaced by something
 * else — the same relationship `dsh-chores` has with `dsh-caldav`.
 *
 * @module
 */

import type { Money } from './money.ts'

/** What kind of entry this is, in Tricount's own vocabulary. */
export type EntryType =
  /** An expense: one member paid, and the amount is shared out. Stored negative. */
  | 'NORMAL'
  /** Money coming back: a refund or income, credited to the members. Stored positive. */
  | 'INCOME'
  /** A settling-up payment from one member directly to another. */
  | 'BALANCE'

/** Whether this entry is live, hidden, or already settled. */
export type EntryStatus = 'ACTIVE' | 'INACTIVE' | 'SETTLED'

/** How a member's share was expressed when the entry was filed. */
export type AllocationType =
  /** A fixed amount. */
  | 'AMOUNT'
  /** A relative share, which the app displays as parts and which survives an edit to the total. */
  | 'RATIO'

/** The categories Tricount offers. A ledger may also carry a free-text custom category. */
export const ENTRY_CATEGORIES = [
  'TRAVEL', 'ENTERTAINMENT', 'GROCERIES', 'HEALTHCARE', 'INSURANCE',
  'RENT_AND_UTILITIES', 'FOOD_AND_DRINK', 'SHOPPING', 'TRANSPORT', 'OTHER',
] as const

/** One of {@link ENTRY_CATEGORIES}. */
export type EntryCategory = typeof ENTRY_CATEGORIES[number]

/**
 * Whether a string names a category the ledger will accept.
 *
 * @param value - the candidate, in any case.
 * @returns the canonical upper-case category, or undefined if it is not one.
 */
export function asCategory(value: string): EntryCategory | undefined {
  const upper = value.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (ENTRY_CATEGORIES as readonly string[]).includes(upper) ? upper as EntryCategory : undefined
}

/** A person on the ledger. Tricount members are names, not accounts. */
export interface LedgerMember {
  /** Stable membership uuid — what allocations and entries refer to. */
  readonly uuid: string
  /** Numeric id, as the API reports it. */
  readonly id: number
  /** The name shown in the app. */
  readonly displayName: string
  /** ACTIVE unless the member was removed. */
  readonly status: string
}

/** One member's share of one entry. */
export interface EntryAllocation {
  /** Which member this share belongs to. */
  readonly memberUuid: string
  /** The share itself, signed the same way as the entry it belongs to. */
  readonly amount: Money
  /** How the share was expressed. */
  readonly type: AllocationType
  /** The relative part, when the share is a RATIO. Absent for fixed amounts. */
  readonly shareRatio?: number
}

/** One line of the ledger. */
export interface LedgerEntry {
  /** Numeric id — what the edit and delete operations address. */
  readonly id: number
  /** The entry's own uuid. */
  readonly uuid: string
  /**
   * The description exactly as stored, including any `[ref:...]` tag.
   * Prefer {@link title} for anything a person reads.
   */
  readonly description: string
  /** The description with the machine tag removed — what to show a person. */
  readonly title: string
  /**
   * The bank-feed reference, when this entry was filed automatically.
   * Present means another agent owns this row; see the package README.
   */
  readonly ref?: string
  /** The total. Negative for an expense, positive for income, as the API stores it. */
  readonly amount: Money
  /** Who paid, for an expense — or who received, for income. */
  readonly payerUuid: string
  /** How the total was shared out. */
  readonly allocations: readonly EntryAllocation[]
  /** The date as the API reports it: `YYYY-MM-DD HH:MM:SS.ffffff`. */
  readonly date: string
  /** Just the day, `YYYY-MM-DD`, which is what the family means by "when". */
  readonly day: string
  /** Live, hidden, or settled. */
  readonly status: EntryStatus
  /** Expense, income, or a settling-up payment. */
  readonly type: EntryType
  /** A standard category, when one is set. */
  readonly category?: string
  /** A free-text category, when the ledger uses one. */
  readonly categoryCustom?: string
}

/** The whole shared ledger, as one snapshot. */
export interface Ledger {
  /** Numeric registry id — part of every write URL. */
  readonly id: number
  /** The ledger's uuid. */
  readonly uuid: string
  /** What the family called it. */
  readonly title: string
  /** ISO 4217 code every amount on the ledger is in. */
  readonly currency: string
  /** The sharing token this ledger was reached by. */
  readonly token: string
  /** Everyone on the ledger, including removed members. */
  readonly members: readonly LedgerMember[]
  /** Every entry, in the order the API returned them. */
  readonly entries: readonly LedgerEntry[]
  /** READ_ONLY when the ledger has been archived, in which case writes will fail. */
  readonly status: string
}

/** What went wrong, in terms a caller can act on. */
export type TricountErrorCode =
  /** No credential is configured, or it resolves to nothing. */
  | 'credential-unconfigured'
  /** The API rejected our device or session. */
  | 'auth-failed'
  /** The sharing token names no ledger we can reach. */
  | 'ledger-not-found'
  /** A member name matches nobody on the ledger. */
  | 'unknown-member'
  /** The ledger is archived and will not accept writes. */
  | 'read-only'
  /** The entry named does not exist on the ledger. */
  | 'entry-not-found'
  /** The request was malformed — a caller-side mistake. */
  | 'invalid-request'
  /** The API returned something this client could not read. */
  | 'unexpected-response'
  /** The network failed, or the API returned an error status. */
  | 'transport-failed'

/** An error from the Tricount seam, carrying a code a caller can branch on. */
export class TricountError extends Error {
  /** What kind of failure this is. */
  readonly code: TricountErrorCode

  /**
   * @param code - the failure kind.
   * @param message - a sentence explaining what to do about it.
   * @param options - standard error options, for `cause`.
   */
  constructor(code: TricountErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TricountError'
    this.code = code
  }
}

/** One request to the Tricount API, for the event log. Never carries an amount or a secret. */
export interface TricountRequestEvent {
  /** Which operation was being performed. */
  readonly operation: string
  /** The HTTP method. */
  readonly method: string
  /** The request path, with ids but no query secrets. */
  readonly path: string
  /** HTTP status, when a response was received. */
  readonly status?: number
  /** How long it took, in milliseconds. */
  readonly durationMs: number
  /** Whether the operation succeeded. */
  readonly ok: boolean
  /** The error code, when it did not. */
  readonly error?: TricountErrorCode
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * Emitted once per Tricount API request.
     *
     * This is the only reporting channel the package has, because cordis contexts
     * carry no logger. It deliberately reports shape and timing, never amounts:
     * an event stream that recorded what the family spends would be a copy of the
     * ledger in the log.
     *
     * @param event - operation, path, timing, and outcome.
     * @mode emit
     */
    'tricount/request'(event: TricountRequestEvent): void
  }
}
