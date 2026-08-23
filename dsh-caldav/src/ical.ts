/**
 * The iCalendar (RFC 5545) layer: reading and writing the VEVENT and VTODO
 * fields the butler understands, over `ical.js`.
 *
 * `ical.js` is an optional peer loaded lazily, and it is the same parser the
 * Nextcloud Tasks app uses, so objects round-trip through the butler the way
 * they round-trip through Nextcloud.
 *
 * **Every write is a read-modify-write of the original text.** The butler
 * changes only the properties it was asked to change and re-serializes
 * everything else untouched, so alarms, `VTIMEZONE` blocks, Nextcloud's
 * `X-OC-*` and `X-APPLE-SORT-ORDER` extensions, and any property a future
 * client adds survive an edit. Rebuilding an object from parsed fields would
 * quietly delete them.
 *
 * Instants are written as UTC (`…Z`) and dates as `VALUE=DATE`. That keeps the
 * seam free of a shipped time-zone database while staying valid iCalendar;
 * clients render UTC in the viewer's own zone.
 *
 * @module dsh-caldav/ical
 */

import { CalDavError } from './types.ts'
import type { CalendarComponent } from './types.ts'

/** The `ical.js` namespace as its default export declares it. */
type IcalNamespace = typeof import('ical.js').default
/** A parsed iCalendar component (`VCALENDAR`, `VEVENT`, `VTODO`). */
export type IcalComponent = InstanceType<IcalNamespace['Component']>
/** A parsed iCalendar date or date-time value. */
export type IcalTime = InstanceType<IcalNamespace['Time']>

/** Load `ical.js` on first use, or explain exactly how to install it. */
async function importIcal(): Promise<IcalNamespace> {
  try {
    const module = await import('ical.js') as unknown as { default: IcalNamespace }
    return module.default
  } catch (cause) {
    throw new CalDavError(
      'sdk-missing',
      'dsh-caldav requires the optional peer dependency "ical.js". Install it into the profile, e.g. '
      + '`dsh plugin --profile <name> add ical.js`, or `pnpm add ical.js` in a source checkout.',
      { cause },
    )
  }
}

/** Test seam: replacing `loadIcal` is unnecessary for parsing, but keeps the boundary uniform. */
export const internals: { loadIcal: () => Promise<IcalNamespace> } = { loadIcal: importIcal }

/**
 * Load the iCalendar library through the {@link internals} seam.
 * @returns the `ical.js` namespace.
 */
export function loadIcal(): Promise<IcalNamespace> {
  return internals.loadIcal()
}

/** VTODO completion states defined by RFC 5545. */
export type TodoStatus = 'NEEDS-ACTION' | 'IN-PROCESS' | 'COMPLETED' | 'CANCELLED'

/** The VEVENT fields the calendar tools read and write. */
export interface EventFields {
  /** `UID`. */
  readonly uid: string
  /** `SUMMARY`. */
  readonly summary: string
  /** `DESCRIPTION`, when present. */
  readonly description?: string
  /** `LOCATION`, when present. */
  readonly location?: string
  /** `DTSTART` as an ISO 8601 instant, or `YYYY-MM-DD` for an all-day event. */
  readonly start: string
  /** `DTEND` in the same form as {@link EventFields.start}, when present. */
  readonly end?: string
  /** Whether `DTSTART` is a `VALUE=DATE` all-day value. */
  readonly allDay: boolean
  /** `RRULE` in its iCalendar text form, when the event repeats. */
  readonly rrule?: string
  /** `CATEGORIES` values. */
  readonly categories: readonly string[]
  /** `ATTENDEE` addresses with the `mailto:` prefix stripped. */
  readonly attendees: readonly string[]
  /** `STATUS`, when present. */
  readonly status?: string
}

