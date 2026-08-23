/**
 * Reading, phrasing, and locating household VTODOs.
 *
 * Two decisions live here, and both exist because **the chores are for people,
 * not for the agent**.
 *
 * *Assignment is a `CATEGORIES` tag.* Of the standard VTODO properties, only
 * `CATEGORIES` is visible and editable in the Nextcloud Tasks UI, where it
 * renders as tags. `ATTENDEE` has no UI there at all. So the tag is
 * authoritative: a parent can reassign the bins by editing a tag on their
 * phone, and the butler reads that change on its next look. `ATTENDEE` is
 * mirrored for other CalDAV clients but never read back as authority, so a
 * stale mirror cannot contradict what the family sees.
 *
 * *Order is by urgency, not by creation.* A chore list is only useful if what
 * is overdue comes first, so sorting is part of reading rather than a caller's
 * responsibility.
 *
 * @module dsh-chores/chores
 */

import { parseObject, readTodo } from 'dsh-caldav'
import type { CalDav, TodoFields } from 'dsh-caldav'
import type { Household, HouseholdMember } from 'dsh-household'

/** One chore with the collection and concurrency token needed to change it. */
export interface ChoreEntry {
  /** Display name of the collection the chore lives in. */
  readonly calendar: string
  /** Absolute object URL. */
  readonly url: string
  /** ETag the chore was read with. */
  readonly etag?: string
  /** The raw iCalendar text, kept so a write can modify rather than rebuild it. */
  readonly ical: string
  /** The chore's fields. */
  readonly fields: TodoFields
}

/** Whether a chore counts as finished, by either of the two standard signals. */
export function isDone(fields: TodoFields): boolean {
  return fields.status === 'COMPLETED' || fields.completed !== undefined || fields.percentComplete >= 100
}

/** Whether a chore has been dropped rather than done. */
export function isCancelled(fields: TodoFields): boolean {
  return fields.status === 'CANCELLED'
}

/**
 * The member a chore is assigned to, read from its categories.
 * @param household - the roster.
 * @param fields - the chore's fields.
 * @returns the assignee, or `undefined` for a chore anyone can pick up.
 */
export function assigneeOf(household: Household, fields: TodoFields): HouseholdMember | undefined {
  return household.fromCategories(fields.categories)
}

/**
 * The categories on a chore that are not member tags, i.e. its real labels.
 * @param household - the roster.
 * @param fields - the chore's fields.
 * @returns the non-assignee categories.
 */
export function labelsOf(household: Household, fields: TodoFields): string[] {
  return fields.categories.filter(category => household.resolve(category) === undefined)
}

/** Sort key: overdue first, then by due date, then by priority, then by name. */
function urgency(entry: ChoreEntry, today: string): [number, string, number, string] {
  const fields = entry.fields
  const dueDay = fields.due?.slice(0, 10) ?? ''
  const overdue = dueDay !== '' && dueDay < today ? 0 : 1
  // Priority 0 means "unset" in RFC 5545, which must sort after every real
  // priority rather than before all of them.
  const priority = fields.priority === 0 ? 10 : fields.priority
  return [overdue, dueDay === '' ? '9999-12-31' : dueDay, priority, fields.summary.toLowerCase()]
}

/**
 * Order chores the way a person wants to read them: overdue first, then
 * soonest due, then highest priority.
 * @param entries - the chores to order.
 * @param today - the family's current date, `YYYY-MM-DD`.
 * @returns a new sorted array.
 */
export function byUrgency(entries: readonly ChoreEntry[], today: string): ChoreEntry[] {
  return [...entries].sort((left, right) => {
    const a = urgency(left, today)
    const b = urgency(right, today)
    for (let index = 0; index < a.length; index += 1) {
      const cmp = typeof a[index] === 'number'
        ? (a[index] as number) - (b[index] as number)
        : String(a[index]).localeCompare(String(b[index]))
      if (cmp !== 0) return cmp
    }
    return 0
  })
}

/**
 * Read every chore from one collection.
 *
 * No time-range filter is applied: an undated chore has no times to compare
 * against, and RFC 4791 would exclude it. Filtering happens after reading,
 * where "unassigned and undated" is still a visible chore.
 * @param caldav - the CalDAV seam.
 * @param calendar - collection display name or URL.
 * @param server - CalDAV server name, when more than one is configured.
 * @returns the chores found and one problem line per unreadable item.
 */
