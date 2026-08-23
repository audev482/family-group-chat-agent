/**
 * Service Definition and single runtime of the household capability seam
 * (`ctx.household`): who the family is, what each person is called, and which
 * CalDAV collections belong to them.
 *
 * The roster exists for **attribution**, not authorization. Every member of a
 * home has the same access, so nothing here gates a capability; the seam
 * answers "who is speaking" and "whose chore is this" so calendar tools, chore
 * tools, and the chat channel agree on one set of names.
 *
 * Name resolution is the seam's real work. People do not type configuration
 * keys — they say "mum", "Alex", "the kids". {@link Household.resolve} maps any
 * of a member's spoken names onto exactly one member, and refuses ambiguity
 * loudly rather than guessing whose dentist appointment it is.
 *
 * @module dsh-household
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  addDays,
  dayWindow,
  describeDueness,
  formatTimeOfDay,
  formatWhen,
  resolveDay,
  todayIso,
} from './clock.ts'
import type { Window } from './clock.ts'
import { HouseholdError } from './types.ts'
import type { HouseholdMember, HouseholdOccasionEntry, HouseholdRole } from './types.ts'

export { HouseholdError } from './types.ts'
export type { HouseholdErrorCode, HouseholdMember, HouseholdOccasionEntry, HouseholdRole } from './types.ts'
export * from './clock.ts'
export * from './schedule.ts'

/** One family member as written in configuration. */
export interface MemberDescriptor {
  /** Name the butler speaks; required. */
  displayName: string
  /** Additional spoken names resolving to this member. */
  aliases?: string[]
  /** Discord user id ("snowflake") used to attribute inbound messages. */
  discordUserId?: string
  /** Address mirrored into VTODO `ATTENDEE` / VEVENT invitations. */
  email?: string
  /** `CATEGORIES` tag for chore assignment; defaults to {@link MemberDescriptor.displayName}. */
  tag?: string
  /** Display name of this member's personal CalDAV calendar. */
  calendar?: string
  /** Birthday as `MM-DD` or `YYYY-MM-DD`. */
  birthday?: string
  /** Adult or child; informational only. */
  role?: HouseholdRole
}

/** A recurring date that belongs to the household as a whole. */
export interface OccasionDescriptor {
  /** Name the butler speaks ("Wedding anniversary"); required. */
  name: string
  /** The date as `MM-DD` or `YYYY-MM-DD`. */
  date: string
}

/** Plugin configuration: the family, its clock, and its shared collections. */
export interface Config {
  /** What the butler calls the household ("the Rivera family"). */
  familyName: string
  /** IANA time zone every date the butler speaks or writes is expressed in. */
  timezone: string
  /** The family, keyed by a stable identifier tools echo back. */
  members: Record<string, MemberDescriptor>
  /** Display name of the calendar holding events that concern everyone. */
  sharedCalendar?: string
  /** Display name of the calendar collection holding household VTODOs. */
  choresCalendar?: string
  /**
   * Recurring dates belonging to the household rather than to one member: a
   * wedding anniversary, the day you moved in.
   *
   * Birthdays live on members because they belong to a person. These do not, so
   * putting them on a member would force an arbitrary choice about whose
   * anniversary it is. Either `MM-DD` or `YYYY-MM-DD` works; giving the year lets
   * the butler know it is the tenth rather than just another one.
   */
  occasions?: Record<string, OccasionDescriptor>
}

export const Config: z<Config> = z.object({
  familyName: z.string().default('the household'),
  timezone: z.string().default('UTC'),
  members: z.dict(z.object({
    displayName: z.string().required(),
    aliases: z.array(z.string()).default([]),
    discordUserId: z.string(),
    email: z.string(),
    tag: z.string(),
    calendar: z.string(),
    birthday: z.string(),
    role: z.union(['adult', 'child'] as const).default('adult'),
  })).default({}),
  sharedCalendar: z.string(),
  choresCalendar: z.string(),
  occasions: z.dict(z.object({
    name: z.string().required(),
    date: z.string().required(),
  })).default({}),
})

/** Normalize a spoken name for matching: case-folded, trimmed, inner runs collapsed. */
function fold(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Reject a time zone the runtime cannot format, naming the field at fault. */
function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(0)
  } catch (cause) {
    throw new HouseholdError(
      'invalid-timezone',
      `household.timezone ${JSON.stringify(timezone)} is not an IANA time zone (e.g. "Europe/Amsterdam")`,
      { cause },
    )
  }
}