/** The VTODO fields the chore tools read and write. */
export interface TodoFields {
  /** `UID`. */
  readonly uid: string
  /** `SUMMARY`. */
  readonly summary: string
  /** `DESCRIPTION`, when present. */
  readonly description?: string
  /** `DUE` as an ISO instant or `YYYY-MM-DD`, when present. */
  readonly due?: string
  /** `DTSTART` in the same form, when present. */
  readonly start?: string
  /** Whether `DUE` is a `VALUE=DATE` all-day value. */
  readonly allDayDue: boolean
  /** `PRIORITY`: 0 none, 1 highest, 9 lowest. */
  readonly priority: number
  /** `PERCENT-COMPLETE`, 0–100. */
  readonly percentComplete: number
  /** `STATUS`, when present. */
  readonly status?: TodoStatus
  /** `COMPLETED` as an ISO instant, when the chore is done. */
  readonly completed?: string
  /** `CATEGORIES` values; the channel carrying chore assignment. */
  readonly categories: readonly string[]
  /** `RELATED-TO` — the parent chore's `UID` for a subtask. */
  readonly relatedTo?: string
  /** `RRULE` in its iCalendar text form, when the chore repeats. */
  readonly rrule?: string
  /** `LOCATION`, when present. */
  readonly location?: string
}

/** Map a component name onto the lower-case name `ical.js` indexes it by. */
function subcomponentName(component: CalendarComponent): string {
  return component === 'VEVENT' ? 'vevent' : 'vtodo'
}

/**
 * Parse one calendar object and return its `VCALENDAR` root together with the
 * requested component.
 * @param ical - raw iCalendar text.
 * @param component - the component to extract.
 * @returns the root and the component.
 */
export async function parseObject(
  ical: string,
  component: CalendarComponent,
): Promise<{ root: IcalComponent; target: IcalComponent }> {
  const ICAL = await loadIcal()
  let root: IcalComponent
  try {
    root = ICAL.Component.fromString(ical) as IcalComponent
  } catch (cause) {
    throw new CalDavError('request-failed', `the server returned iCalendar text that does not parse: ${String(cause)}`, { cause })
  }
  const target = root.getFirstSubcomponent(subcomponentName(component)) as IcalComponent | null
  if (target === null) {
    throw new CalDavError('component-unsupported', `the calendar object contains no ${component}`)
  }
  return { root, target }
}

/** Read a text property, normalizing absent and empty to `undefined`. */
function readText(component: IcalComponent, name: string): string | undefined {
  const value = component.getFirstPropertyValue(name)
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/** Read every value of a possibly multi-valued, possibly repeated property. */
function readList(component: IcalComponent, name: string): string[] {
  const values: string[] = []
  for (const property of component.getAllProperties(name)) {
    for (const value of property.getValues()) {
      if (typeof value === 'string') {
        for (const part of value.split(',')) {
          const trimmed = part.trim()
          if (trimmed !== '') values.push(trimmed)
        }
      }
    }
  }
  return values
}

/** Duck-type an `ical.js` time value without importing the class at runtime. */
function asTime(value: unknown): IcalTime | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { toJSDate?: unknown; isDate?: unknown }
  return typeof candidate.toJSDate === 'function' ? value as IcalTime : undefined
}

/**
 * Render a date-time property the way the butler reports it: a plain
 * `YYYY-MM-DD` for an all-day value, a full ISO instant otherwise.
 */
function readWhen(component: IcalComponent, name: string): { value: string; allDay: boolean } | undefined {
  const time = asTime(component.getFirstPropertyValue(name))
  if (time === undefined) return undefined
  const date = time.toJSDate()
  if (Number.isNaN(date.getTime())) return undefined
  if (time.isDate) {
    const pad = (n: number): string => String(n).padStart(2, '0')
    return { value: `${time.year}-${pad(time.month)}-${pad(time.day)}`, allDay: true }
  }
  return { value: date.toISOString(), allDay: false }
}

/** Read `RRULE` back as iCalendar text so it can be echoed and re-written verbatim. */
function readRrule(component: IcalComponent): string | undefined {
  const property = component.getFirstProperty('rrule')
  if (property === null) return undefined
  const value = property.getFirstValue()
  if (value === null || typeof value !== 'object') return undefined
  const recur = value as { toString?: () => string }
  const text = typeof recur.toString === 'function' ? recur.toString() : ''
  return text === '' ? undefined : text
}

/** Clamp a numeric property into its RFC 5545 range, treating anything else as the floor. */
function readNumber(component: IcalComponent, name: string, max: number): number {
  const raw = component.getFirstPropertyValue(name)
  const value = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(Math.trunc(value), max)
}

/**
 * Project a parsed VEVENT onto {@link EventFields}.
 * @param event - the `VEVENT` component.
 * @returns the fields the calendar tools speak.
 */
