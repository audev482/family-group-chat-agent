/**
 * dsh-chores — the household's shared work, as tools the butler can call.
 *
 * These are **jobs for people**: take the bins out, book the boiler service,
 * pack a swimming kit. They are stored as standard VTODOs in an ordinary CalDAV
 * collection, which is exactly what the Nextcloud Tasks app reads and writes, so
 * every chore the butler files appears as a normal task on every family member's
 * phone and can be ticked off there without the butler involved.
 *
 * That constraint shapes the whole package: nothing is stored anywhere the
 * family cannot see and edit, and assignment travels in `CATEGORIES` because
 * that is the only assignment channel the Tasks UI exposes.
 *
 * Tools: list, add, complete, reassign, reschedule, and drop.
 *
 * @module dsh-chores
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
  assigneeOf,
  byUrgency,
  choreLine,
  collectChores,
  findChoreByUid,
  formatChoresByPerson,
  isCancelled,
  isDone,
  labelsOf,
  matchBySummary,
} from './chores.ts'
import type { ChoreEntry } from './chores.ts'

export {
  assigneeOf,
  byUrgency,
  choreLine,
  collectChores,
  findChoreByUid,
  formatChoresByPerson,
  isCancelled,
  isDone,
  labelsOf,
  matchBySummary,
} from './chores.ts'
export type { ChoreEntry } from './chores.ts'

/** Cordis plugin name. */
export const name = 'chores'
/** The CalDAV seam, the roster, and the tool registry. */
export const inject = ['caldav', 'household', 'tools']

/** Priority written when a chore is called urgent, on RFC 5545's 1–9 scale. */
export const HIGH_PRIORITY = 1
/** Priority written when a chore is explicitly not urgent. */
export const LOW_PRIORITY = 9

/** Plugin configuration. */
export interface Config {
  /**
   * Collection holding household VTODOs. Defaults to the household's
   * `choresCalendar`, which is where it normally belongs.
   */
  calendar?: string
  /** CalDAV server name, when more than one is configured. */
  server?: string
  /** Whether a new chore with no due date is given one; off by default. */
  requireDueDate?: boolean
}