/** Build one member's public view, defaulting the derived fields. */
function resolveMember(key: string, descriptor: MemberDescriptor): HouseholdMember {
  const displayName = descriptor.displayName.trim()
  if (displayName === '') {
    throw new HouseholdError('invalid-member', `household.members.${key}.displayName must not be empty`)
  }
  const tag = (descriptor.tag ?? displayName).trim()
  if (tag === '') {
    throw new HouseholdError('invalid-member', `household.members.${key}.tag must not be empty when present`)
  }
  const aliases = (descriptor.aliases ?? []).map(alias => alias.trim()).filter(alias => alias !== '')
  return {
    key,
    displayName,
    aliases,
    tag,
    role: descriptor.role ?? 'adult',
    ...descriptor.discordUserId !== undefined ? { discordUserId: descriptor.discordUserId } : {},
    ...descriptor.email !== undefined ? { email: descriptor.email } : {},
    ...descriptor.calendar !== undefined ? { calendar: descriptor.calendar } : {},
    ...descriptor.birthday !== undefined ? { birthday: descriptor.birthday } : {},
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    household: Household
  }
}

/**
 * The household runtime (`ctx.household`): the validated roster plus the name
 * resolution every other butler package shares.
 */
export class Household extends Service {
  static Config: z<Config> = Config

