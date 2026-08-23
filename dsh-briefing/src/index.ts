/**
 * dsh-briefing — the part of being a butler that nobody asks for.
 *
 * A butler that only answers questions is a search box. This plugin posts one
 * digest a morning into the family's room: what is on today, and what is
 * overdue or due. It is what turns the calendar and the chore list from things
 * you have to remember to check into things that arrive.
 *
 * The digest is composed **deterministically** from the calendar and chore
 * helpers rather than by asking the model to write it. A morning digest that is
 * sometimes wrong, or sometimes absent because a token ran out, is worse than no
 * digest at all — and it costs nothing to be exact here.
 *
 * That is why this package couples to more seams than any other: a briefing *is*
 * the composition of the calendar, the chores, the roster, and the channel.
 *
 * @module dsh-briefing
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { collectEvents, formatAgenda, scopeFor } from 'dsh-calendar'
import { byUrgency, choreLine, collectChores, isCancelled, isDone } from 'dsh-chores'
import type { ChoreEntry } from 'dsh-chores'
// Type-only: carries the `ctx.caldav` Context declaration.
import type {} from 'dsh-caldav'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'
// Type-only: carries the `ctx.discord` Context declaration.
import type {} from 'dsh-channel-discord'
import { nextRun, parseTimeOfDay } from './schedule.ts'
import type { TimeOfDay } from './schedule.ts'
// Type-only: carries the `ctx.mail` Context declaration. Mail is a soft
// dependency — see `unreadMailLine`.
import type {} from 'dsh-mail'

export { nextRun, parseTimeOfDay } from './schedule.ts'
export type { ScheduleClock, TimeOfDay } from './schedule.ts'

/** Cordis plugin name. */
export const name = 'briefing'
/** The channel to speak through, the data to speak about, and the roster to name people by. */
export const inject = ['discord', 'caldav', 'household']

/** When the digest goes out when the household does not say. */
export const DEFAULT_BRIEFING_TIME = '07:30'
/** How far ahead chores are counted as "coming up". */
export const DEFAULT_CHORE_LOOKAHEAD_DAYS = 2

/** Plugin configuration. */
export interface Config {
  /** Discord channel id the digest is posted to. Required; without it nothing is sent. */
  channelId: string
  /** Local time of day to post, `HH:MM` on a 24-hour clock. */
  time?: string
  /** How many days of calendar the digest covers. */
  days?: number
  /** How far ahead a chore counts as coming up. */
  choreLookaheadDays?: number
  /** Whether to include the chore list. */
  includeChores?: boolean
  /**
   * Whether to mention unread email.
   *
   * Only a count and the senders — never subjects or bodies. A morning digest is
   * read by whoever is in the room, and it is not the place to surface the
   * contents of the family's mail.
   */
  includeMail?: boolean
  /** Post nothing when there is nothing to report, rather than saying so. */
  skipWhenEmpty?: boolean
  /** CalDAV server name, when more than one is configured. */
  server?: string
}

export const Config: z<Config> = z.object({
  channelId: z.string().required(),
  time: z.string().default(DEFAULT_BRIEFING_TIME),
  days: z.number().step(1).min(1).max(7).default(1),
  choreLookaheadDays: z.number().step(1).min(0).max(30).default(DEFAULT_CHORE_LOOKAHEAD_DAYS),
  includeChores: z.boolean().default(true),
  includeMail: z.boolean().default(true),
  skipWhenEmpty: z.boolean().default(false),
  server: z.string(),
})

/** What the digest found, so a caller can decide whether it is worth posting. */
export interface Digest {
  /** The text to post. */
  readonly text: string
  /** Whether anything of substance was found. */
  readonly hasContent: boolean
}

/**
 * One line about unread mail, or nothing.
 *
 * Mail is a **soft** dependency: cordis has no optional-inject form, so listing
 * `mail` in `inject` would keep the digest from ever running in a household that
 * only wanted the calendar. Reading it through a guard instead means the digest
 * gains a line when the mailbox is mounted and is otherwise unchanged.
 *
 * Only counts and sender names go in. Subjects belong to whoever the mail is
 * for, and a digest is read by whoever happens to be in the room.
 * @param ctx - the plugin context.
 * @returns the line, or undefined when there is no mailbox or no unread mail.
 */
export async function unreadMailLine(ctx: Context): Promise<string | undefined> {
  const mail = (ctx as { mail?: Context['mail'] }).mail
  if (mail === undefined) return undefined
  try {
    const unread = await mail.search({ mailbox: 'INBOX', seen: false, limit: 25 })
    if (unread.length === 0) return undefined
    const senders = [...new Set(unread.map(message =>
      message.from[0]?.name ?? message.from[0]?.address ?? 'unknown sender'))]
    const shown = senders.slice(0, 5)
    const more = senders.length - shown.length
    return `Unread email: ${unread.length} — from ${shown.join(', ')}`
      + `${more > 0 ? ` and ${more} other(s)` : ''}. Ask me to read any of it.`
  } catch {
    // A mail outage must not cost the family their agenda.
    return undefined
  }
}

