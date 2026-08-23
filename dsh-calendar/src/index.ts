/**
 * dsh-calendar — the family calendar, as tools the butler can call.
 *
 * Five tools over the `ctx.caldav` and `ctx.household` seams: read the agenda,
 * add an event, move one, cancel one, and find time nobody has claimed. Each
 * writes standard VEVENTs to ordinary CalDAV collections, so an event the
 * butler creates is indistinguishable from one typed into Nextcloud Calendar,
 * a phone, or any other client.
 *
 * Every result is phrased in the household's own time zone and names people by
 * the names the family uses, because the text goes straight into a chat room
 * that several people read.
 *
 * @module dsh-calendar
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  createObject,
  loadIcal,
  parseObject,
  touch,
  writeCategories,
  writeText,
  writeWhen,
} from 'dsh-caldav'
// Type-only: carries the `ctx.caldav` Context declaration.
import type {} from 'dsh-caldav'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'
import type { HouseholdMember } from 'dsh-household'
import {
  collectEvents,
  findEventByUid,
  findFreeSlots,
  formatAgenda,
  scopeFor,
} from './events.ts'

export {
  collectEvents,
  findEventByUid,
  findFreeSlots,
  formatAgenda,
  scopeFor,
} from './events.ts'
export type { CalendarScope, EventEntry, FreeSlot } from './events.ts'

/** Cordis plugin name. */
export const name = 'calendar'
/** The CalDAV seam, the roster, and the tool registry. */
export const inject = ['caldav', 'household', 'tools']

/** How many days an agenda covers when the caller does not say. */
export const DEFAULT_AGENDA_DAYS = 1
/** How long an event lasts when the caller gives neither an end nor a duration. */
export const DEFAULT_EVENT_MINUTES = 60
/** First and last hour of the day the butler will offer for a new appointment. */
export const DEFAULT_EARLIEST_HOUR = 8
export const DEFAULT_LATEST_HOUR = 21

/** Plugin configuration. */
export interface Config {
  /** Days an agenda covers when the caller does not say. */
  agendaDays?: number
  /** Minutes an event lasts when the caller gives neither an end nor a duration. */
  defaultEventMinutes?: number
  /** Earliest hour (0–23) offered when looking for free time. */
  earliestHour?: number
  /** Latest hour (1–24) offered when looking for free time. */
  latestHour?: number
  /** CalDAV server name, when more than one is configured. */
  server?: string
}

export const Config: z<Config> = z.object({
  agendaDays: z.number().step(1).min(1).max(60).default(DEFAULT_AGENDA_DAYS),
  defaultEventMinutes: z.number().step(1).min(5).max(1440).default(DEFAULT_EVENT_MINUTES),
  earliestHour: z.number().step(1).min(0).max(23).default(DEFAULT_EARLIEST_HOUR),
  latestHour: z.number().step(1).min(1).max(24).default(DEFAULT_LATEST_HOUR),
  server: z.string(),
})

/** A tool's canonical output is one text block; the channel relays it verbatim. */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render(_args: unknown, value: string) {
    return [{ type: 'text', text: value }] as never
  },
} as const

/** Describe a thrown value for a model-facing message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Resolve an optional person argument, distinguishing "not asked" from
 * "asked about someone I do not know".
 */
function resolvePerson(ctx: Context, person: string | undefined): HouseholdMember | undefined {
  if (person === undefined || person.trim() === '') return undefined
  return ctx.household.require(person)
}

/** Append the problems a partial read reported, so a gap is never silent. */
function withProblems(body: string, problems: readonly string[]): string {
  if (problems.length === 0) return body
  return `${body}\n\nSome calendars could not be read:\n${problems.map(line => `- ${line}`).join('\n')}`
}

