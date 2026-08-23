/**
 * Type surface of the household capability seam: the roster's public view and
 * its failure codes. Types only — no runtime code.
 *
 * @module dsh-household/types
 */

/** Whether a member is treated as an adult or a child; informational, never authorization. */
export type HouseholdRole = 'adult' | 'child'

/** One configured family member as consumers see them. */
export interface HouseholdMember {
  /** Stable configuration key; the identifier tools echo back. */
  readonly key: string
  /** Name the butler uses when speaking about this person. */
  readonly displayName: string
  /** Extra spoken names that resolve to this member ("mum", "mama"). */
  readonly aliases: readonly string[]
  /**
   * The `CATEGORIES` value carrying this member's chore assignments. Human
   * editable in the Nextcloud Tasks UI, which is why it is authoritative.
   */
  readonly tag: string
  /** Discord user id, when this member is reachable on the channel. */
  readonly discordUserId?: string
  /** Address mirrored into VTODO `ATTENDEE` and VEVENT invitations. */
  readonly email?: string
  /** Display name of this member's personal CalDAV calendar, when they have one. */
  readonly calendar?: string
  /** Birthday as `MM-DD` or `YYYY-MM-DD`. */
  readonly birthday?: string
  /** Adult or child. */
  readonly role: HouseholdRole
}

/**
 * A household-level recurring date, resolved from configuration.
 *
 * Structurally compatible with what `dsh-occasions` consumes, so the two packages
 * agree without either importing the other's runtime.
 */
export interface HouseholdOccasionEntry {
  /** Configuration key, stable enough to build an occasion id from. */
  readonly id: string
  /** Name the butler speaks. */
  readonly name: string
  /** The date as `MM-DD` or `YYYY-MM-DD`. */
  readonly date: string
}

/** Stable machine-readable failure codes of the household seam. */
export type HouseholdErrorCode =
  | 'no-members'
  | 'invalid-member'
  | 'duplicate-tag'
  | 'duplicate-discord-id'
  | 'duplicate-alias'
  | 'invalid-timezone'
  | 'member-not-found'

/** Structured household-seam failure; every message names the configuration field at fault. */
export class HouseholdError extends Error {
  override readonly name = 'HouseholdError'
  /** Stable machine-readable code. */
  readonly code: HouseholdErrorCode

  constructor(code: HouseholdErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.code = code
  }
}