export async function collectChores(
  caldav: CalDav,
  calendar: string,
  server?: string,
): Promise<{ chores: ChoreEntry[]; problems: string[] }> {
  const chores: ChoreEntry[] = []
  const problems: string[] = []
  const records = await caldav.objects({
    calendar,
    component: 'VTODO',
    ...server !== undefined ? { server } : {},
  })
  for (const record of records) {
    try {
      const { target } = await parseObject(record.ical, 'VTODO')
      chores.push({
        calendar,
        url: record.url,
        ical: record.ical,
        fields: readTodo(target),
        ...record.etag !== undefined ? { etag: record.etag } : {},
      })
    } catch (error) {
      problems.push(`skipped an unreadable item: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { chores, problems }
}

/**
 * Find one chore by `UID`.
 * @param caldav - the CalDAV seam.
 * @param calendar - collection display name or URL.
 * @param uid - the chore's `UID`.
 * @param server - CalDAV server name, when more than one is configured.
 * @returns the chore, or `undefined` when the collection does not hold it.
 */
export async function findChoreByUid(
  caldav: CalDav,
  calendar: string,
  uid: string,
  server?: string,
): Promise<ChoreEntry | undefined> {
  const { chores } = await collectChores(caldav, calendar, server)
  const wanted = uid.trim()
  const exact = chores.find(entry => entry.fields.uid === wanted)
  if (exact !== undefined) return exact
  // People retype ids from chat, where case and surrounding punctuation drift.
  const folded = wanted.toLowerCase()
  return chores.find(entry => entry.fields.uid.toLowerCase() === folded)
}

/**
 * Find chores whose summary a person plausibly meant.
 *
 * Matching is deliberately generous — a person says "the bins", not the chore's
 * exact title — and every match is returned so a caller can ask which one
 * rather than acting on a guess.
 * @param entries - the chores to search.
 * @param phrase - what the person called it.
 * @returns the matches, most specific first.
 */
export function matchBySummary(entries: readonly ChoreEntry[], phrase: string): ChoreEntry[] {
  const needle = phrase.trim().toLowerCase()
  if (needle === '') return []
  const exact = entries.filter(entry => entry.fields.summary.toLowerCase() === needle)
  if (exact.length > 0) return exact
  const words = needle.split(/\s+/).filter(word => word.length > 2)
  return entries.filter((entry) => {
    const summary = entry.fields.summary.toLowerCase()
    if (summary.includes(needle)) return true
    return words.length > 0 && words.every(word => summary.includes(word))
  })
}

/** One chore as a line a person can act on. */
export function choreLine(household: Household, entry: ChoreEntry, options: { showAssignee: boolean }): string {
  const fields = entry.fields
  const parts: string[] = []
  if (isDone(fields)) parts.push('[done]')
  else if (isCancelled(fields)) parts.push('[dropped]')
  else if (fields.percentComplete > 0) parts.push(`[${fields.percentComplete}%]`)
  parts.push(fields.summary)
  if (fields.due !== undefined) parts.push(`— ${household.dueness(fields.due)} (${household.when(fields.due)})`)
  if (options.showAssignee) {
    const assignee = assigneeOf(household, fields)
    parts.push(assignee === undefined ? '— unassigned' : `— ${assignee.displayName}`)
  }
  if (fields.priority >= 1 && fields.priority <= 4) parts.push('(high priority)')
  if (fields.rrule !== undefined) parts.push('(recurring)')
  const labels = labelsOf(household, fields)
  if (labels.length > 0) parts.push(`#${labels.join(' #')}`)
  return `- ${parts.join(' ')}  ·  id ${fields.uid}`
}

/**
 * Phrase a chore list, grouped by the person responsible.
 *
 * Grouping by person is what turns a list into an answer: the question is
 * almost always "what do I have to do" or "who has what".
 * @param household - the roster, for names and the clock.
 * @param entries - the chores to report, already filtered.
 * @returns the list as text.
 */
export function formatChoresByPerson(household: Household, entries: readonly ChoreEntry[]): string {
  // Say so rather than returning an empty string. A caller that renders this
  // directly would otherwise report nothing at all, which reads as a failure.
  if (entries.length === 0) return 'Nothing on the chore list.'
  const today = household.today()
  const groups = new Map<string, ChoreEntry[]>()
  for (const entry of entries) {
    const assignee = assigneeOf(household, entry.fields)
    const key = assignee?.displayName ?? 'Unassigned'
    const bucket = groups.get(key)
    if (bucket === undefined) groups.set(key, [entry])
    else bucket.push(entry)
  }
  // Roster order, then unassigned last: the family reads itself in a stable order.
  const order = [...household.list().map(member => member.displayName), 'Unassigned']
  const lines: string[] = []
  for (const key of order) {
    const bucket = groups.get(key)
    if (bucket === undefined || bucket.length === 0) continue
    lines.push(`${key}:`)
    for (const entry of byUrgency(bucket, today)) {
      lines.push(`  ${choreLine(household, entry, { showAssignee: false }).slice(2)}`)
    }
  }
  return lines.join('\n')
}