  private readonly members = new Map<string, HouseholdMember>()
  /** Folded spoken name → member key. Built at load so resolution cannot drift. */
  private readonly names = new Map<string, string>()
  private readonly byDiscord = new Map<string, string>()
  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'household')
    this.config = config
    assertTimezone(config.timezone)
    for (const [key, descriptor] of Object.entries(config.members)) {
      const member = resolveMember(key, descriptor)
      this.members.set(key, member)
      this.indexTag(member)
      this.indexDiscordId(member)
      for (const name of [key, member.displayName, member.tag, ...member.aliases]) {
        this.indexName(name, member)
      }
    }
  }

  /** Reject two members sharing one chore tag: an ambiguous tag makes assignment unreadable. */
  private indexTag(member: HouseholdMember): void {
    for (const other of this.members.values()) {
      if (other.key !== member.key && fold(other.tag) === fold(member.tag)) {
        throw new HouseholdError(
          'duplicate-tag',
          `household.members.${member.key}.tag "${member.tag}" is already used by member "${other.key}" — `
          + 'chore assignment reads this tag, so it must identify exactly one person',
        )
      }
    }
  }

  /** Reject two members sharing one Discord id: inbound attribution must be single-valued. */
  private indexDiscordId(member: HouseholdMember): void {
    if (member.discordUserId === undefined) return
    const existing = this.byDiscord.get(member.discordUserId)
    if (existing !== undefined) {
      throw new HouseholdError(
        'duplicate-discord-id',
        `household.members.${member.key}.discordUserId "${member.discordUserId}" is already used by member "${existing}"`,
      )
    }
    this.byDiscord.set(member.discordUserId, member.key)
  }

  /**
   * Claim one spoken name for a member. A collision between two members is a
   * configuration error: silently preferring one would attribute a chore or an
   * appointment to the wrong person.
   */
  private indexName(name: string, member: HouseholdMember): void {
    const folded = fold(name)
    if (folded === '') return
    const existing = this.names.get(folded)
    if (existing !== undefined && existing !== member.key) {
      throw new HouseholdError(
        'duplicate-alias',
        `the name "${name}" resolves to both member "${existing}" and member "${member.key}" — `
        + 'give one of them a distinct displayName, tag, or alias',
      )
    }
    this.names.set(folded, member.key)
  }

  /** What the butler calls this household. */
  get familyName(): string {
    return this.config.familyName
  }

  /** IANA time zone every spoken and written date uses. */
  get timezone(): string {
    return this.config.timezone
  }

  /** Display name of the calendar for events concerning everyone, when configured. */
  get sharedCalendar(): string | undefined {
    return this.config.sharedCalendar
  }

  /** Display name of the calendar collection holding household VTODOs, when configured. */
  get choresCalendar(): string | undefined {
    return this.config.choresCalendar
  }

  /**
   * Household-level recurring dates, in configuration order.
   *
   * Returned as a list with the configuration key folded in as `id`, so callers
   * get something stable to build an identifier from without reaching back into
   * the config shape.
   * @returns a fresh snapshot array.
   */
  get occasions(): readonly HouseholdOccasionEntry[] {
    return Object.entries(this.config.occasions ?? {}).map(([id, entry]) => ({
      id,
      name: entry.name,
      date: entry.date,
    }))
  }

  /**
   * Every configured member in configuration order.
   * @returns a fresh snapshot array.
   */
  list(): HouseholdMember[] {
    return [...this.members.values()]
  }

  /**
   * Look one member up by configuration key.
   * @param key - configuration key.
   * @returns the member, or `undefined` when no such key is configured.
   */
  member(key: string): HouseholdMember | undefined {
    return this.members.get(key)
  }

  /**
   * Attribute an inbound chat message to a member.
   * @param discordUserId - the sender's Discord user id.
   * @returns the member, or `undefined` when the sender is not in the roster.
   */
  byDiscordId(discordUserId: string): HouseholdMember | undefined {
    const key = this.byDiscord.get(discordUserId)
    return key === undefined ? undefined : this.members.get(key)
  }

  /**
   * Resolve any spoken name — configuration key, display name, chore tag, or
   * alias — onto one member, case- and whitespace-insensitively.
   * @param name - the name as a person wrote it.
   * @returns the member, or `undefined` when nothing matches.
   */
  resolve(name: string): HouseholdMember | undefined {
    const key = this.names.get(fold(name))
    return key === undefined ? undefined : this.members.get(key)
  }

  /**
   * Resolve a spoken name or fail with a message that lists the alternatives,
   * for tools that cannot proceed without knowing whose item this is.
   * @param name - the name as a person wrote it.
   * @returns the matching member.
   */
  require(name: string): HouseholdMember {
    const member = this.resolve(name)
    if (member !== undefined) return member
    const known = this.list().map(m => m.displayName).join(', ') || 'none configured'
    throw new HouseholdError(
      'member-not-found',
      `"${name}" is not a member of ${this.familyName} (known members: ${known})`,
    )
  }

  /**
   * Find the member a chore's `CATEGORIES` values assign it to.
   * @param categories - the VTODO's category values.
   * @returns the assigned member, or `undefined` when the chore is unassigned.
   */
  fromCategories(categories: readonly string[]): HouseholdMember | undefined {
    for (const category of categories) {
      const member = this.resolve(category)
      if (member !== undefined) return member
    }
    return undefined
  }

  /**
   * Every chore tag in the roster, for building CalDAV category filters.
   * @returns a fresh snapshot array in configuration order.
   */
  tags(): string[] {
    return this.list().map(member => member.tag)
  }

  /**
   * One line per member, for the system prompt: names the butler must
   * recognize and the collections that belong to each person.
   * @returns a newline-joined roster, or a notice when no members are configured.
   */
  roster(): string {
    const members = this.list()
    if (members.length === 0) return 'No family members are configured yet.'
    return members
      .map((member) => {
        const also = member.aliases.length > 0 ? ` (also called ${member.aliases.join(', ')})` : ''
        const calendar = member.calendar !== undefined ? `, calendar "${member.calendar}"` : ''
        return `- ${member.displayName}${also} — ${member.role}, chore tag "${member.tag}"${calendar}`
      })
      .join('\n')
  }

  /**
   * The family's current calendar date.
   * @param now - the instant to read; defaults to the present.
   * @returns `YYYY-MM-DD` in the household time zone.
   */
  today(now?: Date): string {
    return todayIso(this.timezone, now)
  }

  /**
   * Resolve a day as a person says it — `today`, `tomorrow`, `friday`, or an
   * explicit `YYYY-MM-DD`.
   * @param phrase - the phrase as written; empty means today.
   * @param now - the instant "today" is relative to; defaults to the present.
   * @returns `YYYY-MM-DD`, or `undefined` when the phrase is not understood.
   */
  day(phrase: string, now?: Date): string | undefined {
    return resolveDay(phrase, this.timezone, now)
  }

  /**
   * Resolve a day or fail with a message a person can act on.
   * @param phrase - the phrase as written.
   * @param now - the instant "today" is relative to; defaults to the present.
   * @returns `YYYY-MM-DD`.
   */
  requireDay(phrase: string, now?: Date): string {
    const day = this.day(phrase, now)
    if (day !== undefined) return day
    throw new HouseholdError(
      'invalid-member',
      `"${phrase}" is not a day the butler understands — use today, tomorrow, a weekday name, or YYYY-MM-DD`,
    )
  }

  /**
   * Shift a calendar date by whole days.
   * @param dateIso - `YYYY-MM-DD`.
   * @param days - signed day count.
   * @returns `YYYY-MM-DD`.
   */
  shiftDay(dateIso: string, days: number): string {
    return addDays(dateIso, days)
  }

  /**
   * The instant window covering whole local days, for a CalDAV time-range filter.
   * @param dateIso - first day, `YYYY-MM-DD`.
   * @param days - how many days the window spans.
   * @returns the half-open window.
   */
  window(dateIso: string, days: number): Window {
    return dayWindow(dateIso, days, this.timezone)
  }

  /**
   * Phrase a date the way the butler says it out loud.
   * @param value - ISO instant, or `YYYY-MM-DD` for a whole day.
   * @returns a short human phrase in the household time zone.
   */
  when(value: string): string {
    return formatWhen(value, this.timezone)
  }

  /**
   * Phrase only the clock part, for listing several items on one known day.
   * @param value - ISO instant, or `YYYY-MM-DD`.
   * @returns `HH:MM`, or `all day`.
   */
  timeOfDay(value: string): string {
    return formatTimeOfDay(value, this.timezone)
  }

  /**
   * Describe how far away a due date is.
   * @param value - ISO instant, or `YYYY-MM-DD`.
   * @param now - the instant to measure from; defaults to the present.
   * @returns a phrase such as `due today` or `overdue by 3 days`.
   */
  dueness(value: string, now?: Date): string {
    return describeDueness(value, this.timezone, now)
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a function-plugin `apply` makes
// the Loader drop the plugin namespace.
export default Household