export const Config: z<Config> = z.object({
  calendar: z.string(),
  server: z.string(),
  requireDueDate: z.boolean().default(false),
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
 * Mount the chore tools.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const server = config.server
  const serverOption = server !== undefined ? { server } : {}

  /** The collection chores live in, or a message explaining that none is configured. */
  function choresCalendar(): string | undefined {
    return config.calendar ?? ctx.household.choresCalendar
  }

  const NO_CALENDAR = 'No chore list is configured. Create a task list in the Nextcloud Tasks app, then set '
    + 'choresCalendar in the dsh-household config (or calendar in the dsh-chores config) to its name.'

  /**
   * Resolve the one chore a person meant, by id or by what they called it.
   * Returns a message instead of an entry when the reference is ambiguous or
   * unknown, so no tool acts on a guess.
   */
  async function locate(reference: string, calendar: string): Promise<ChoreEntry | string> {
    const byId = await findChoreByUid(ctx.caldav, calendar, reference, server)
    if (byId !== undefined) return byId
    const { chores } = await collectChores(ctx.caldav, calendar, server)
    const open = chores.filter(entry => !isDone(entry.fields) && !isCancelled(entry.fields))
    const matches = matchBySummary(open.length > 0 ? open : chores, reference)
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) {
      return `I could not find a chore matching "${reference}". Call chores_list to see what is on the list.`
    }
    const household = ctx.household
    const options = matches
      .slice(0, 8)
      .map(entry => choreLine(household, entry, { showAssignee: true }))
      .join('\n')
    return `"${reference}" matches more than one chore. Which one?\n${options}`
  }

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_list',
        description:
          'Read the household chore list — the jobs the family has to do. Call this for "what needs doing", '
          + '"what is on my list", "who has to do what", or before completing or changing a chore, because it '
          + 'reports the ids the other chore tools need. Open chores only unless you ask for done ones.',
        parameters: {
          person: {
            type: 'string',
            description: 'Only this person\'s chores. Any name the family uses works. Use "unassigned" for chores nobody has taken.',
          },
          due_within_days: {
            type: 'number',
            description: 'Only chores due within this many days (overdue ones always count as due). Omit for all.',
          },
          include_done: {
            type: 'boolean',
            description: 'Include finished and dropped chores. Defaults to false.',
          },
          search: {
            type: 'string',
            description: 'Only chores whose title matches this text.',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Chore list${args.person !== undefined ? ` for ${args.person}` : ''}`,
          kind: 'read' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          const wantsUnassigned = args.person?.trim().toLowerCase() === 'unassigned'
          let person: HouseholdMember | undefined
          if (!wantsUnassigned && args.person !== undefined && args.person.trim() !== '') {
            try {
              person = household.require(args.person)
            } catch (error) {
              return describe(error)
            }
          }
          let chores: ChoreEntry[]
          let problems: string[]
          try {
            ({ chores, problems } = await collectChores(ctx.caldav, calendar, server))
          } catch (error) {
            return `I could not read the chore list: ${describe(error)}`
          }
          const today = household.today()
          let visible = args.include_done === true
            ? chores
            : chores.filter(entry => !isDone(entry.fields) && !isCancelled(entry.fields))
          if (person !== undefined) {
            visible = visible.filter(entry => assigneeOf(household, entry.fields)?.key === person.key)
          } else if (wantsUnassigned) {
            visible = visible.filter(entry => assigneeOf(household, entry.fields) === undefined)
          }
          if (args.due_within_days !== undefined) {
            const limit = household.shiftDay(today, Math.max(0, Math.trunc(args.due_within_days)))
            visible = visible.filter((entry) => {
              const due = entry.fields.due?.slice(0, 10)
              return due !== undefined && due <= limit
            })
          }
          if (args.search !== undefined && args.search.trim() !== '') {
            visible = matchBySummary(visible, args.search)
          }
          const scope = person !== undefined
            ? `${person.displayName}'s chores`
            : wantsUnassigned ? 'unassigned chores' : 'household chores'
          if (visible.length === 0) {
            const suffix = args.include_done === true ? '' : ' Nothing is outstanding.'
            return `No ${scope} match that.${suffix}`
          }
          const body = person !== undefined || wantsUnassigned
            ? byUrgency(visible, today).map(entry => choreLine(household, entry, { showAssignee: false })).join('\n')
            : formatChoresByPerson(household, visible)
          const trouble = problems.length > 0 ? `\n\nSome items could not be read:\n${problems.map(line => `- ${line}`).join('\n')}` : ''
          return `${visible.length} ${scope} (list "${calendar}", ${household.timezone}):\n${body}${trouble}`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_add',
        description:
          'Add a job to the household chore list. Use it whenever someone says something needs doing. '
          + 'Assign it with "person" when it is somebody\'s job, or leave it unassigned for anyone to pick up. '
          + 'The chore appears as a normal task in Nextcloud Tasks on everyone\'s phone.',
        parameters: {
          title: {
            type: 'string',
            description: 'What needs doing, phrased as an instruction: "Take the bins out".',
            required: true,
          },
          person: {
            type: 'string',
            description: 'Whose job it is. Omit to leave it for anyone.',
          },
          due: {
            type: 'string',
            description: 'When it must be done by: today, tomorrow, a weekday name, YYYY-MM-DD, or an ISO date-time.',
          },
          urgent: {
            type: 'boolean',
            description: 'Mark it high priority so it sorts to the top of the list.',
          },
          notes: { type: 'string', description: 'Detail that helps whoever does it.' },
          repeat: {
            type: 'string',
            description: 'An iCalendar RRULE for a recurring chore, e.g. FREQ=WEEKLY;BYDAY=TU for the Tuesday bins.',
          },
          labels: {
            type: 'string',
            description: 'Comma-separated tags such as "kitchen,shopping". Do not put a person\'s name here; use "person".',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Add chore "${args.title}"${args.person !== undefined ? ` for ${args.person}` : ''}`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          let person: HouseholdMember | undefined
          if (args.person !== undefined && args.person.trim() !== '') {
            try {
              person = household.require(args.person)
            } catch (error) {
              return describe(error)
            }
          }
          let due: string | undefined
          if (args.due !== undefined && args.due.trim() !== '') {
            due = household.day(args.due) ?? (Number.isNaN(new Date(args.due).getTime()) ? undefined : args.due)
            if (due === undefined) {
              return `I could not work out when "${args.due}" is. Say today, tomorrow, a weekday, or a date like ${household.today()}.`
            }
          } else if (config.requireDueDate === true) {
            due = household.today()
          }
          const ICAL = await loadIcal()
          const now = new Date()
          const uid = `${now.getTime().toString(36)}-${Math.random().toString(36).slice(2, 10)}-chore`
          const { root, target: todo } = createObject(ICAL, 'VTODO', uid, now)
          writeText(todo, 'summary', args.title)
          writeText(todo, 'description', args.notes ?? undefined)
          writeText(todo, 'status', 'NEEDS-ACTION')
          todo.updatePropertyWithValue('percent-complete', 0)
          if (args.urgent === true) todo.updatePropertyWithValue('priority', HIGH_PRIORITY)
          if (args.repeat !== undefined && args.repeat.trim() !== '') {
            writeText(todo, 'rrule', args.repeat.trim().replace(/^RRULE:/i, ''))
          }
          if (due !== undefined) {
            try {
              writeWhen(ICAL, todo, 'due', { value: due })
            } catch (error) {
              return describe(error)
            }
          }
          const labels = (args.labels ?? '').split(',').map(label => label.trim()).filter(label => label !== '')
          writeCategories(ICAL, todo, [
            ...person !== undefined ? [person.tag] : [],
            ...labels,
          ])
          if (person?.email !== undefined) {
            // Mirrored for other CalDAV clients; CATEGORIES above stays authoritative.
            const attendee = new ICAL.Property('attendee', todo)
            attendee.setValue(`mailto:${person.email}`)
            attendee.setParameter('cn', person.displayName)
            todo.addProperty(attendee)
          }
          try {
            await ctx.caldav.create({
              calendar,
              component: 'VTODO',
              ical: root.toString(),
              uid,
              ...serverOption,
            })
          } catch (error) {
            return `I could not add that chore: ${describe(error)}`
          }
          const whose = person !== undefined ? ` for ${person.displayName}` : ' (unassigned)'
          const when = due !== undefined ? `, ${household.dueness(due)} (${household.when(due)})` : ', no due date'
          const repeats = args.repeat !== undefined && args.repeat.trim() !== '' ? ', recurring' : ''
          return `Added "${args.title}"${whose}${when}${repeats} to "${calendar}". Its id is ${uid}.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_complete',
        description:
          'Tick a chore off, or record partial progress on it. Accepts a chore id or just what the person '
          + 'called it ("the bins"). A recurring chore keeps its rule, so it comes back next time.',
        parameters: {
          chore: {
            type: 'string',
            description: 'The chore id, or what the person called it.',
            required: true,
          },
          percent: {
            type: 'number',
            description: 'Progress 0–100. Omit or pass 100 to finish it.',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Complete chore "${args.chore}"`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          let found: ChoreEntry | string
          try {
            found = await locate(args.chore, calendar)
          } catch (error) {
            return `I could not read the chore list: ${describe(error)}`
          }
          if (typeof found === 'string') return found
          const percent = args.percent === undefined ? 100 : Math.min(100, Math.max(0, Math.trunc(args.percent)))
          const ICAL = await loadIcal()
          const { root, target: todo } = await parseObject(found.ical, 'VTODO')
          const now = new Date()
          todo.updatePropertyWithValue('percent-complete', percent)
          if (percent >= 100) {
            writeText(todo, 'status', 'COMPLETED')
            writeWhen(ICAL, todo, 'completed', { value: now.toISOString() })
          } else {
            writeText(todo, 'status', percent > 0 ? 'IN-PROCESS' : 'NEEDS-ACTION')
            writeWhen(ICAL, todo, 'completed', null)
          }
          touch(ICAL, todo, now)
          try {
            await ctx.caldav.update({
              url: found.url,
              ical: root.toString(),
              ...found.etag !== undefined ? { etag: found.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not update that chore: ${describe(error)}`
          }
          const assignee = assigneeOf(household, found.fields)
          const who = assignee !== undefined ? ` (${assignee.displayName}'s)` : ''
          if (percent >= 100) {
            const again = found.fields.rrule !== undefined ? ' It recurs, so it will be back.' : ''
            return `Ticked off "${found.fields.summary}"${who}.${again}`
          }
          return `Recorded "${found.fields.summary}"${who} as ${percent}% done.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_assign',
        description:
          'Change whose job a chore is, or hand it back to nobody. Assignment is written as a tag the family '
          + 'can see and edit in Nextcloud Tasks, so this is the same change a person could make by hand.',
        parameters: {
          chore: {
            type: 'string',
            description: 'The chore id, or what the person called it.',
            required: true,
          },
          person: {
            type: 'string',
            description: 'Who it belongs to now. Pass "nobody" or "unassigned" to leave it for anyone.',
            required: true,
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Assign "${args.chore}" to ${args.person}`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          const wantsNobody = ['nobody', 'unassigned', 'anyone', 'none'].includes(args.person.trim().toLowerCase())
          let person: HouseholdMember | undefined
          if (!wantsNobody) {
            try {
              person = household.require(args.person)
            } catch (error) {
              return describe(error)
            }
          }
          let found: ChoreEntry | string
          try {
            found = await locate(args.chore, calendar)
          } catch (error) {
            return `I could not read the chore list: ${describe(error)}`
          }
          if (typeof found === 'string') return found
          const previous = assigneeOf(household, found.fields)
          const ICAL = await loadIcal()
          const { root, target: todo } = await parseObject(found.ical, 'VTODO')
          // Keep the chore's own labels; replace only the member tag.
          writeCategories(ICAL, todo, [
            ...person !== undefined ? [person.tag] : [],
            ...labelsOf(household, found.fields),
          ])
          todo.removeAllProperties('attendee')
          if (person?.email !== undefined) {
            const attendee = new ICAL.Property('attendee', todo)
            attendee.setValue(`mailto:${person.email}`)
            attendee.setParameter('cn', person.displayName)
            todo.addProperty(attendee)
          }
          touch(ICAL, todo, new Date())
          try {
            await ctx.caldav.update({
              url: found.url,
              ical: root.toString(),
              ...found.etag !== undefined ? { etag: found.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not reassign that chore: ${describe(error)}`
          }
          const from = previous !== undefined ? ` from ${previous.displayName}` : '';
          const to = person !== undefined ? person.displayName : 'nobody in particular'
          return `"${found.fields.summary}" is now ${to}'s${from === '' ? '' : `, taken${from}`}.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_reschedule',
        description:
          'Change when a chore is due, or clear its due date. Use it when something slips or turns out to be '
          + 'urgent. Also sets or clears high priority.',
        parameters: {
          chore: {
            type: 'string',
            description: 'The chore id, or what the person called it.',
            required: true,
          },
          due: {
            type: 'string',
            description: 'New due date: today, tomorrow, a weekday name, YYYY-MM-DD, an ISO date-time, or "none" to clear it.',
          },
          urgent: {
            type: 'boolean',
            description: 'true marks it high priority; false clears the priority.',
          },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Reschedule "${args.chore}"`,
          kind: 'edit' as const,
        }),
        execute: async (args) => {
          const household = ctx.household
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          if (args.due === undefined && args.urgent === undefined) {
            return 'Tell me what to change: a new "due" date, or "urgent" true or false.'
          }
          let found: ChoreEntry | string
          try {
            found = await locate(args.chore, calendar)
          } catch (error) {
            return `I could not read the chore list: ${describe(error)}`
          }
          if (typeof found === 'string') return found
          const ICAL = await loadIcal()
          const { root, target: todo } = await parseObject(found.ical, 'VTODO')
          let due: string | null | undefined
          if (args.due !== undefined) {
            const text = args.due.trim().toLowerCase()
            if (text === 'none' || text === 'never' || text === '') {
              due = null
            } else {
              const resolved = household.day(args.due)
                ?? (Number.isNaN(new Date(args.due).getTime()) ? undefined : args.due)
              if (resolved === undefined) {
                return `I could not work out when "${args.due}" is. Say today, tomorrow, a weekday, a date like ${household.today()}, or "none".`
              }
              due = resolved
            }
          }
          try {
            writeWhen(ICAL, todo, 'due', due === null ? null : due === undefined ? undefined : { value: due })
          } catch (error) {
            return describe(error)
          }
          if (args.urgent === true) todo.updatePropertyWithValue('priority', HIGH_PRIORITY)
          if (args.urgent === false) todo.removeAllProperties('priority')
          touch(ICAL, todo, new Date())
          try {
            await ctx.caldav.update({
              url: found.url,
              ical: root.toString(),
              ...found.etag !== undefined ? { etag: found.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not reschedule that chore: ${describe(error)}`
          }
          const when = due === null
            ? 'no longer has a due date'
            : due === undefined
              ? `is still ${found.fields.due !== undefined ? household.dueness(found.fields.due) : 'undated'}`
              : `is now ${household.dueness(due)} (${household.when(due)})`
          const priority = args.urgent === true ? ', marked urgent' : args.urgent === false ? ', no longer urgent' : ''
          return `"${found.fields.summary}" ${when}${priority}.`
        },
      }),
    ),
  )

  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'chores_drop',
        description:
          'Drop a chore that no longer needs doing. This marks it CANCELLED rather than deleting it, so the '
          + 'family can still see it was decided against. Use chores_complete when the job was actually done.',
        parameters: {
          chore: {
            type: 'string',
            description: 'The chore id, or what the person called it.',
            required: true,
          },
          reason: { type: 'string', description: 'Why it was dropped; recorded on the chore.' },
        },
        output: TEXT_OUTPUT,
        presentCall: args => ({
          card: 'generic' as const,
          title: `Drop chore "${args.chore}"`,
          kind: 'delete' as const,
        }),
        execute: async (args) => {
          const calendar = choresCalendar()
          if (calendar === undefined) return NO_CALENDAR
          let found: ChoreEntry | string
          try {
            found = await locate(args.chore, calendar)
          } catch (error) {
            return `I could not read the chore list: ${describe(error)}`
          }
          if (typeof found === 'string') return found
          const ICAL = await loadIcal()
          const { root, target: todo } = await parseObject(found.ical, 'VTODO')
          writeText(todo, 'status', 'CANCELLED')
          if (args.reason !== undefined && args.reason.trim() !== '') {
            const existing = found.fields.description
            const note = `Dropped: ${args.reason.trim()}`
            writeText(todo, 'description', existing === undefined ? note : `${existing}\n${note}`)
          }
          touch(ICAL, todo, new Date())
          try {
            await ctx.caldav.update({
              url: found.url,
              ical: root.toString(),
              ...found.etag !== undefined ? { etag: found.etag } : {},
              ...serverOption,
            })
          } catch (error) {
            return `I could not drop that chore: ${describe(error)}`
          }
          return `Dropped "${found.fields.summary}"${args.reason !== undefined ? ` (${args.reason.trim()})` : ''}.`
        },
      }),
    ),
  )
}
