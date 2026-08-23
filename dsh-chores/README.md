# dsh-chores

The household's shared work, given to the butler as six tools. These are **jobs
for people** — take the bins out, book the boiler service, pack a swimming kit —
not tasks for the agent. They are stored as standard VTODOs in an ordinary
CalDAV collection, which is exactly what the Nextcloud Tasks app reads and
writes, so every chore the butler files appears as a normal task on each family
member's phone and can be ticked off there without the butler involved.

That constraint shapes the package: nothing is stored anywhere the family cannot
see and edit. Install and configuration are covered in the [root
README](../README.md). The chore list is a task list you create in Nextcloud
Tasks first and name as `choresCalendar` in the household config; this package's
`cordis.patch.yml` only overrides it when the list should live elsewhere.
`inject = ['caldav', 'household', 'tools']`.

## The tools

| Tool | What it does |
| --- | --- |
| `chores_list` | Read the chore list — "what needs doing", "what is on my list", "who has what". Reports the ids the other tools need. Open chores only unless you ask for done ones. |
| `chores_add` | Add a job. Assign it with a person, or leave it for anyone. It appears as a normal task in Nextcloud Tasks. |
| `chores_complete` | Tick a chore off, or record partial progress. A recurring chore keeps its rule and comes back. |
| `chores_assign` | Change whose job a chore is, or hand it back to nobody. |
| `chores_reschedule` | Change when a chore is due, or clear the date; also set or clear high priority. |
| `chores_drop` | Drop a chore that no longer needs doing — marks it CANCELLED rather than deleting it. |

```
[Kit]  i did the bins
Butler Ticked off "Take the bins out". Nothing else of yours is outstanding.
```

## Assignment travels in CATEGORIES

Assignment is written as a `CATEGORIES` tag carrying the member's configured
`tag`, and that tag is the authoritative read. This is not the semantically
obvious choice — `ATTENDEE` is the "correct" iCalendar field — but the chores
are worked by humans in the Nextcloud Tasks app, where `CATEGORIES` renders as
editable tags and `ATTENDEE` has no UI at all. So a parent can reassign the bins
by editing a tag on their phone and the butler reads that change on its next
look: the two directions agree because there is exactly one authoritative field.
`ATTENDEE` is mirrored (with `CN` and `mailto:`) when a member has an email, for
other CalDAV clients, but is never read back, so a stale mirror cannot contradict
what the family sees. A chore with no member tag is unassigned — anyone's to
pick up.

## Reading, and why it reads the whole list

`collectChores` applies **no** time-range filter. An undated VTODO has no times
to compare against and RFC 4791 would exclude it, so filtering happens after
reading, where "unassigned and undated" is still a visible chore. Unreadable
items are gathered as `problems` rather than lost.

Order is part of reading, not the caller's job — a list is only useful if what is
overdue comes first. `byUrgency` sorts overdue first (oldest overdue leading),
then by due date, then by priority. Priority `0` means "unset" in RFC 5545, which
numbers `1` as the highest, so it is treated as lowest and sorts last; a naive
sort would put "no priority" ahead of everything. `chores_list` groups by person
(in roster order, unassigned last) so the list reads as an answer to "who has
what".

## It never acts on a guess

A family member says "the bins", not a chore's exact title. `matchBySummary` is
deliberately generous and returns **every** match rather than picking one. The
`locate` helper inside each mutating tool turns that into safe behaviour: it
tries the id first, then a summary match, and returns a **string message** — not
a chore — when the reference is ambiguous or unknown. The butler then asks which
one rather than ticking off the wrong job, which the family would not discover
until the bins were still on the kerb.

## Dropping versus completing

`chores_drop` sets `STATUS:CANCELLED` rather than deleting the VTODO, so the
family can still see the job was decided against, and can record a reason on it.
Completing is different: `chores_complete` sets `COMPLETED` (or `IN-PROCESS` for
partial progress), and a recurring chore keeps its `RRULE` so it returns next
time. The butler records and reports; it will not tick a chore off because it
thinks the job should be done.
