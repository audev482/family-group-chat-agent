/**
 * Reading, phrasing, and locating VEVENTs across the household's calendars.
 *
 * The work this module owns is deciding **which collections a question is
 * about**. "What's on tomorrow" means every calendar the family keeps; "when is
 * Robin's football" means Robin's. Getting that wrong is the difference between
 * a useful answer and a misleading one, so the choice is one documented
 * function rather than a branch inside each tool.
 *
 * @module dsh-calendar/events
 */

import { parseObject, readEvent } from 'dsh-caldav'
import type { CalDav, EventFields } from 'dsh-caldav'
import type { Household, HouseholdMember, Window } from 'dsh-household'

/** One event with the collection and concurrency token needed to change it. */
export interface EventEntry {
  /** Display name of the collection the event lives in. */
  readonly calendar: string
  /** Absolute object URL. */
  readonly url: string
  /** ETag the event was read with. */
  readonly etag?: string
  /** The raw iCalendar text, kept so a write can modify rather than rebuild it. */
  readonly ical: string
  /** The event's fields. */
  readonly fields: EventFields
}

/** Which collections a question is about, and why. */
export interface CalendarScope {
  /** Collection display names or URLs to read, in the order they were chosen. */
  readonly calendars: readonly string[]
  /** Short explanation of the choice, so an answer can say whose calendars it covered. */
  readonly reason: string
}

/**
 * Choose the collections a request addresses.
 *
 * Precedence: an explicit collection wins; then a named person's own calendar;
 * otherwise every calendar the household keeps. A named person without their
 * own collection falls back to the shared one, because their events are kept
 * there — answering "nothing found" would be wrong.
 * @param household - the roster.
 * @param request - explicit collection and/or person from the tool call.
 * @returns the collections to read and the reason.
 */
export function scopeFor(
  household: Household,
  request: { calendar?: string; person?: HouseholdMember },
): CalendarScope {
  if (request.calendar !== undefined && request.calendar.trim() !== '') {
    return { calendars: [request.calendar.trim()], reason: `calendar "${request.calendar.trim()}"` }
  }
  const shared = household.sharedCalendar
  if (request.person !== undefined) {
    const own = request.person.calendar
    if (own !== undefined) {
      return { calendars: [own], reason: `${request.person.displayName}'s calendar` }
    }
    if (shared !== undefined) {
      return {
        calendars: [shared],
        reason: `the shared calendar (${request.person.displayName} has no calendar of their own)`,
      }
    }
    return { calendars: [], reason: `no calendar is configured for ${request.person.displayName}` }
  }
  const all = [
    ...shared !== undefined ? [shared] : [],
    ...household.list().flatMap(member => member.calendar !== undefined ? [member.calendar] : []),
  ]
  const unique = [...new Set(all)]
  return {
    calendars: unique,
    reason: unique.length === 0 ? 'no calendars are configured' : 'every family calendar',
  }
}

/**
 * Read events from several collections over one window.
 *
 * A collection that fails is reported rather than thrown: one unreachable
 * calendar must not blank the whole family's agenda.
 * @param caldav - the CalDAV seam.
 * @param calendars - collection display names or URLs.
 * @param window - the instant window to read, or `undefined` for the whole collection.
 * @returns the events found, sorted by start, and one problem line per failed collection.
 */
