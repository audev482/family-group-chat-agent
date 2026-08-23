# Making the butler proactive — design

A butler that only answers questions is a search box with manners. This is the
design for the part that speaks first: noticing that a birthday, an anniversary,
or a long weekend is coming, and running the conversation that turns it into
plans on the calendar.

Written before implementation, because the hard part here is not scheduling — it
is that **consensus is state**, and most of the ways to store it are wrong.

## What is already true (verified, not assumed)

**There is a heartbeat.** `dsh-briefing` already schedules a daily pass in
process: `ctx.effect` owns a `setTimeout` chain, the next run is computed from
the family's local wall clock via `zonedToInstant`, and it is covered by 12 tests
including both daylight-saving transitions. Cron is not needed to make something
happen on a schedule.

**Cron and systemd solve different problems.** What an in-process timer cannot
survive is the *process* dying. On a single host that is systemd's job
(`Restart=always`), not cron's. Cron would mean a second process model: a fresh
`dsh` per run, with no view of the family's live conversation, its own credential
path, its own log, and its own bundle composition to keep in step. For a
single-box Ansible deploy that is two artifacts where one will do.

**Subagents already do what "sub-planning persona" means.** From
`packages/subagent/subagent/src/child-agent.ts`: a child agent takes a
`ChildComposition` with a `persona` that **shadows** the deployment persona, plus
a `toolFilter` that intersects with what its parent admits, both owned by the
child's scope and invisible to parent and siblings.

**But — corrected after verification — a subagent is the wrong tool here.** See
"Resolved unknowns" below. The feature is real; applying it to family planning
would fragment the conversation.

## Resolved unknowns

Both open questions from the first draft have been answered.

### Nextcloud Tasks does render `RELATED-TO` subtasks

Verified by reading the app that will render them, which is stronger than a
one-off manual check because it shows the rules rather than one example.

- `src/models/task.js` `getParent()` returns the first `related-to` property whose
  `RELTYPE` is `PARENT` **or absent**. So a plain `RELATED-TO:<uid>` with no
  parameter is treated as the parent link — nothing extra to set.
- `src/store/tasks.js:132` matches with `task.related === parent.uid`, so the
  **child** carries the **parent's UID**. That is the direction to write.
- `src/components/TaskBody.vue` renders a `task-item__subtasks` container with
  "Add subtask", "Show/Hide subtasks", "Show/Hide closed subtasks", and a hidden
  subtask indicator. The tree is a real part of the UI.
- `src/store/tasks.js:239` renders a task at top level when it has no `related`
  **or its parent is not in the list**. An orphaned subtask therefore still
  appears rather than vanishing, which is the failure mode to want.

### A planning subagent is possible, and still the wrong choice

`ctx.subagents` is a real service (`SubagentRuntime`), and
`SubagentStartRequest` requires `parent: Agent` — a live parent. The Discord
channel holds one per room, so timer code could supply it. It would work.

It should not be used, for a reason that has nothing to do with feasibility: a
child agent gets **its own session**. The planning conversation would then live
outside the room's transcript, which is precisely the continuity that resuming the
room session exists to preserve. The butler needs to remember next week that the
family discussed the coast, in the same thread as everything else they said.

Consensus state lives in Nextcloud rather than in agent memory, so the usual
argument for an isolated child — keeping its working state separate — buys nothing
here either.

So planning runs **in the room's own session**, via an injected prompt. The
persona steering that a child's shadowing persona would have provided is carried
by the text of that prompt instead.

Subagents remain the right tool for a bounded question the butler wants an answer
to — "compare three restaurants near the harbour" — where an isolated scratch
session is a feature rather than a loss.


## The hard problem: consensus is durable state

"Try to get consensus" is where a naive implementation fails, and it fails
quietly. The butler posts *what shall we do this weekend?* and then has no memory
that it asked, no idea who replied, no way to tell when agreement is reached, and
nothing to act on when it is.

A planning cycle is a multi-day, multi-person conversation. Its state has to live
somewhere that survives a restart **and** is visible to the family. Three
candidates:

| Where | Survives restart | Family can see it | Family can edit it |
| --- | --- | --- | --- |
| Agent session memory | no | no | no |
| A file on the host | yes | no | no |
| **A VTODO in Nextcloud** | yes | yes | yes |

The third is obviously right, and it is the same reasoning that put chores in
Nextcloud rather than in the butler's head. A planning cycle **is** a task:

```
VTODO  uid=butler-weekend-2026-08-28   "Plan the weekend of Fri 28 Aug"
  ├── VTODO  RELATED-TO=butler-weekend-2026-08-28   "Alex: anything you want to do?"
  └── VTODO  RELATED-TO=butler-weekend-2026-08-28   "Sam: anything you want to do?"
```

`RELATED-TO` is already in `TodoFields` and already read by `readTodo`. The
Nextcloud Tasks app renders subtasks — the `X-OC-HIDESUBTASKS` property in real
server data is the tell.

What this buys, all of it for free:

