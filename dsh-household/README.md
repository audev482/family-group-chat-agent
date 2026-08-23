# dsh-household

Registers `ctx.household`: the one place the family is written down. It answers
two questions everything else in the butler needs — "who is this person, by
whatever name they were called?" and "what day is it where the family lives?" —
so the calendar tools, the chore tools, and the Discord channel all share one
set of names and one clock. Install and configure this bundle first; every other
package reads names from it.

This package knows nothing about calendars, mailboxes, or protocols. It is pure
identity and pure date arithmetic. The roster exists for **attribution, not
authorization**: everyone in a home has the same access, and nothing here gates a
capability. What it does is let the butler know who is talking, so "my dentist
appointment" is filed against the right person.

## Name resolution

People say "mum", "Dad", "Alex", not configuration keys. `resolve` folds a spoken
name (case- and whitespace-insensitively) and maps a member's key, display name,
chore tag, or any alias onto exactly one person. The index is built once at load,
so resolution cannot drift between operations.

Ambiguity is refused rather than guessed. The constructor rejects, naming the
members involved, when two members share a chore `tag`, share a `discordUserId`,
or when one spoken name would claim two people. An invalid IANA `timezone` is
rejected the same way. Silently preferring one member would file a chore under
the wrong child, so it is treated as a configuration error at load, not a runtime
surprise. A household with no members is accepted — that is a fresh install, not a
mistake.

## The clock

The household owns `timezone`, so it owns the clock too, which keeps the calendar
and chore packages from each carrying their own copy of this arithmetic and
drifting apart. "Tomorrow" is tomorrow where the family lives, not where the
server runs. A day is local midnight to local midnight — 23 or 25 hours long
twice a year across a daylight-saving change — and `window` resolves that
correctly so a "today" filter does not clip an hour. `day` understands `today`,
`tonight`, `tomorrow`, `yesterday`, a weekday name (the next such day, today
included), and an explicit `YYYY-MM-DD`; anything else returns `undefined` so a
caller can report the phrase back rather than answer about the wrong day.

## API surface

- `list()` — every configured member, in configuration order.
- `member(key)` — one member by configuration key.
- `byDiscordId(id)` — attribute an inbound message to a member.
- `resolve(name)` — a spoken name to one member, or `undefined`.
- `require(name)` — as `resolve`, but throws listing the known members.
- `fromCategories(categories)` — the member a VTODO's `CATEGORIES` assigns it to.
- `tags()` — every chore tag, for building CalDAV category filters.
- `roster()` — one line per member for the system prompt.
- `today(now?)` — the family's current date as `YYYY-MM-DD`.
- `day(phrase, now?)` / `requireDay(phrase, now?)` — resolve a spoken day.
- `shiftDay(dateIso, days)` — add or subtract whole days.
- `window(dateIso, days)` — the instant window covering whole local days.
- `when(value)` — phrase a date the way the butler says it aloud.
- `timeOfDay(value)` — the clock part only, or `all day`.
- `dueness(value, now?)` — `due today`, `overdue by 3 days`, and so on.

Accessors expose `familyName`, `timezone`, `sharedCalendar`, `choresCalendar`, and
`occasions`.

## Occasions belong to the household, birthdays belong to people

A birthday goes on a member because it is a fact about that person. A wedding
anniversary is not — it belongs to the family, and putting it on one partner would
force an arbitrary choice about whose it is. So household-wide recurring dates live
in `occasions`, keyed by a stable id:

```yaml
occasions:
  wedding:
    name: 'Wedding anniversary'
    date: '2014-09-20'
  moved-in:
    name: 'The day we moved in'
    date: '10-01'
```

`MM-DD` or `YYYY-MM-DD` both work; giving the year lets the butler know it is the
tenth rather than just another one. `dsh-occasions` reads these and turns them into
upcoming occasions — this package only stores and exposes them.

## Configuring it

The bundle's `cordis.patch.yml` is commented field by field and is the file you
edit. A member carries a `displayName`, optional `aliases`, a chore `tag`
(defaulting to the display name), and optional `discordUserId`, `email`,
`calendar`, `birthday`, and `role`. `tag` is authoritative for chore assignment
because it is the only channel a human can edit in the Nextcloud Tasks UI;
`email` is mirrored into VTODO `ATTENDEE` for other clients but never read back
as authority. `role` (`adult` or `child`) shapes tone, not access.

```yaml
- insert:
    - id: household
      name: 'dsh-household'
      config:
        familyName: 'The Bakers'
        timezone: 'Europe/Amsterdam'
        sharedCalendar: 'Family'
        choresCalendar: 'Household'
        occasions:
          wedding:
            name: 'Wedding anniversary'
            date: '2014-09-20'
        members:
          alex:
            displayName: 'Alex'
            aliases: ['dad', 'papa']
            role: adult
            calendar: 'Alex'
```

Failures carry a `HouseholdError` with a stable `code` (`duplicate-tag`,
`duplicate-discord-id`, `duplicate-alias`, `invalid-timezone`, `member-not-found`,
and so on) so a tool can turn them into a reply. See the root README for install
and profile setup.
