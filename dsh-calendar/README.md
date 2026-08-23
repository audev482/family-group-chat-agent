# dsh-calendar

The family calendar, given to the butler as five tools. Each writes standard
VEVENTs to ordinary CalDAV collections through the `ctx.caldav` and
`ctx.household` seams, so an event the butler creates is indistinguishable from
one typed into Nextcloud Calendar, a phone, or any other client. Every answer is
phrased in the household's own time zone and names people the way the family
does, because the text goes straight into a shared chat room.

Install and configuration for the whole stack live in the [root
README](../README.md); this package's `cordis.patch.yml` only carries a few
defaults (agenda span and the working hours to offer for new appointments). It
declares `inject = ['caldav', 'household', 'tools']` and stays dormant until
those services are mounted, so install order does not matter.

## The tools

| Tool | What it does |
| --- | --- |
| `calendar_agenda` | Read what is scheduled: any question about what is on, who is busy, or when something happens. Covers every family calendar unless a person or calendar is named. |
| `calendar_add_event` | Put an appointment, practice, trip, or birthday on the calendar. Naming a person files it on their calendar; otherwise it goes on the shared one. |
| `calendar_move_event` | Reschedule an existing event by its id, keeping everything else about it. |
| `calendar_cancel_event` | Remove an event by its id. It is deleted for everyone. |
| `calendar_find_free_time` | Find when the family, or named members, have nothing scheduled — before proposing a time for anything. |

```
[Alex] add parents evening thursday 6pm
Butler Added "Parents evening" on Thursday at 18:00 to the family calendar.
       Its id is <uid> if it needs moving or cancelling.
```

Days are given the way the family says them: `today`, `tomorrow`, a weekday name,
or `YYYY-MM-DD`. A start of `YYYY-MM-DD` makes a whole-day event; an ISO
date-time makes a timed one. Both `calendar_add_event` and `calendar_move_event`
report the event id, and the other two tools need it — so `calendar_agenda` is
usually the first call, since it is what surfaces ids in the first place.

## Which calendar a question is about

The one non-obvious decision, and it lives in one place — `scopeFor` in
`src/events.ts` — rather than being re-derived inside each tool. The precedence:

1. an explicitly named calendar wins over everything;
2. then a named person's own calendar;
3. then, for a person who has no calendar of their own, the shared calendar,
   because that is where their events are kept — answering "nothing found" would
   be wrong;
4. otherwise every calendar the household keeps.

The reason for the choice travels back with the result, so the butler can say
whose calendars it actually looked at.

## Reading is resilient, finding events is not time-boxed

`collectEvents` reads several collections over one window and gathers a failed
collection into a `problems` list instead of throwing. One unreachable calendar
must not blank the whole family's agenda, so the agenda still comes back and the
gap is reported at the end rather than swallowed.

`findEventByUid`, used by move and cancel, deliberately reads with **no** time
filter. An event far outside any agenda window — a dentist appointment months
out — must still be reachable to reschedule or cancel, which it would not be if
the lookup were bounded to the current view.

## Free time ignores all-day markers

`findFreeSlots` treats all-day events as not occupying time: a birthday marked on
the calendar does not stop the family booking a dentist that afternoon. It walks
each day's usable hours (configurable, defaulting to 08:00–21:00), merges
overlapping bookings, and offers only gaps at least as long as asked for. An
event with no end is assumed to last an hour.

## An implementation note on all-day events

Per RFC 5545 an all-day VEVENT's `DTEND` is exclusive, so a single-day event has
to end the following morning. `calendar_add_event` and `calendar_move_event`
write `start + 1 day` for the end of a whole-day event; without it a one-day
event would render as zero-length. Moves reparse and modify the original
iCalendar text rather than rebuilding it, so alarms, attendees, and any client
extensions on the event survive the change.
