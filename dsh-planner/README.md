# dsh-planner

The half of the butler that speaks first.

Everything else in this project waits to be asked. This notices that a holiday, a
birthday, an anniversary, or just the coming weekend is close enough to be worth
talking about, opens a conversation in the family room, and keeps track of who has
weighed in until there is a plan on the calendar.

It registers **no tools** and writes **no calendar events itself**. It decides what
is worth raising; the butler does the rest with the tools it already has.

## Consensus is state, and it lives in Nextcloud

This is the decision the whole package turns on. "Trying to get consensus" is a
conversation that spans days, so the butler has to remember what it asked, who
replied, and when to stop — across restarts. Agent memory does not survive that. A
file on the host survives it but is invisible to the family.

So a planning cycle **is** a task:

```
VTODO  uid=butler-holiday-thanksgiving-2026-11-26   "Plan Thanksgiving"
  ├── VTODO  RELATED-TO=butler-…-11-26   "ALEX: what would you like to do for Thanksgiving?"
  ├── VTODO  RELATED-TO=butler-…-11-26   "SAM: what would you like to do for Thanksgiving?"
  └── VTODO  RELATED-TO=butler-…-11-26   "KIT: what would you like to do for Thanksgiving?"
```

"Who has not weighed in" is then just which subtasks are still open. It survives a
restart, the family sees it in the Tasks app, and anyone can tick their own subtask
off there instead of in chat.

The link direction is not arbitrary. The Nextcloud Tasks app finds a parent with
`task.related === parent.uid`, so **the child carries the parent's UID**, and its
`getParent()` accepts a `RELATED-TO` with `RELTYPE=PARENT` *or with no parameter at
all* — so a plain `RELATED-TO:<uid>` is enough. Reversing it would produce subtasks
the family never sees, which is the one mistake that would quietly undermine
everything, so a test asserts it against the iCalendar text actually sent.

## Deterministic uids make a catch-up pass safe

`butler-holiday-thanksgiving-2026-11-26` is the same string however many times it is
computed. So "has this cycle already been opened?" is a lookup rather than a search,
and a duplicate create is refused by CalDAV's `If-None-Match` and surfaces as the
existing `conflict` error rather than producing a second copy.

That is what lets a pass run after a restart, or twice in a day, without posting
twice. There is no separate "last run" marker anywhere — the cycle's existence in
Nextcloud is the marker.

Because the uid is stable, a settled cycle keeps turning up as a candidate. A closed
cycle is therefore never reopened; without that the butler would raise Thanksgiving
again the morning after settling it.

## The lifecycle

| State | What the butler does |
| --- | --- |
| Not raised, still far off | nothing |
| Not raised, within lead time | **open** — create the cycle, ask the family |
| Open, someone has not replied | **nudge** once, naming them, then go quiet |
| Open, everyone has replied | **settle** — propose a plan, ask for a yes, close |
| Date has passed | **close**, silently |
| Nudge budget spent | **close**, silently |

Closing is deliberately silent. A cycle nobody answered should end quietly rather
than with the butler announcing that it is giving up — that is a reproach, and the
family did nothing wrong by being busy. The closed parent is still there in the
Tasks app if anyone looks.

Cancelling a subtask counts as answering it. Somebody who deliberately cancels is
saying they have no preference, which is a real answer and must not block the cycle.

## Lead times differ by occasion

One number would be wrong at both ends: a weekend raised three weeks out is noise,
and a holiday raised on the Thursday before is useless because the flights have
gone.

| Cycle | Raised | Why |
| --- | --- | --- |
| Weekend | on `planningWeekday`, Thursday by default | Late enough to be concrete, early enough that Friday to Sunday is still shapeable |
| Holiday | 24 days | Travel and accommodation |
| Anniversary | 24 days | Reservations, possibly leave |
| Birthday | 18 days | Presents, a party, invitations |

A weekend cycle is dropped when an occasion already covers that weekend — otherwise
Thanksgiving week gets two conversations, one about Thanksgiving and one about "the
weekend of the 28th", with the same people about the same plans.

## The nudge budget is one, by choice

`maxNudges` defaults to **1**. A butler that asks about the weekend every day gets
the channel muted, and then the family loses the morning briefing too. Asking once
more and then waiting to be asked is the polite failure.

This was a judgement call rather than a derived value. Raise it only if you would
genuinely rather be chased.

## Planning runs the agent; the briefing does not

`dsh-briefing` composes its digest in code, because it reports facts: it costs
nothing, cannot hallucinate an appointment, and still arrives when the model provider
is down.

Planning is the opposite case. Starting a conversation, reading what people want, and
proposing something that suits most of them is judgement, so it goes through
`ctx.discord.prompt` into the room's **own** session. A separate session — a
subagent's, say — would keep the planning conversation out of the transcript the
family is actually having, and the butler would not remember next week that the coast
was discussed.

The prompts are instructions to the butler, not messages to the family. Every one of
them tells it to write agreed plans to the calendar and not to invent anyone's
preferences, and tests assert both, because a cycle that reaches agreement and leaves
nothing on the calendar has wasted everyone's time.

Note what the settle prompt asks for: **one proposal and a confirmation**, not a
declaration of agreement. "Everyone answered" is checkable; "everyone agreed" is not.

## Configuring it

```yaml
- insert:
    - id: planner
      name: 'dsh-planner'
      config:
        channelId: '000000000000000000'   # REQUIRED
        time: '09:00'
        planningWeekday: 4                # Thursday
        workdays: [1, 2, 3, 4, 5]
        holidayLeadDays: 24
        birthdayLeadDays: 18
        anniversaryLeadDays: 24
        maxNudges: 1
        nudgeGapDays: 3
        planWeekends: true
```

`channelId` has no default. A planner with no room to speak in would be a timer that
computes plans and tells nobody, and defaulting it to an arbitrary channel is worse —
the butler would start conversations somewhere the family is not looking.

Cycles live in the household chore list unless `calendar` names somewhere else.

The daily pass is re-armed **before** it runs, so one failed morning does not end the
series — a planner that stops planning after a single CalDAV hiccup is worse than one
that never started, because nobody notices the absence.

`pass()` is public, so an operator can run one without waiting for the timer.