/**
 * Mount the calendar tools.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const server = config.server
  const serverOption = server !== undefined ? { server } : {}
  const agendaDays = config.agendaDays ?? DEFAULT_AGENDA_DAYS
  const defaultMinutes = config.defaultEventMinutes ?? DEFAULT_EVENT_MINUTES
  const earliestHour = config.earliestHour ?? DEFAULT_EARLIEST_HOUR
  const latestHour = config.latestHour ?? DEFAULT_LATEST_HOUR

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'calendar_agenda',
        description:
          'Read what is scheduled for the family. Call this for any question about what is on, who is busy, '
          + 'or when something happens. Covers every family calendar unless you name a person or a calendar. '
          + 'Days are understood as the family says them: today, tomorrow, a weekday name, or YYYY-MM-DD.',
        parameters: {
          day: {
            type: 'string',
            description: 'Day the agenda starts on: today, tomorrow, a weekday name, or YYYY-MM-DD. Defaults to today.',
          },
          days: {
            type: 'number',
            description: `How many days to cover, starting at "day". Defaults to ${agendaDays}. Use 7 for "this week".`,
          },
          person: {
            type: 'string',
            description: 'Limit to one family member. Any name the family uses for them works.',
          },
          calendar: {
            type: 'string',
            description: 'Limit to one calendar by its display name. Rarely needed; prefer "person".',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Agenda${args.person !== undefined ? ` for ${args.person}` : ''} (${args.day ?? 'today'})`,
          kind: 'read' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          let person: HouseholdMember | undefined
          try {
            person = resolvePerson(ctx, args.person)
          } catch (error) {
            return describe(error)
          }
          const fromDay = household.day(args.day ?? '')
          if (fromDay === undefined) {
            return `I could not work out which day "${args.day}" means. Say today, tomorrow, a weekday, or a date like ${household.today()}.`
          }
          const days = Math.max(1, Math.trunc(args.days ?? agendaDays))
          const scope = scopeFor(household, {
            ...args.calendar !== undefined ? { calendar: args.calendar } : {},
            ...person !== undefined ? { person } : {},
          })
          if (scope.calendars.length === 0) {
            return `No calendar is configured to read (${scope.reason}). Set sharedCalendar, or a calendar for each member, in the dsh-household config.`
          }
          const window = household.window(fromDay, days)
          const { events, problems } = await collectEvents(ctx.caldav, scope.calendars, window)
          const heading = `Agenda for ${scope.reason}, ${days === 1 ? household.when(fromDay) : `${days} days from ${household.when(fromDay)}`} (${household.timezone}):`
          const body = formatAgenda(household, events, {
            fromDay,
            days,
            showCalendar: scope.calendars.length > 1,
          })
          return withProblems(`${heading}\n${body}`, problems)
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'calendar_add_event',
        description:
          'Put something on the family calendar. Use it for appointments, practices, trips, and birthdays. '
          + 'Give "start" as YYYY-MM-DD for a whole day or an ISO date-time for a timed event. Name "person" '
          + 'to file it on their own calendar; otherwise it goes on the shared family calendar.',
        parameters: {
          title: {
            type: 'string',
            description: 'What the event is, as it should appear on the calendar.',
            required: true,
          },
          start: {
            type: 'string',
            description: 'YYYY-MM-DD for a whole day, or an ISO date-time such as 2026-08-22T14:00:00Z.',
            required: true,
          },
          end: {
            type: 'string',
            description: 'When it finishes, in the same form as "start". Omit to use "duration_minutes".',
          },
          duration_minutes: {
            type: 'number',
            description: `How long it lasts. Ignored when "end" is given. Defaults to ${defaultMinutes} for a timed event.`,
          },
          person: {
            type: 'string',
            description: 'Whose event it is. Files it on their calendar and tags them so the agenda can say who.',
          },
          location: { type: 'string', description: 'Where it happens.' },
          notes: { type: 'string', description: 'Anything else worth recording on the event.' },
          repeat: {
            type: 'string',
            description: 'An iCalendar RRULE for a repeating event, e.g. FREQ=WEEKLY;BYDAY=TU or FREQ=YEARLY.',
          },
          calendar: {
            type: 'string',
            description: 'Write to a specific calendar by display name. Rarely needed; prefer "person".',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Add "${args.title}" to the calendar`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          let person: HouseholdMember | undefined
          try {
            person = resolvePerson(ctx, args.person)
          } catch (error) {
            return describe(error)
          }
          const scope = scopeFor(household, {
            ...args.calendar !== undefined ? { calendar: args.calendar } : {},
            ...person !== undefined ? { person } : {},
          })
          const target = scope.calendars[0] ?? household.sharedCalendar
          if (target === undefined) {
            return 'No calendar is configured to write to. Set sharedCalendar in the dsh-household config, or give a calendar name.'
          }
          const ICAL = await loadIcal()
          const now = new Date()
          const uid = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}-butler`
          const { root, target: event } = createObject(ICAL, 'VEVENT', uid, now)
          writeText(event, 'summary', args.title)
          writeText(event, 'location', args.location ?? undefined)
          writeText(event, 'description', args.notes ?? undefined)
          if (args.repeat !== undefined && args.repeat.trim() !== '') {
            writeText(event, 'rrule', args.repeat.trim().replace(/^RRULE:/i, ''))
          }
          const allDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start)
          try {
            writeWhen(ICAL, event, 'dtstart', { value: args.start })
            if (args.end !== undefined && args.end.trim() !== '') {
              writeWhen(ICAL, event, 'dtend', { value: args.end })
            } else if (allDay) {
              // An all-day VEVENT's DTEND is exclusive, so a single day ends the
              // next morning; without this a one-day event renders as zero-length.
              writeWhen(ICAL, event, 'dtend', { value: household.shiftDay(args.start, 1) })
            } else {
              const minutes = Math.max(1, Math.trunc(args.duration_minutes ?? defaultMinutes))
              const end = new Date(new Date(args.start).getTime() + minutes * 60_000)
              writeWhen(ICAL, event, 'dtend', { value: end.toISOString() })
            }
          } catch (error) {
            return describe(error)
          }
          if (person !== undefined) {
            writeCategories(ICAL, event, [person.tag])
            if (person.email !== undefined) {
              const attendee = new ICAL.Property('attendee', event)
              attendee.setValue(`mailto:${person.email}`)
              attendee.setParameter('cn', person.displayName)
              event.addProperty(attendee)
            }
          }
          try {
            await ctx.caldav.create({
              calendar: target,
              component: 'VEVENT',
              ical: root.toString(),
              uid,
              ...serverOption,
            })
          } catch (error) {
            return `I could not save that event: ${describe(error)}`
          }
          const whose = person !== undefined ? ` for ${person.displayName}` : ''
          const repeats = args.repeat !== undefined && args.repeat.trim() !== '' ? ' (repeating)' : ''
          return `Added "${args.title}"${whose} on ${household.when(args.start)}${repeats} to "${target}". `
            + `Its id is ${uid} if it needs moving or cancelling.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'calendar_move_event',
        description:
          'Reschedule an existing event to a new time, keeping everything else about it. Needs the event id '
          + 'reported by calendar_agenda or calendar_add_event. Call calendar_agenda first if you do not have one.',
        parameters: {
          event_id: {
            type: 'string',
            description: 'The event id (its iCalendar UID).',
            required: true,
          },
          start: {
            type: 'string',
            description: 'New start: YYYY-MM-DD for a whole day, or an ISO date-time.',
            required: true,
          },
          end: { type: 'string', description: 'New end, in the same form as "start".' },
          duration_minutes: {
            type: 'number',
            description: 'New length in minutes. Ignored when "end" is given; omit both to keep the current length.',
          },
          calendar: { type: 'string', description: 'Calendar to search, when you already know it.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Move event ${args.event_id}`,
          kind: 'move' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const scope = scopeFor(household, args.calendar !== undefined ? { calendar: args.calendar } : {})
          if (scope.calendars.length === 0) return `No calendar is configured to search (${scope.reason}).`
          const entry = await findEventByUid(ctx.caldav, scope.calendars, args.event_id)
          if (entry === undefined) {
            return `I could not find an event with id ${args.event_id} in ${scope.reason}. `
              + 'Read the agenda again — the id may be stale, or the event may live on a calendar I was not given.'
          }
          const previousStart = entry.fields.start
          const previousLength = entry.fields.end !== undefined && !entry.fields.allDay
            ? new Date(entry.fields.end).getTime() - new Date(previousStart).getTime()
            : undefined
          const ICAL = await loadIcal()
          // Modify the original text so alarms, attendees, and client extensions survive.
          const { root, target: event } = await parseObject(entry.ical, 'VEVENT')
          try {
            writeWhen(ICAL, event, 'dtstart', { value: args.start })
            const allDay = /^\d{4}-\d{2}-\d{2}$/.test(args.start)
            if (args.end !== undefined && args.end.trim() !== '') {
              writeWhen(ICAL, event, 'dtend', { value: args.end })
            } else if (args.duration_minutes !== undefined) {
              const end = new Date(new Date(args.start).getTime() + Math.max(1, Math.trunc(args.duration_minutes)) * 60_000)
              writeWhen(ICAL, event, 'dtend', { value: end.toISOString() })
            } else if (allDay) {
              writeWhen(ICAL, event, 'dtend', { value: household.shiftDay(args.start, 1) })
            } else if (previousLength !== undefined && previousLength > 0) {
              const end = new Date(new Date(args.start).getTime() + previousLength)
              writeWhen(ICAL, event, 'dtend', { value: end.toISOString() })
            }
          } catch (error) {
            return describe(error)
          }
          touch(ICAL, event, new Date())
          try {
            await ctx.caldav.update({
              url: entry.url,
              ical: root.toString(),
              ...entry.etag !== undefined ? { etag: entry.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not move that event: ${describe(error)}`
          }
          return `Moved "${entry.fields.summary}" from ${household.when(previousStart)} to ${household.when(args.start)}.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'calendar_cancel_event',
        description:
          'Remove an event from the calendar. Needs the event id reported by calendar_agenda. This deletes the '
          + 'event for everyone, so confirm with the person who asked before calling it if there is any doubt.',
        parameters: {
          event_id: {
            type: 'string',
            description: 'The event id (its iCalendar UID).',
            required: true,
          },
          calendar: { type: 'string', description: 'Calendar to search, when you already know it.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Cancel event ${args.event_id}`,
          kind: 'delete' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const scope = scopeFor(household, args.calendar !== undefined ? { calendar: args.calendar } : {})
          if (scope.calendars.length === 0) return `No calendar is configured to search (${scope.reason}).`
          const entry = await findEventByUid(ctx.caldav, scope.calendars, args.event_id)
          if (entry === undefined) {
            return `I could not find an event with id ${args.event_id} in ${scope.reason}.`
          }
          try {
            await ctx.caldav.remove({
              url: entry.url,
              ...entry.etag !== undefined ? { etag: entry.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not cancel that event: ${describe(error)}`
          }
          return `Cancelled "${entry.fields.summary}" (was ${household.when(entry.fields.start)}) from "${entry.calendar}".`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'calendar_find_free_time',
        description:
          'Find when the family, or particular members, have nothing scheduled. Use it before proposing a time '
          + 'for anything. All-day markers such as birthdays do not count as busy.',
        parameters: {
          day: {
            type: 'string',
            description: 'Day to start looking: today, tomorrow, a weekday name, or YYYY-MM-DD. Defaults to today.',
          },
          days: { type: 'number', description: 'How many days to search. Defaults to 7.' },
          duration_minutes: {
            type: 'number',
            description: 'How long the gap must be. Defaults to 60.',
          },
          people: {
            type: 'string',
            description: 'Comma-separated family members who must all be free. Omit to consider every calendar.',
          },
          earliest_hour: {
            type: 'number',
            description: `Earliest hour of the day to offer, 0–23. Defaults to ${earliestHour}.`,
          },
          latest_hour: {
            type: 'number',
            description: `Latest hour of the day to offer, 1–24. Defaults to ${latestHour}.`,
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Find ${args.duration_minutes ?? 60} free minutes`,
          kind: 'search' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const fromDay = household.day(args.day ?? '')
          if (fromDay === undefined) {
            return `I could not work out which day "${args.day}" means. Say today, tomorrow, a weekday, or a date like ${household.today()}.`
          }
          const days = Math.max(1, Math.trunc(args.days ?? 7))
          const minutes = Math.max(1, Math.trunc(args.duration_minutes ?? 60))
          const from = Math.min(23, Math.max(0, Math.trunc(args.earliest_hour ?? earliestHour)))
          const to = Math.min(24, Math.max(from + 1, Math.trunc(args.latest_hour ?? latestHour)))
          const calendars = new Set<string>()
          let who = 'the whole family'
          if (args.people !== undefined && args.people.trim() !== '') {
            const names: string[] = []
            for (const raw of args.people.split(',')) {
              if (raw.trim() === '') continue
              let member: HouseholdMember
              try {
                member = household.require(raw)
              } catch (error) {
                return describe(error)
              }
              names.push(member.displayName)
              const scope = scopeFor(household, { person: member })
              for (const calendar of scope.calendars) calendars.add(calendar)
            }
            who = names.join(' and ')
          } else {
            for (const calendar of scopeFor(household, {}).calendars) calendars.add(calendar)
          }
          if (calendars.size === 0) return 'No calendars are configured, so I cannot tell who is free.'
          const window = household.window(fromDay, days)
          const { events, problems } = await collectEvents(ctx.caldav, [...calendars], window)
          const slots = findFreeSlots(household, events, {
            fromDay,
            days,
            minutes,
            earliestHour: from,
            latestHour: to,
          })
          if (slots.length === 0) {
            return withProblems(
              `I found no ${minutes}-minute gap for ${who} between ${from}:00 and ${to}:00 over the next ${days} day(s).`,
              problems,
            )
          }
          const lines = slots.slice(0, 20).map((slot) => {
            const length = Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000)
            return `- ${household.when(slot.start.toISOString())} to ${household.timeOfDay(slot.end.toISOString())} (${length} min)`
          })
          const more = slots.length > lines.length ? `\n…and ${slots.length - lines.length} more.` : ''
          return withProblems(
            `${who} could fit ${minutes} minutes here (${household.timezone}):\n${lines.join('\n')}${more}`,
            problems,
          )
        },
      }),
    ),
  )
}