/**
 * Compose one morning digest.
 *
 * Overdue chores are reported separately from upcoming ones, because "three
 * things are late" is the fact that changes behaviour.
 * @param ctx - a context carrying the caldav and household seams.
 * @param options - what to cover.
 * @param now - the instant the digest describes; defaults to the present.
 * @returns the digest text and whether it found anything.
 */
export async function composeDigest(
  ctx: Context,
  options: {
    days: number
    includeChores: boolean
    choreLookaheadDays: number
    includeMail?: boolean
    server?: string
  },
  now: Date = new Date(),
): Promise<Digest> {
  const household = ctx.household
  const today = household.today(now)
  const sections: string[] = []
  let hasContent = false

  const scope = scopeFor(household, {})
  if (scope.calendars.length > 0) {
    const window = household.window(today, options.days)
    const { events, problems } = await collectEvents(ctx.caldav, scope.calendars, window)
    hasContent = hasContent || events.length > 0
    sections.push(formatAgenda(household, events, {
      fromDay: today,
      days: options.days,
      showCalendar: scope.calendars.length > 1,
    }))
    if (problems.length > 0) {
      sections.push(`(Some calendars could not be read: ${problems.join('; ')})`)
    }
  } else {
    sections.push('No calendars are configured yet, so I have no agenda to report.')
  }

  const choresCalendar = household.choresCalendar
  if (options.includeChores && choresCalendar !== undefined) {
    let chores: ChoreEntry[] = []
    let failure: string | undefined
    try {
      ({ chores } = await collectChores(ctx.caldav, choresCalendar, options.server))
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    if (failure !== undefined) {
      sections.push(`I could not read the chore list: ${failure}`)
    } else {
      const open = chores.filter(entry => !isDone(entry.fields) && !isCancelled(entry.fields))
      const overdue = open.filter((entry) => {
        const due = entry.fields.due?.slice(0, 10)
        return due !== undefined && due < today
      })
      const horizon = household.shiftDay(today, options.choreLookaheadDays)
      const soon = open.filter((entry) => {
        const due = entry.fields.due?.slice(0, 10)
        return due !== undefined && due >= today && due <= horizon
      })
      hasContent = hasContent || overdue.length > 0 || soon.length > 0
      if (overdue.length > 0) {
        sections.push(`Overdue (${overdue.length}):\n${byUrgency(overdue, today)
          .map(entry => choreLine(household, entry, { showAssignee: true }))
          .join('\n')}`)
      }
      if (soon.length > 0) {
        sections.push(`Due soon:\n${byUrgency(soon, today)
          .map(entry => choreLine(household, entry, { showAssignee: true }))
          .join('\n')}`)
      }
      if (overdue.length === 0 && soon.length === 0 && open.length > 0) {
        sections.push(`Nothing is overdue. ${open.length} chore(s) are on the list without a near due date.`)
      }
    }
  }

  const greeting = `Good morning — ${household.familyName}, ${household.when(today)}.`
  if (options.includeMail !== false) {
    const line = await unreadMailLine(ctx)
    if (line !== undefined) {
      sections.push(line)
      hasContent = true
    }
  }
  return {
    text: [greeting, ...sections].join('\n\n'),
    hasContent,
  }
}

/**
 * Mount the daily digest.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Fail loud at load: an unparseable time would otherwise mean a digest that
  // silently never arrives.
  const at: TimeOfDay = parseTimeOfDay(config.time ?? DEFAULT_BRIEFING_TIME)
  const days = config.days ?? 1
  const includeChores = config.includeChores !== false
  const choreLookaheadDays = config.choreLookaheadDays ?? DEFAULT_CHORE_LOOKAHEAD_DAYS
  const includeMail = config.includeMail !== false
  const server = config.server

  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let stopped = false

    const post = async (): Promise<void> => {
      const digest = await composeDigest(ctx, {
        days,
        includeChores,
        choreLookaheadDays,
        includeMail,
        ...server !== undefined ? { server } : {},
      })
      if (config.skipWhenEmpty === true && !digest.hasContent) return
      await ctx.discord.announce(config.channelId, digest.text)
    }

    const schedule = (): void => {
      if (stopped) return
      const due = nextRun(ctx.household, at, new Date())
      const delay = Math.max(1_000, due.getTime() - Date.now())
      timer = setTimeout(() => {
        // Re-arm before posting so one failed morning does not end the series.
        schedule()
        void post().catch(() => undefined)
      }, delay)
      // A pending digest must not hold the process open on its own.
      timer.unref?.()
    }

    schedule()
    return () => {
      stopped = true
      if (timer !== undefined) clearTimeout(timer)
    }
  })
}