export function readEvent(event: IcalComponent): EventFields {
  const start = readWhen(event, 'dtstart')
  const end = readWhen(event, 'dtend')
  const attendees = event.getAllProperties('attendee')
    .map(property => String(property.getFirstValue() ?? '').replace(/^mailto:/i, '').trim())
    .filter(address => address !== '')
  return {
    uid: readText(event, 'uid') ?? '',
    summary: readText(event, 'summary') ?? '(untitled)',
    start: start?.value ?? '',
    allDay: start?.allDay ?? false,
    categories: readList(event, 'categories'),
    attendees,
    ...readText(event, 'description') !== undefined ? { description: readText(event, 'description')! } : {},
    ...readText(event, 'location') !== undefined ? { location: readText(event, 'location')! } : {},
    ...end !== undefined ? { end: end.value } : {},
    ...readRrule(event) !== undefined ? { rrule: readRrule(event)! } : {},
    ...readText(event, 'status') !== undefined ? { status: readText(event, 'status')! } : {},
  }
}

/** The RFC 5545 status values, for narrowing what a server returned. */
const TODO_STATUSES: readonly TodoStatus[] = ['NEEDS-ACTION', 'IN-PROCESS', 'COMPLETED', 'CANCELLED']

/** Narrow a `STATUS` value, ignoring anything outside the standard set. */
function readTodoStatus(todo: IcalComponent): TodoStatus | undefined {
  const raw = readText(todo, 'status')?.toUpperCase()
  return TODO_STATUSES.find(status => status === raw)
}

/**
 * Project a parsed VTODO onto {@link TodoFields}.
 * @param todo - the `VTODO` component.
 * @returns the fields the chore tools speak.
 */
export function readTodo(todo: IcalComponent): TodoFields {
  const due = readWhen(todo, 'due')
  const start = readWhen(todo, 'dtstart')
  const completed = readWhen(todo, 'completed')
  return {
    uid: readText(todo, 'uid') ?? '',
    summary: readText(todo, 'summary') ?? '(untitled)',
    allDayDue: due?.allDay ?? false,
    priority: readNumber(todo, 'priority', 9),
    percentComplete: readNumber(todo, 'percent-complete', 100),
    categories: readList(todo, 'categories'),
    ...readText(todo, 'description') !== undefined ? { description: readText(todo, 'description')! } : {},
    ...due !== undefined ? { due: due.value } : {},
    ...start !== undefined ? { start: start.value } : {},
    ...readTodoStatus(todo) !== undefined ? { status: readTodoStatus(todo)! } : {},
    ...completed !== undefined ? { completed: completed.value } : {},
    ...readText(todo, 'related-to') !== undefined ? { relatedTo: readText(todo, 'related-to')! } : {},
    ...readRrule(todo) !== undefined ? { rrule: readRrule(todo)! } : {},
    ...readText(todo, 'location') !== undefined ? { location: readText(todo, 'location')! } : {},
  }
}

/** A date the butler was asked to write: either a whole day or an instant. */
export interface WhenInput {
  /** `YYYY-MM-DD` for an all-day value, or any ISO 8601 date-time for an instant. */
  readonly value: string
  /** Force a `VALUE=DATE` write; inferred from `value` when omitted. */
  readonly allDay?: boolean
}

/** `YYYY-MM-DD` with nothing after it: an all-day value. */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse a caller-supplied date into an `ical.js` time, choosing the `DATE` or
 * UTC `DATE-TIME` form.
 * @param ICAL - the loaded namespace.
 * @param when - the requested date.
 * @returns the time value to write.
 */
export function toIcalTime(ICAL: IcalNamespace, when: WhenInput): IcalTime {
  const dateOnly = DATE_ONLY.exec(when.value)
  const wantsDate = when.allDay ?? dateOnly !== null
  if (dateOnly !== null) {
    const time = ICAL.Time.fromData({
      year: Number(dateOnly[1]),
      month: Number(dateOnly[2]),
      day: Number(dateOnly[3]),
      isDate: true,
    }) as IcalTime
    if (wantsDate) return time
    return ICAL.Time.fromJSDate(time.toJSDate(), true) as IcalTime
  }
  const parsed = new Date(when.value)
  if (Number.isNaN(parsed.getTime())) {
    throw new CalDavError(
      'request-failed',
      `"${when.value}" is not a date the butler understands — use YYYY-MM-DD for a whole day `
      + 'or an ISO 8601 date-time such as 2026-08-22T14:00:00Z',
    )
  }
  if (wantsDate) {
    return ICAL.Time.fromData({
      year: parsed.getUTCFullYear(),
      month: parsed.getUTCMonth() + 1,
      day: parsed.getUTCDate(),
      isDate: true,
    }) as IcalTime
  }
  return ICAL.Time.fromJSDate(parsed, true) as IcalTime
}

