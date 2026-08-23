/**
 * Cycle storage: planning conversations as VTODOs in Nextcloud.
 *
 * This is where the "consensus is state" decision becomes concrete. A cycle is a
 * parent VTODO and one subtask per family member, linked by `RELATED-TO`. Reading
 * "who has not weighed in" is then reading which subtasks are still open — no
 * separate bookkeeping, and nothing that a restart can lose.
 *
 * The link direction matters and is not arbitrary. In the Nextcloud Tasks app
 * (`src/store/tasks.js`) a task's parent is found with `task.related === parent.uid`,
 * so **the child carries the parent's UID**. Its `getParent()` accepts a
 * `RELATED-TO` with `RELTYPE=PARENT` *or with no parameter at all*, so a plain
 * `RELATED-TO:<uid>` is enough. Getting this backwards would produce subtasks the
 * family cannot see, which is the one failure that would quietly undermine the whole
 * design.
 *
 * Two custom properties carry the butler's own bookkeeping: how many times it has
 * raised the cycle, and when it last did. They are `X-` properties because there is
 * no standard field for them, they are nobody's business but the butler's, and the
 * Tasks app ignores properties it does not know (it writes several `X-OC-*` of its
 * own).
 *
 * @module dsh-planner/store
 */

import {
  createObject,
  loadIcal,
  parseObject,
  readTodo,
  touch,
  writeCategories,
  writeText,
  writeWhen,
} from 'dsh-caldav'
import type { IcalComponent } from 'dsh-caldav'
import type { Context } from '@deepseek-ai/cordis'
import { subtaskUid } from './cycles.ts'
import type { CycleId, CycleState } from './cycles.ts'

/** Custom property counting how many times the butler has raised a cycle. */
export const PROMPTS_PROPERTY = 'x-butler-prompts'

/** Custom property recording the date a cycle was last raised. */
export const LAST_PROMPT_PROPERTY = 'x-butler-last-prompt'

/** Custom property naming which member a subtask belongs to. */
export const MEMBER_PROPERTY = 'x-butler-member'

/** Lowest RFC 5545 priority, so planning tasks sort below real chores. */
const LOW_PRIORITY = 9

/** What the planner needs from durable storage. */
export interface CycleStore {
  /** Create the parent VTODO and one subtask per member, then record the first ask. */
  openCycle(cycle: CycleId, members: readonly string[], today: string): Promise<void>
  /** Read a cycle's current state, or `undefined` when it does not exist yet. */
  readCycle(cycle: CycleId): Promise<CycleState | undefined>
  /** Note that the cycle was raised again. */
  recordPrompt(cycle: CycleId, today: string): Promise<void>
  /** Mark the parent complete so it is never reopened. */
  closeCycle(cycle: CycleId): Promise<void>
}

/** How a subtask is titled, so the family knows what is being asked of them. */
export function subtaskSummary(displayName: string, label: string): string {
  return `${displayName}: what would you like to do for ${label}?`
}

/** How the parent is titled. */
export function parentSummary(label: string): string {
  return `Plan ${label}`
}

/**
 * Read a custom property off a VTODO as a number, defaulting when absent or junk.
 *
 * Defaulting rather than throwing because these are the butler's own notes: a
 * corrupt counter should cost at most one extra nudge, not stop the cycle.
 */
function readCount(todo: { getFirstPropertyValue(name: string): unknown }, name: string): number {
  const raw = todo.getFirstPropertyValue(name)
  const value = Number(typeof raw === 'string' ? raw : Number.NaN)
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0
}

/** Read a custom property off a VTODO as a string, when present. */
function readString(todo: { getFirstPropertyValue(name: string): unknown }, name: string): string | undefined {
  const raw = todo.getFirstPropertyValue(name)
  return typeof raw === 'string' && raw !== '' ? raw : undefined
}

/** Whether a VTODO counts as finished for consensus purposes. */
export function isAnswered(fields: {
  status?: string | undefined
  completed?: string | undefined
  percentComplete: number
}): boolean {
  if (fields.status === 'COMPLETED' || fields.status === 'CANCELLED') return true
  if (fields.completed !== undefined) return true
  return fields.percentComplete >= 100
}

/** Members and the collection the store writes into. */
export interface CycleStoreOptions {
  /** Calendar collection name. */
  readonly calendar: string
  /** CalDAV server name, when not the default. */
  readonly server?: string
  /** Resolve a roster key to a display name for the subtask title. */
  readonly displayName: (key: string) => string
}

/**
 * A cycle store backed by CalDAV.
 *
 * Every write is idempotent by construction: uids are deterministic, so creating a
 * cycle that already exists is refused by the server with a `conflict` rather than
 * producing a duplicate. That is what makes a catch-up pass after a restart safe to
 * run without checking first.
 */
export class CalDavCycleStore implements CycleStore {
  private readonly ctx: Context
  private readonly options: CycleStoreOptions

  constructor(ctx: Context, options: CycleStoreOptions) {
    this.ctx = ctx
    this.options = options
  }

  private get serverOption(): { server?: string } {
    const server = this.options.server
    return server !== undefined ? { server } : {}
  }

