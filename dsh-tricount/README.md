# dsh-tricount

`ctx.tricount` — the household's shared expense ledger, over the Tricount (bunq) API.

The transport half of a pair. It knows about sessions, sharing tokens and signed
decimal strings; it knows nothing about who the family is or what a fair split looks
like. [`dsh-expenses`](../dsh-expenses) supplies that, exactly as `dsh-chores` sits
above `dsh-caldav`.

Installing this alone registers no tools.

## Why not just call the Python CLI

The household already runs `tricount-cli`, driven by a separate agent that files card
transactions. The butler deliberately does not shell out to it:

- **It needs a different runtime.** Python, boto3 and AWS Secrets Manager, where this
  deployment is one Node process with an `.env`. That is a second dependency tree and a
  second credential path on the host, for one capability.
- **Its guardrails are the wrong shape.** Everything is keyed on a Plaid transaction id
  as the idempotency key. A family saying "put dinner on the ledger" has no such id, so
  the CLI's central safety property does not apply to the butler's use at all.
- **It would inherit three money bugs.** See below. They are in the library underneath,
  so wrapping the CLI cannot avoid them.

Both agents write the same ledger, and that shared ledger is the source of truth — the
same arrangement as the CalDAV collections the butler and the family's phones both
write.

## The protocol is unsigned

Worth stating because it is what makes reimplementing it reasonable. A device registers
by posting a UUID and an RSA public key; a session token comes back; everything after
that is plain REST with a header. **The public key is never used to verify anything the
client sends** — the reference implementation generates a keypair and discards the
private half. So this package needs no crypto dependency: Node's `generateKeyPairSync`
produces the PKCS#1 public PEM the host wants, and there is nothing to sign with.

## Money is integers, and that is the point

Amounts are whole minor units — cents for dollars, yen for yen — and the only floating
point is at the edges where a person types `54.20`.

Two reasons. First, `parseFloat('54.20') * 100` is `5419.999999999999`, so the obvious
parse loses a cent on an amount somebody typed exactly; `parseMinor` works on the digits
instead. Second, and worse, splitting:

```
round(100.00 / 3) × 3  =  33.33 × 3  =  99.99
```

One cent short, so the allocations of an entry no longer sum to the entry and the
ledger's own arithmetic stops closing. `splitByRatio` distributes the remainder by the
largest-remainder method, so a split always sums to exactly what was split. Ties go to
the earlier member, which makes it deterministic — re-filing an entry cannot silently
move a cent between two people.

Currencies with no decimal place are handled, because `1500` in a JPY ledger is fifteen
hundred yen and treating it as two-decimal is a hundredfold error.

## Three defects this package does not reproduce

All three are in the reference client, and all three affect money, so they are worth
naming rather than quietly working around.

**1. Balances treated a refund as a second purchase.** `get_balances` takes `abs()` of
every amount before adding it up, which erases the only thing distinguishing money going
out from money coming back:

| | Alex | Sam |
| --- | --- | --- |
| Alex pays 38.04, split evenly | +19.02 | −19.02 |
| the shop refunds Alex 38.04 — **with `abs()`** | +38.04 | **−38.04** |
| the same refund — **with the stored signs** | 0 | **0** |

Sam finishes owing twice what he started with, for a purchase that was returned.
`computeBalances` reads the signs the API already stores, which also makes the formula
uniform: every entry is "the owner put this in, each member took their share out", and a
settling-up payment needs no special case. Tested as an invariant — a refund must exactly
invert its expense.

**2. Editing an expense could turn it into income.** `edit_transaction` writes a
caller's amount through unchanged. A caller naturally passes a positive number, an
expense is stored negative, and the result reverses the entry's effect on every balance.
`edit()` re-applies the entry's existing sign.

**3. Editing destroyed the split.** The same function rewrites every allocation as a
fixed amount, discarding the `share_ratio` that makes a split still mean something after
the total changes — and divides the new total with independent per-share rounding, so the
parts stop summing to the whole. `edit()` carries ratios through and re-divides exactly;
a fixed split is scaled by its existing proportions, so an uneven split stays uneven.

## Custody

**The sharing token is a credential.** Anyone holding it can read and write the whole
ledger — that is how share-by-link works. So `tokenRef` names a credential rather than
containing one, resolved per connect so a rotation takes effect without a restart, and
never included in an event. A pasted token is rejected at load, because a secret in a
config file reaches logs, backups and version control.

**The device identity must be stable.** `appId` and `publicKeyRef` identify this
installation. Leave them out and a device is minted per process: the ledger is still
reachable, but a new anonymous user is registered on every restart. The seam emits
`tricount/device` **once** with the values to persist, because the consequence of
ignoring it is otherwise invisible.

## Configuring it

```yaml
- insert:
    - id: tricount
      name: 'dsh-tricount'
      config:
        tokenRef: 'TRICOUNT_TOKEN'    # a reference, never the token
        # appId: '...'                # set after the first run
        # publicKeyRef: 'TRICOUNT_PUBLIC_KEY'
```

Get the token from the Tricount app: open the tricount, ⋯ → Share, and take the token
from the link.

## Reporting

There is no logger on a cordis context, so the package emits events: `tricount/request`
per API call with operation, path, timing and outcome, and `tricount/device` for the
minted-identity notice. **Neither ever carries an amount.** An event stream recording
what the family spends would be a second copy of the ledger sitting in the logs.
