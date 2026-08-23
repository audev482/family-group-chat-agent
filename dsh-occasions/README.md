# dsh-occasions

What is coming up, and what it is worth. US federal holidays computed from their
statutory rules, birthdays and anniversaries from the household, and the derived
fact a family actually plans around: how long a break really is, and what one day
of leave would add to it.

Knowing that Independence Day is on the 4th of July is not useful — the family
owns a calendar. This is useful:

> Independence Day falls on a Friday this year, so that is a three-day weekend —
> and taking Thursday off makes it four.

Everything here is pure arithmetic over calendar dates. No network, no clock, no
feed to poll and none to break.

## The tool

`occasions_upcoming` — holidays, birthdays, anniversaries, and notable breaks
within a window (45 days by default). Answers "anything coming up?", "when is the
next long weekend?", and gives the butler the numbers it needs before helping plan
time off.

There is deliberately **no prompt context**. Restating the next month of the
calendar on every turn would spend tokens on every passing question to serve the
rare planning conversation, so the butler looks this up when it is relevant. The
two paths that genuinely need it — the morning briefing and proactive planning —
call the functions directly rather than going through the model.

## Holidays are rules, not a list

The federal holidays are defined by statute as rules: the third Monday in January,
the last Monday in May, the fourth Thursday in November. Computing them means the
answers are as good in 2035 as today, with nothing to maintain.

The **observation shift** is modelled explicitly because it is the part that
decides whether a holiday is a long weekend at all. Under 5 U.S.C. § 6103 a
fixed-date holiday landing on a Saturday is observed the Friday before, and on a
Sunday the Monday after. So each holiday carries both dates:

```
date      2026-07-04   the statutory day (a Saturday)
observed  2026-07-03   the day off
shift     saturday-to-friday
```

Weekday-rule holidays never shift — they are defined as falling on a Monday or a
Thursday. A test asserts no observed federal holiday lands on a weekend in any
year from 2026 to 2040.

One edge case is real: the observed date can land in a **different year** than the
statutory one. A Saturday New Year's Day is observed on the 31st of December
before it. `holidaysBetween` therefore scans the neighbouring years and selects on
`observed`, so a range ending in December still finds that day off.

## Bridge days, and the difference between a bridge and a day off

A **break** is a run of consecutive days nobody works. A **bridge** is leave that
joins a break to a nearby one, or stretches it into the weekend.

The distinction that matters is whether leave *gains* anything, which each option
reports as its `bonus` — days beyond the leave spent:

| Holiday | Falls on | Break | Leave | Result | Bonus |
| --- | --- | --- | --- | --- | --- |
| Thanksgiving 2026 | Thursday | 1 day | Friday | 4 days | **2** |
| Veterans Day 2026 | Wednesday | 1 day | Mon + Tue | 5 days | **2** |
| Independence Day 2026 | Fri (observed) | 3 days | Thursday | 4 days | 0 |

The first two are bridges: one day of leave reaches the weekend and yields two
days nobody paid for. The third is not — Friday to Sunday is already flush against
the weekend, so taking the Thursday buys exactly the Thursday, and the family knew
they could do that. `bestBridge` returns nothing in that case, and the butler says
nothing, which is the honest answer.

Where two equal-cost options buy the same number of days, the earlier one wins, so
a Monday holiday is bridged with the Friday before rather than the Tuesday after.
That keeps output stable between runs and starts the break sooner, which is
usually the more useful half for travelling.

`notableBreaks` filters to breaks holding a holiday or longer than the household's
ordinary weekend. It deliberately excludes "an ordinary weekend one day of leave
would make into four", because the only way that happens is by bridging to a
nearby holiday — whose own break is already in the list, carrying the same
suggestion. Including both reported Thanksgiving twice: once as the Thursday, and
again as the weekend after it.

## Birthdays and anniversaries

Birthdays are read from members in the `dsh-household` config, because a birthday
belongs to a person. Anniversaries are configured as `occasions` on
`dsh-household` for the same reason in reverse: a wedding anniversary belongs to
the family, not to either partner, so putting it on a member would force an
arbitrary choice.

Both accept `MM-DD` or `YYYY-MM-DD`. Giving the year lets the butler say which one
it is — a fortieth birthday and a tenth anniversary are not like any other year.

The **29th of February** is handled deliberately. In a common year that date does
not exist, and the wrong answer is to skip it: a leap-day birthday would go
unmentioned three years in four. It is observed on the 28th, staying in the month
the family thinks of it as, and flagged `adjusted` so the butler can explain
itself.

## API surface

```ts
// holidays
federalHolidays(year)                  // every holiday statutory in that year
holidaysBetween(startIso, endIso)      // observed in a range, spanning years
observedDate(dateIso)                  // apply the weekend shift
nthWeekdayOf / lastWeekdayOf / weekdayOf / daysInMonth / addDays

// breaks
breakAround(dateIso, options)          // the break containing a date
breaksBetween(startIso, endIso, opts)  // every break overlapping a range
notableBreaks(startIso, endIso, opts)  // only the ones worth raising
bestBridge(entry)                      // the leave worth suggesting, if any

// occasions
upcomingOccasions(fromIso, withinDays, sources)   // one merged list
birthdayOccasions / householdOccasions
nextOccurrence / parseRecurring / dayDiff
```

## Configuring it

```yaml
- insert:
    - id: occasions
      name: 'dsh-occasions'
      config:
        workdays: [1, 2, 3, 4, 5]   # 0 Sunday .. 6 Saturday; defines the weekend
        maxLeave: 3                 # most leave days considered for a bridge
        federalHolidays: true
```

`workdays` defines what a weekend *is*, so a household working Monday to Thursday
should say so and get its three-day weekends counted correctly.

`maxLeave` is three so the gap between Christmas and New Year is still found.
Beyond that it stops being a bridge and becomes booking a holiday, which is not
something the butler should be inferring from a calendar.

An `occasions` key here overrides `occasions` on `dsh-household` and is normally
left out — the same relationship `dsh-chores` has with `choresCalendar`.