export async function collectEvents(
  caldav: CalDav,
  calendars: readonly string[],
  window?: Window,
): Promise<{ events: EventEntry[]; problems: string[] }> {
  const events: EventEntry[] = []
  const problems: string[] = []
  for (const calendar of calendars) {
    let records
    try {
      records = await caldav.objects({
        calendar,
        component: 'VEVENT',
        ...window !== undefined ? { timeRange: window } : {},
      })
    } catch (error) {
      problems.push(`could not read "${calendar}": ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const record of records) {
      try {
        const { target } = await parseObject(record.ical, 'VEVENT')
        events.push({
          calendar,
          url: record.url,
          ical: record.ical,
          fields: readEvent(target),
          ...record.etag !== undefined ? { etag: record.etag } : {},
        })
      } catch (error) {
        problems.push(`skipped an unreadable item in "${calendar}": ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  events.sort((left, right) => left.fields.start.localeCompare(right.fields.start))
  return { events, problems }
}

/**
 * Find one event by `UID` across collections.
 *
 * The search runs without a time filter, so an event far outside any agenda
 * window is still reachable for a reschedule or a cancellation.
 * @param caldav - the CalDAV seam.
 * @param calendars - collection display names or URLs to search.
 * @param uid - the event's `UID`.
 * @returns the event, or `undefined` when no collection holds it.
 */
export async function findEventByUid(
  caldav: CalDav,
  calendars: readonly string[],
  uid: string,
): Promise<EventEntry | undefined> {
  const wanted = uid.trim()
  for (const calendar of calendars) {
    const { events } = await collectEvents(caldav, [calendar])
    const match = events.find(entry => entry.fields.uid === wanted)
    if (match !== undefined) return match
  }
  return undefined
}

/** Who an event concerns, read from its categories and attendees. */
function participants(household: Household, fields: EventFields): string[] {
  const names = new Set<string>()
  for (const category of fields.categories) {
    const member = household.resolve(category)
    if (member !== undefined) names.add(member.displayName)
  }
  for (const address of fields.attendees) {
    const member = household.list().find(candidate => candidate.email?.toLowerCase() === address.toLowerCase())
    if (member !== undefined) names.add(member.displayName)
  }
  return [...names]
}

/** One agenda line: time, title, and the facts that make it actionable. */
function eventLine(household: Household, entry: EventEntry, showCalendar: boolean): string {
  const time = household.timeOfDay(entry.fields.start)
  const until = entry.fields.end !== undefined && !entry.fields.allDay
    ? `–${household.timeOfDay(entry.fields.end)}`
    : ''
  const parts = [`${time}${until}  ${entry.fields.summary}`]
  if (entry.fields.location !== undefined) parts.push(`@ ${entry.fields.location}`)
  const who = participants(household, entry.fields)
  if (who.length > 0) parts.push(`(${who.join(', ')})`)
  if (showCalendar) parts.push(`[${entry.calendar}]`)
  if (entry.fields.rrule !== undefined) parts.push('(repeats)')
  return `  ${parts.join(' ')}`
}

/**
 * Phrase an agenda, grouped by local day.
 * @param household - the roster, for names and the clock.
 * @param entries - the events to report.
 * @param options - the day the agenda starts on, its span, and whether to name collections.
 * @returns the agenda as text, including an empty-day notice where a day has nothing.
 */
export function formatAgenda(
  household: Household,
  entries: readonly EventEntry[],
  options: { fromDay: string; days: number; showCalendar: boolean },
): string {
  const lines: string[] = []
  for (let offset = 0; offset < Math.max(1, options.days); offset += 1) {
    const day = household.shiftDay(options.fromDay, offset)
    const onDay = entries.filter(entry => startsOn(household, entry, day))
    lines.push(`${household.when(day)}${onDay.length === 0 ? ' — nothing scheduled' : ''}`)
    for (const entry of onDay) lines.push(eventLine(household, entry, options.showCalendar))
  }
  return lines.join('\n')
}

/** Whether an event's start falls on a given local day. */
function startsOn(household: Household, entry: EventEntry, day: string): boolean {
  const start = entry.fields.start
  if (start === '') return false
  if (entry.fields.allDay) return start.slice(0, 10) === day
  return household.today(new Date(start)) === day
}

/** A stretch of time nobody has claimed. */
export interface FreeSlot {
  /** Local day, `YYYY-MM-DD`. */
  readonly day: string
  /** Inclusive start instant. */
  readonly start: Date
  /** Exclusive end instant. */
  readonly end: Date
}

/**
 * Find gaps long enough for something, within each day's usable hours.
 *
 * All-day events are ignored: a birthday marked on the calendar does not stop
 * the family from booking a dentist that afternoon.
 * @param household - the roster, for the clock.
 * @param entries - events that occupy time.
 * @param options - the window in local days, the minimum length, and the usable hours.
 * @returns every gap of at least the requested length, in chronological order.
 */
export function findFreeSlots(
  household: Household,
  entries: readonly EventEntry[],
  options: { fromDay: string; days: number; minutes: number; earliestHour: number; latestHour: number },
): FreeSlot[] {
  const slots: FreeSlot[] = []
  const needed = Math.max(1, options.minutes) * 60_000
  for (let offset = 0; offset < Math.max(1, options.days); offset += 1) {
    const day = household.shiftDay(options.fromDay, offset)
    const dayStart = household.window(day, 1).start
    const open = new Date(dayStart.getTime() + options.earliestHour * 3_600_000)
    const close = new Date(dayStart.getTime() + options.latestHour * 3_600_000)
    const busy = entries
      .filter(entry => !entry.fields.allDay && entry.fields.start !== '')
      .map((entry) => {
        const start = new Date(entry.fields.start)
        const end = entry.fields.end !== undefined ? new Date(entry.fields.end) : new Date(start.getTime() + 3_600_000)
        return { start, end }
      })
      .filter(interval => interval.end > open && interval.start < close)
      .sort((left, right) => left.start.getTime() - right.start.getTime())
    let cursor = open
    for (const interval of busy) {
      if (interval.start.getTime() - cursor.getTime() >= needed) {
        slots.push({ day, start: cursor, end: new Date(interval.start) })
      }
      if (interval.end > cursor) cursor = interval.end
    }
    if (close.getTime() - cursor.getTime() >= needed) {
      slots.push({ day, start: cursor, end: close })
    }
  }
  return slots
}