  async openCycle(cycle: CycleId, members: readonly string[], today: string): Promise<void> {
    const ICAL = await loadIcal()
    const now = new Date()
    const parent = createObject(ICAL, 'VTODO', cycle.uid, now)
    writeText(parent.target, 'summary', parentSummary(cycle.label))
    writeText(
      parent.target,
      'description',
      'Opened by the butler. Each family member has a subtask; tick yours off once you have said what you want.',
    )
    writeWhen(ICAL, parent.target, 'due', { value: cycle.targetDate })
    parent.target.updatePropertyWithValue('priority', LOW_PRIORITY)
    parent.target.updatePropertyWithValue('status', 'NEEDS-ACTION')
    parent.target.updatePropertyWithValue(PROMPTS_PROPERTY, '1')
    parent.target.updatePropertyWithValue(LAST_PROMPT_PROPERTY, today)
    touch(ICAL, parent.target, now)

    // The parent goes in first. If it is refused as a duplicate the cycle already
    // exists and the subtasks do too, so there is nothing left to do.
    await this.ctx.caldav.create({
      calendar: this.options.calendar,
      component: 'VTODO',
      ical: parent.root.toString(),
      uid: cycle.uid,
      ...this.serverOption,
    })

    for (const key of members) {
      const uid = subtaskUid(cycle.uid, key)
      const child = createObject(ICAL, 'VTODO', uid, now)
      writeText(child.target, 'summary', subtaskSummary(this.options.displayName(key), cycle.label))
      writeWhen(ICAL, child.target, 'due', { value: cycle.targetDate })
      child.target.updatePropertyWithValue('priority', LOW_PRIORITY)
      child.target.updatePropertyWithValue('status', 'NEEDS-ACTION')
      // The child carries the parent's uid — the direction the Tasks app reads.
      child.target.updatePropertyWithValue('related-to', cycle.uid)
      child.target.updatePropertyWithValue(MEMBER_PROPERTY, key)
      writeCategories(ICAL, child.target, [this.options.displayName(key)])
      touch(ICAL, child.target, now)
      // One member's subtask failing must not lose the others.
      await this.ctx.caldav.create({
        calendar: this.options.calendar,
        component: 'VTODO',
        ical: child.root.toString(),
        uid,
        ...this.serverOption,
      }).catch(() => undefined)
    }
  }

  async readCycle(cycle: CycleId): Promise<CycleState | undefined> {
    // No time filter: an undated or far-future planning task must stay reachable,
    // and RFC 4791 would exclude an undated VTODO from a time-range query.
    const records = await this.ctx.caldav.objects({
      calendar: this.options.calendar,
      component: 'VTODO',
      ...this.serverOption,
    })
    let parent: CycleState | undefined
    const answered: string[] = []
    const waiting: string[] = []
    let closed = false
    let prompts = 0
    let lastPrompt: string | undefined

    for (const record of records) {
      // A single unparseable object must not hide the rest of the cycle.
      const parsed = await parseObject(record.ical, 'VTODO').catch(() => undefined)
      if (parsed === undefined) continue
      const fields = readTodo(parsed.target)
      if (fields.uid === cycle.uid) {
        closed = isAnswered(fields)
        prompts = readCount(parsed.target, PROMPTS_PROPERTY)
        lastPrompt = readString(parsed.target, LAST_PROMPT_PROPERTY)
        parent = { uid: cycle.uid, closed, answered: [], waiting: [], prompts }
        continue
      }
      if (fields.relatedTo !== cycle.uid) continue
      const key = readString(parsed.target, MEMBER_PROPERTY)
      if (key === undefined) continue
      if (isAnswered(fields)) answered.push(key)
      else waiting.push(key)
    }

    if (parent === undefined) return undefined
    return {
      uid: cycle.uid,
      closed,
      answered,
      waiting,
      prompts,
      ...lastPrompt === undefined ? {} : { lastPrompt },
    }
  }

  async recordPrompt(cycle: CycleId, today: string): Promise<void> {
    await this.mutateParent(cycle, (ICAL, todo, now) => {
      todo.updatePropertyWithValue(PROMPTS_PROPERTY, String(readCount(todo, PROMPTS_PROPERTY) + 1))
      todo.updatePropertyWithValue(LAST_PROMPT_PROPERTY, today)
      touch(ICAL, todo, now)
    })
  }

  async closeCycle(cycle: CycleId): Promise<void> {
    await this.mutateParent(cycle, (ICAL, todo, now) => {
      todo.updatePropertyWithValue('status', 'COMPLETED')
      todo.updatePropertyWithValue('percent-complete', 100)
      todo.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(now, true))
      touch(ICAL, todo, now)
    })
  }

  /**
   * Find the parent VTODO and apply a change to it, preserving its ETag.
   *
   * The ETag is passed back on the update so a concurrent edit from somebody's
   * phone is reported as a conflict rather than silently overwritten — the family
   * editing their own tasks is expected, not an error.
   */
  private async mutateParent(
    cycle: CycleId,
    change: (ICAL: Awaited<ReturnType<typeof loadIcal>>, todo: IcalComponent, now: Date) => void,
  ): Promise<void> {
    const ICAL = await loadIcal()
    const records = await this.ctx.caldav.objects({
      calendar: this.options.calendar,
      component: 'VTODO',
      ...this.serverOption,
    })
    for (const record of records) {
      const parsed = await parseObject(record.ical, 'VTODO').catch(() => undefined)
      if (parsed === undefined) continue
      if (readTodo(parsed.target).uid !== cycle.uid) continue
      change(ICAL, parsed.target, new Date())
      await this.ctx.caldav.update({
        url: record.url,
        ical: parsed.root.toString(),
        ...record.etag !== undefined ? { etag: record.etag } : {},
        ...this.serverOption,
      })
      return
    }
  }
}
