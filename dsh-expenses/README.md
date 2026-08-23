# dsh-expenses

The family's shared money, as tools the butler can call.

Eight of them: `expenses_balances`, `expenses_list`, `expenses_summary`,
`expenses_export`, `expenses_add`, `expenses_edit`, `expenses_refund`,
`expenses_remove`.

This is the meaning half of a pair, sitting on `ctx.tricount` the way `dsh-chores` sits
on `ctx.caldav`. It knows what a sensible split looks like and how to say a balance out
loud; the transport knows the rest.

## The butler is not the only writer

A separate agent files card transactions into the same ledger, tagging each description
`[ref:<transaction id>]` so it can recognise its own rows later. Everything about how
this package behaves around that follows from one asymmetry: **the butler cannot see
what the feed knows.** The feed's dedupe key is a Plaid transaction id, and a family
saying "put dinner on the ledger" has no such id.

So:

- **The butler never writes a ref tag.** The two agents therefore cannot collide over
  one — the feed's idempotency key is invisible from this side by construction, rather
  than by both sides agreeing to be careful.
- **The tag is never shown to the family**, but "from the bank feed" is, because that
  changes what they should do about a row.
- **Editing or removing a fed row is allowed** — they asked — but the tool says what
  will happen. That agent keeps its own index of what it has filed, so a removed
  expense will not come back; it is gone until somebody adds it by hand. That is
  information, not a refusal.
- **`expenses_add` mentions a same-day, same-amount entry** before filing a second one,
  because the likeliest duplicate is one the feed has already handled. `duplicate_ok`
  files it anyway, for the family who really did buy the same coffee twice.

The one hazard this cannot solve from here: if the family asks the butler to add an
expense that later arrives through the feed, the feed will file it too, because it has
never heard of the butler's row. The duplicate remark catches it in the other direction
only. Nothing short of a shared index would fix that, and a shared index would couple
two agents that are otherwise independent.

## Splits are written the way people write them

Three forms, in rising specificity, because a household splitting evenly should not have
to say so arithmetically:

| Written | Means |
| --- | --- |
| *(omitted)* | evenly between everybody on the ledger |
| `Alex, Sam` | evenly between those two |
| `Alex=60, Sam=40` | those percentages, which must total 100 |

Percentages are reduced to whole parts — `60/40` becomes `3/2` — before filing, so the
Tricount app shows shares rather than frozen amounts, and the split still describes the
household's intent if somebody later corrects the total.

Names go through the household roster first, so "mum" reaches the right person even
though the ledger has never heard the word. A name the household does not know still
resolves against the ledger directly: somebody can be on the ledger without being in the
household config, and refusing to name them would make their entries unreadable rather
than merely unattributed.

## Refunds are entries, not deletions

`expenses_refund` files a separate credit and leaves the original expense alone, so the
ledger keeps the whole story: bought, then returned. Deleting the expense would hide
that it ever happened.

This works only because the transport computes balances from the stored signs — a refund
filed as income exactly inverts its expense. Under the reference implementation's
arithmetic it would have *doubled* the debt instead; see the
[transport's README](../dsh-tricount/README.md).

## Why there is an export tool

"Who owes what" is a sentence. "Where did the money go this year" is a chart, and no
amount of prose substitutes for it.

`expenses_export` writes the ledger to CSV or JSON in the session's working directory,
so the harness's own filesystem and shell tools can do real work on it — group, pivot,
plot, compare months. The butler's job is to put the data somewhere useful and then get
out of the way.

Two decisions in the file shape, both there to stop an analysis being confidently wrong:

**One row per share, not per entry.** An expense split three ways becomes three rows
with the entry's columns repeated. This is the long shape that groups directly by
category, month, payer *or* member, and it is only safe because a split sums exactly to
its entry — so totalling `share_minor` by category gives the same answer as totalling
entries would, while also answering "what did this cost *me*", which the entry-level
shape cannot. `allocation_index == 0` recovers one row per entry.

**Signs are pre-computed.** The API stores an expense negative and a refund positive.
That is correct, and it is also the single most likely thing for an analysis to get
backwards — the reference client for this API gets it wrong, and the mistake makes
refunds add to spending. So every row carries both the stored value and a `spend` column
that is positive for money out and negative for money coming back. Summing `spend` needs
no sign reasoning at all.

The `*_minor` columns are exact integers; sum those. The decimal columns are for reading.

A path is resolved inside the working directory and refused if it escapes. The path
comes from a model, and a model that has been told about a ledger has no business
writing to `/etc` — that is about the difference between a mistake costing a file and a
mistake costing the host, not about trusting the family.

## Analysis is netted, not gross

`expenses_summary` subtracts refunds rather than counting them, and ignores settling-up
transfers entirely. A month with a large return in it did not spend that money, and
reporting the gross would tell the family they are over budget when they are not.

Grouping by `payer` and by `member` answer different questions and both are offered:
`payer` is who put the money up, `member` is whose share it was. "What did this cost me"
is usually the second one.

## Configuring it

```yaml
- insert:
    - id: expenses
      name: 'dsh-expenses'
      config: {}
        # ledgerNames:
        #   alex: 'Alexander Baker'
```

`ledgerNames` maps a household key to the name that member has on the ledger, only where
they differ. The common case needs no configuration.

No prompt context is registered. Restating the ledger on every turn would spend tokens on
every passing question to serve the occasional money one, so the butler looks it up when
it is relevant — the same reasoning as `dsh-occasions`.