- **Who has not weighed in** is "which subtasks are still open". No bookkeeping.
- **The family can answer in the Tasks app** instead of in chat, and the butler
  reads it either way.
- **Consensus** is a state the butler can close deliberately, and the closed
  parent is a record that the cycle happened.
- **Idempotence.** The cycle UID is derived from its type and target date, so
  "has this cycle already been opened?" is a UID lookup — and `ctx.caldav.create`
  already sends `If-None-Match: *`, so a duplicate create returns 412, which
  already maps to the `conflict` error code. A missed run caught up after a
  restart cannot double-post.

That last point is why no separate "last run" marker is needed anywhere. The
cycle's existence in Nextcloud *is* the marker.

## Occasions: compute them, do not fetch them

US federal holidays are defined by statute as **rules**, not as a list: the third
Monday in January, the last Monday in May, and so on, plus fixed dates with a
weekend-observation rule (Saturday is observed on the preceding Friday, Sunday on
the following Monday). Eleven of them. Entirely computable offline, testable
forever, no network call, no dependency, no feed to poll and no feed to break.

The observation rule is not a detail — it is what decides whether something is a
long weekend at all.

And the useful fact is rarely "the 4th of July is a holiday". It is:

> Independence Day falls on a Friday this year, so that is a three-day weekend —
> and taking Thursday off makes it four.

**Bridge-day detection is the actual product** for vacation coordination. A
holiday on a Tuesday with a Monday bridge is a 4-day break for one day of leave;
that is worth telling a working couple about three weeks early, and it is pure
arithmetic once the holiday rules are in place.

Birthdays are already in the `dsh-household` member config. Anniversaries are
not, and do not belong on a member — a couple's anniversary is a household fact.
That wants a household-level `occasions` list.

## Lead time is per occasion, not global

A single lead time is wrong at both ends: a weekend planned three weeks out is
noise, and a holiday raised on the Thursday before is useless because the flights
have gone.

| Cycle | Opens | Why |
| --- | --- | --- |
| Weekend | Thursday, ~2 days ahead | The couple works Mon–Fri; Thursday is when Fri–Sun is still shapeable |
| Long weekend / holiday | 21–28 days | Travel and bookings |
| Anniversary | 21–30 days | Reservations, gifts, possibly leave |
| Birthday | 14–21 days | Presents, a party, invitations |

## Deterministic composition vs. running the agent

The briefing is composed in code on purpose: it must be correct, it must cost
nothing, and it must still arrive when the model provider is down. Planning is
the opposite case — the value *is* judgement and conversation, so a planning pass
should run the agent.

That means the planner needs a way to put a prompt into a room's session and let
the reply reach Discord. `dsh-channel-discord` today answers inbound messages and
has one-way `announce()`. It needs a third path: run this text as a turn in the
room's session, and deliver the result.

## Proposed packages

Following the existing seams, and additive only — nothing in the harness changes.

**`dsh-occasions`** — knows what is coming. US federal holiday rules with weekend
observation, birthdays and anniversaries from config, and the derived facts:
is this a long weekend, is there a bridge day, how many days off does one day of
leave buy. Pure computation, no I/O, no network. The most testable package in the
workspace.

**`dsh-planner`** — the proactive engine. Owns cycle lifecycle: open a cycle as a
parent VTODO plus per-member subtasks, ask in the room, read who has answered,
nudge within a budget, write agreed plans to the calendar, close the cycle.
Holds the schedules. Injects each pass as a scoped planning subagent.

**`dsh-household`** (extend) — a household-level `occasions` list for
anniversaries and custom recurring dates; optionally per-member `workdays` so
"the weekend" is not hard-coded to Fri–Sun.

**`dsh-channel-discord`** (extend) — a method to run a prompt in a room's session
and deliver the reply, so the agent does the talking rather than code.

## Deployment: this design suits a single box

One systemd unit with `Restart=always`, one config tree, one log stream, one set
of credentials. Ansible templates the unit, the profile, and the `.env`, and
that is the whole deploy. No crontab entries to keep in step with the bundle
composition, and no second copy of the credential wiring.

## Risks, and what I would prove before building it all

**Nudge fatigue is the real failure mode.** A butler that asks about the weekend
every day is worse than one that never asks — the family mutes the channel and
then the briefing is gone too. Every cycle needs a nudge budget and a terminal
"stopped asking" state, and the default should err quiet. This is a product
decision more than a technical one and should be settled before the code.

**Subtask rendering.** The `RELATED-TO` plan depends on the Nextcloud Tasks app
showing subtasks the way expected. The evidence is indirect. Worth one manual
check against the real server before building on it.

**Spawning a planning subagent from a timer.** Subagents are normally created by
an agent through the subagent tool. Creating one from plugin code on a schedule
uses the same `ctx.agents.create` path the Discord channel already uses, so it is
plausible — but it is unproven and is the one genuine spike here.

**Consensus has no clean definition.** "Everyone answered" is checkable.
"Everyone agreed" is not. The honest design is that the butler reaches a
*proposal* and asks for a yes, rather than trying to detect agreement itself.
