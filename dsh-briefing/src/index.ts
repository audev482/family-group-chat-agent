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
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// Type-only: carries the `ctx.agentDefaultModel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
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
import { withinHourJitter } from 'dsh-household'
import type { TimeOfDay } from './schedule.ts'
// Type-only: carries the `ctx.mail` Context declaration. Mail is a soft
// dependency — see `unreadMailLine`.
import type {} from 'dsh-mail'

export { nextRun, parseTimeOfDay } from './schedule.ts'
export type { ScheduleClock, TimeOfDay } from './schedule.ts'

/** Cordis plugin name. */
export const name = 'briefing'
/** The channel to speak through, the data to speak about, and the roster to name people by. */
export const inject = ['discord', 'caldav', 'household', 'agents', 'agentDefaultModel']

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
  /**
   * After the digest, run one agent turn over the unread inbox: the model
   * judges each message's future utility and deletes what has none, keeping
   * anything personal, financial, legal, or plausibly reference-worthy. The
   * triage summary posts into the room so the family can audit every call.
   */
  mailTriage?: boolean
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
  mailTriage: z.boolean().default(false),
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
  // The proxy throws on an undeclared service rather than returning undefined
  // (mail is deliberately absent from `inject` so the digest works without a
  // mailbox), so the soft read has to be failure-tolerant.
  let mail: Context['mail']
  try {
    mail = (ctx as { mail?: Context['mail'] }).mail
  } catch {
    return undefined
  }
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
      if (config.mailTriage !== true) return
      // The triage speaks only when something deserves attention; routine
      // deletions happen silently.
      const triage = await mailTriageTurn(ctx)
      if (triage.trim() !== '') await ctx.discord.announce(config.channelId, triage)
    }

    const schedule = (): void => {
      if (stopped) return
      const due = withinHourJitter(nextRun(ctx.household, at, new Date()), new Date())
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

/** Stable session identity for the daily mail triage, so it remembers past calls. */
const TRIAGE_SESSION_ID = SessionId('briefing-mail-triage')

const TRIAGE_PROMPT = `Morning mail triage. Use your mail tools to list the unread messages in INBOX, then decide each one's fate by its future utility:

- DELETE: marketing, newsletters, automated notifications whose content is already reflected elsewhere (bank apps, package trackers), and anything with no value to a household once read.
- KEEP (mark as read only): personal correspondence, financial or legal records, receipts for purchases that might be returned or expensed, appointments or travel confirmations, and anything you are unsure about.

Be conservative: when in doubt, keep. Then stay quiet unless something genuinely deserves the family's attention — a message someone should read or act on. If there is such a message, say so in one short line each ("Dentist confirmed Thursday 3pm — no action needed"). Otherwise reply with nothing at all: no counts, no lists of what you deleted, no play-by-play.`

/**
 * Run the agentic inbox triage through its own durable session.
 *
 * The session id is stable across restarts so the triage accumulates memory of
 * what this family keeps and discards — the judgment is supposed to improve
 * with use rather than start over every morning.
 * @param ctx - plugin context; requires agents and agentDefaultModel.
 * @returns the model's report text, possibly empty.
 */
async function mailTriageTurn(ctx: Context): Promise<string> {
  const selection = ctx.agentDefaultModel.currentSelection()
  const agentOptions = { provider: selection.provider, model: selection.model }
  const setup = (agentCtx: Context): void => {
    installModelSelection(agentCtx, { current: selection, assembled: undefined })
  }
  const handle = await ctx.agents.create({
    sessionId: TRIAGE_SESSION_ID,
    meta: { cwd: process.cwd() },
    agentOptions,
    setup,
  }).catch(async () => await ctx.agents.resume({
    resumeSessionId: TRIAGE_SESSION_ID,
    agentOptions,
    setup,
  }))
  try {
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: TRIAGE_PROMPT }] as never,
      source: { kind: 'plugin', name: 'dsh-briefing' },
    }))
    await agent.whenIdle()
    let text = ''
    for (const event of agent.session.events) {
      if (event.seq < firstSeq || event.type !== 'assistant/message') continue
      const joined = event.data.message.content
        .filter((block: { type: string }) => block.type === 'text')
        .map((block: { text?: string }) => block.text ?? '')
        .join('')
      if (joined !== '') text = joined
    }
    return text
  } finally {
    await handle.dispose().catch(() => undefined)
  }
}
