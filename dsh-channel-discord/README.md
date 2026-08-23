# dsh-channel-discord

The family's way of talking to the butler. This bundle registers `ctx.discord`:
one bot connection, one agent session per Discord channel, and an outbound path
other plugins use to speak unprompted.

For the one-time bot setup (application, token, the Message Content intent, the
invite URL, copying channel ids) and for install, see the root
[`README.md`](../README.md) — none of it is repeated here.

## One room, one conversation

The reference XMTP channel maps one conversation to one person. A family room is
not that: several people share one thread, and "can you move it an hour later"
depends on who asked and on what someone else said two messages ago. So this
channel keeps **one agent session per Discord channel, not per person** — the
session id is derived from the channel — and the room shares a conversation, so
Kit can follow up on what Sam asked.

Because that id is derived only from the channel, it is the same after a restart,
so the room's session is **resumed** rather than recreated and the butler still
remembers Thursday's conversation on Friday. Resume failing is not an error: a
room's first ever message has nothing to load, and so does a bundle with no
session persistence mounted. Both fall back to a fresh session, and
`discord/session` reports which happened — `resumed: false` on a room that has
been talking for weeks is the signal that persistence has stopped working.

Every inbound turn is prefixed with the resolved speaker before it reaches the
model, e.g. `[Sam] when is the dentist`. The name comes from `ctx.household` via
the sender's Discord id. A sender who is not in the roster is marked as such —
`[Casey (not in the family roster)] ...` — so the butler does not file their
request against a family member.

That prefix is the whole multi-user mechanism. The roster exists for
**attribution, not authorization**: there are no per-person permission checks,
and nothing gates a capability by who is asking. Everyone in the room has
identical access, by design — a household is one trust domain.

## What it listens to

`channelIds` is the butler's entire listening scope, and it is **required**. An
empty list makes the butler **mute, not omniscient** — it will not answer
anywhere. This is deliberate: a bot with the Message Content intent can read
every message in every channel it can see, so the allowlist is what keeps it to
the room you meant. `channelIds` scopes *where* the butler listens; it is not a
permission model for *who* may speak to it.

`respondTo` decides how it answers in a listened channel:

```yaml
respondTo: all       # answer every message — right for a dedicated #butler channel
respondTo: mention   # answer only when @mentioned — right for a general family channel
```

`shouldAnswer()` decides each message in a fixed order, returning the reason a
message was ignored (or `undefined` to answer): bot senders and the butler's own
messages first; then direct messages, honoured only when `allowDirectMessages`
is on **and** the sender is in the roster (a DM is already addressed to the
butler, so it skips the mention check); then the channel allowlist, dropping a
guild message not in `channelIds`; then empty content, usually the sign the
Message Content intent is off; then, in a `mention` channel, anything that does
not mention the bot. Accepted messages are deduplicated by id, in a set capped
at `MAX_DEDUP_SIZE` (5000) whose oldest half is pruned on overflow.

## Sending long replies

Discord caps one message at `DISCORD_MESSAGE_LIMIT` (2000 characters).
`splitForDiscord` breaks a longer reply at the largest available boundary —
paragraph, then line, then word — so a split never lands mid-sentence. It also
tracks code fences: if a chunk ends with an open ` ``` `, it closes the fence
and reopens it at the top of the next chunk, so a fenced block never leaks its
formatting across the break and turns the rest of the conversation into code.

While the model is working the typing indicator is shown, refreshed every 8
seconds because Discord's own indicator lapses after about ten. Set
`typingIndicator: false` to suppress it.

## Reconnection and announce

The connect loop is bounded: after `maxReconnectAttempts` consecutive failures
(default 10) it gives up rather than spinning, waiting `reconnectDelayMs`
(default 5000) between attempts. Status transitions are emitted on
`discord/status`; each accepted inbound message emits `discord/inbound` carrying
sender and channel identity only — never the text.

```ts
await ctx.discord.announce(channelId, text)
```

`announce` is the outbound path a plugin uses to speak without being asked;
`dsh-briefing` posts the morning digest through it. It splits text the same way
inbound replies are split, and throws if the channel is not yet connected.

## Two ways for a plugin to speak

`announce` posts fixed text and the model never sees it. That is right for the
morning digest, which must be correct, cost nothing, and still arrive when the
provider is down.

`prompt` is the other half — it makes the butler *start* a conversation:

```ts
const reply = await ctx.discord.prompt(channelId, 'A long weekend is three weeks off. Ask the family what they want to do.')
```

The turn goes into the room's own session, so the butler can look things up,
decide what is worth raising, and be followed up on by the family afterwards. It
runs in the **shared** room session on purpose: a separate session, such as a
subagent's, would keep the planning conversation out of the transcript the family
is actually having, and the butler would not remember next week that the coast
was discussed.

Both inbound messages and prompts pass through one per-room queue, so a scheduled
prompt can never land halfway through the butler answering somebody — the two
would otherwise be writing to one session at once.

The message is attributed to the plugin rather than dressed up as a family member,
so the model can tell that nobody asked. And a failure is thrown rather than
posted: nobody requested this, so an error in the room would be unexplained noise,
and the caller can decide whether to try again on its next pass.

## Configuration

```yaml
tokenRef: 'DISCORD_BOT_TOKEN'   # a credential REFERENCE, never the token itself
channelIds: []                  # required; empty means mute
respondTo: all                  # 'all' | 'mention'
allowDirectMessages: true
typingIndicator: true
channelName: discord            # session-id prefix, distinguishes parallel mounts
maxReconnectAttempts: 10
reconnectDelayMs: 5000
```

`tokenRef` names an environment variable resolved at each connect; the token is
re-resolved per connection, never cached, and pasting it here fails loudly at
load.

## Injection and peers

```ts
static inject = ['agents', 'agentDefaultModel', 'credentials', 'household']
```

`discord.js` is an **optional peer**, imported lazily on first connect — the
package mounts, typechecks, and tests without it, and if it is missing the error
says exactly how to install it. The channel drives a narrow structural interface
it declares itself rather than importing `discord.js` types, so it compiles in a
profile that has no Discord at all. Tests substitute the `internals.loadSdk`
seam with a fake gateway and run with no token and no network.
