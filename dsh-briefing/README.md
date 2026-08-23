# dsh-briefing

The part of being a butler that nobody asks for: one digest each morning, posted
into the family's room unprompted. It turns the calendar and the chore list from
things you have to remember to check into things that arrive. This is a function
plugin; see the root [`README.md`](../README.md) for install.

```ts
export const inject = ['discord', 'caldav', 'household']
```

It couples to more seams than any other package in the stack, and that is
inherent: a briefing *is* the composition of the calendar, the chores, the
roster, and the channel. It posts through `ctx.discord.announce`.

## Composed, not written

The digest is assembled **deterministically** from the calendar and chore
helpers rather than by asking the model to write it. That is a deliberate choice:
composing it directly costs no tokens, cannot hallucinate an appointment, and
still arrives when the model provider is down. A morning digest that is
sometimes wrong, or sometimes absent because a token ran out, is worse than no
digest at all.

`composeDigest` opens with a greeting, then the agenda for the covered days,
then chores split into two groups — **overdue** reported separately from **due
soon** within `choreLookaheadDays`, because "three things are late" is the fact
that changes behaviour. A calendar or chore list that cannot be read is reported
as a line in the digest rather than aborting it.

## Mail is a soft dependency

Cordis `Inject` has no optional form, so listing `mail` in `inject` would stop
the digest running entirely in a calendar-only household. Instead the mailbox is
read through a guard:

```ts
const mail = (ctx as { mail?: Context['mail'] }).mail
if (mail === undefined) return undefined
```

so the digest gains an unread-mail line when `dsh-mail` is mounted and is
otherwise unchanged. `unreadMailLine` reports **counts and sender names only,
never subjects** — a digest is read by whoever is in the room, and the contents
of the family's mail do not belong there. A mail outage is swallowed so it can
never cost the family their agenda.

## Scheduling across daylight saving

`nextRun` resolves the next wall-clock time directly in the family's time zone
via `zonedToInstant`, rather than adding hours to anything. Both obvious
implementations drift:

- "now + 24 hours" moves the digest an hour twice a year;
- "local midnight + 7½ hours" is worse — on a transition day local midnight is
  at the *old* offset, so adding hours crosses the transition and lands an hour
  out, on exactly the morning it matters.

Resolving the wall-clock time in the zone avoids both, and the schedule tests
assert the digest still lands at 07:30 local across both the spring-forward (a
23-hour day) and the autumn fall-back (a 25-hour day).

Two further details in `apply`: the timer is **re-armed before posting**, so one
failed morning does not end the series, and `timer.unref()` is called so a
pending digest does not hold the process open on its own.

## Configuration

```yaml
channelId: ''            # REQUIRED, no default — see below
time: '07:30'            # HH:MM, local to the household time zone
days: 1                  # days of calendar to cover, 1–7
choreLookaheadDays: 2    # how far ahead a chore counts as "coming up", 0–30
includeChores: true
includeMail: true        # count + senders only; does nothing if dsh-mail absent
skipWhenEmpty: false      # off by default — "nothing on today" is useful
server: ''               # CalDAV server name, when more than one is configured
```

`channelId` has **no default and is required**: guessing a channel to post the
family's day into would be worse than silence. An unparseable `time` fails loudly
at load rather than becoming a digest that silently never arrives. With
`skipWhenEmpty` off, a quiet day still gets a short "nothing on today" — usually
the reassuring thing to know.

`composeDigest`, `unreadMailLine`, `nextRun`, and `parseTimeOfDay` are exported
and pure, so the digest text and the schedule can be tested without timers, a
connection, or a clock to wait on.