/**
 * Set or clear one text property on a component.
 * @param component - the component to change.
 * @param name - the property name.
 * @param value - the new text, `null` to remove the property, `undefined` to leave it alone.
 */
export function writeText(component: IcalComponent, name: string, value: string | null | undefined): void {
  if (value === undefined) return
  if (value === null || value === '') {
    component.removeAllProperties(name)
    return
  }
  component.updatePropertyWithValue(name, value)
}

/**
 * Set or clear one date property, preserving the `DATE` vs `DATE-TIME` choice
 * the caller asked for.
 * @param ICAL - the loaded namespace.
 * @param component - the component to change.
 * @param name - the property name (`dtstart`, `due`, `completed`).
 * @param when - the new date, `null` to remove it, `undefined` to leave it alone.
 */
export function writeWhen(
  ICAL: IcalNamespace,
  component: IcalComponent,
  name: string,
  when: WhenInput | null | undefined,
): void {
  if (when === undefined) return
  component.removeAllProperties(name)
  if (when === null) return
  const time = toIcalTime(ICAL, when)
  const property = new ICAL.Property(name, component)
  property.setValue(time)
  // No explicit `VALUE=DATE` parameter here: `ical.js` emits it at serialisation
  // time whenever the value's type differs from the property's default. Setting
  // it as well produced `DTSTART;VALUE=DATE;VALUE=DATE:...`, which some servers
  // reject. The parameter is not readable back via `getParameter`, so there is
  // nothing to check for either — the correct move is to leave it to the library.
  component.addProperty(property)
}

/**
 * Replace the whole `CATEGORIES` set, which is how chore assignment and
 * free-form tags are written.
 * @param ICAL - the loaded namespace.
 * @param component - the component to change.
 * @param categories - the complete new set; empty removes the property.
 */
export function writeCategories(
  ICAL: IcalNamespace,
  component: IcalComponent,
  categories: readonly string[],
): void {
  component.removeAllProperties('categories')
  const unique = [...new Set(categories.map(value => value.trim()).filter(value => value !== ''))]
  if (unique.length === 0) return
  const property = new ICAL.Property('categories', component)
  property.setValues(unique)
  component.addProperty(property)
}

/**
 * Stamp `LAST-MODIFIED` and `DTSTAMP` so other clients see the change as
 * recent, which is what drives their sync and conflict display.
 * @param ICAL - the loaded namespace.
 * @param component - the component being written.
 * @param now - the instant to stamp.
 */
export function touch(ICAL: IcalNamespace, component: IcalComponent, now: Date): void {
  const stamp = ICAL.Time.fromJSDate(now, true)
  component.updatePropertyWithValue('last-modified', stamp)
  component.updatePropertyWithValue('dtstamp', stamp)
}

/**
 * Build a fresh single-component calendar object.
 * @param ICAL - the loaded namespace.
 * @param component - the component kind to create.
 * @param uid - the object's `UID`.
 * @param now - the instant used for `CREATED`, `DTSTAMP`, and `LAST-MODIFIED`.
 * @returns the `VCALENDAR` root and the new component.
 */
export function createObject(
  ICAL: IcalNamespace,
  component: CalendarComponent,
  uid: string,
  now: Date,
): { root: IcalComponent; target: IcalComponent } {
  const root = new ICAL.Component('vcalendar') as IcalComponent
  root.updatePropertyWithValue('version', '2.0')
  root.updatePropertyWithValue('prodid', '-//dsh-butler//CalDAV//EN')
  const target = new ICAL.Component(subcomponentName(component)) as IcalComponent
  target.updatePropertyWithValue('uid', uid)
  target.updatePropertyWithValue('created', ICAL.Time.fromJSDate(now, true))
  touch(ICAL, target, now)
  root.addSubcomponent(target)
  return { root, target }
}
