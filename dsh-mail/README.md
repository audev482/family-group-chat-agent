# dsh-mail

Registers `ctx.mail`: search, read, send, reply, forward, flag, move, and trash
over plain IMAP and SMTP. It is the transport half of the mail capability — the
meaning ("email Grandma", "did the school write back?") lives in `dsh-mail-tools`,
which is what the model actually sees. Reach for this package if you need a
mailbox as a service and want to build your own phrasing on top.

Nothing here knows about families or names. Splitting transport from meaning is
deliberate: the briefing can count unread mail without mounting a shelf of tools,
and a second channel could reuse the mailbox without inheriting the wording.
Yahoo, Gmail, Outlook, iCloud, and Fastmail are presets that fill in host names
and ports, but nothing in the package is provider-specific; give explicit
`imapHost`/`smtpHost` for anything else.

## UIDs, not sequence numbers

Every operation addresses a message by its IMAP UID, never by sequence number.
Sequence numbers renumber the moment anyone deletes a message from a phone, so a
butler that read "message 4" and flagged "message 4" a minute later would
eventually touch the wrong letter. UIDs are stable for the life of the mailbox,
and a UID is meaningless without the mailbox it belongs to, so both travel
together.

## One warm connection per account

A per-operation connect costs a second or two of TLS and login on every question,
which is very noticeable in a chat. A permanent connection, though, means a
rotated password never takes effect. The compromise is one warm IMAP connection
per account with an idle deadline (`idleTtlMs`, five minutes by default): fast
enough for a conversation, and the password is re-resolved through
`ctx.credentials` on every reconnect so a rotation still lands promptly. A
connection the server has since dropped is remade once; a second failure is real
and reported.

An authentication failure is reported as an app-password problem — the single
most common reason a first connection fails once two-factor authentication is on
— and is **not** retried, because hammering a provider is how an account gets
locked. `passwordRef` names a credential and never holds the password itself; a
pasted secret fails at load.

## Sending and deleting, handled carefully

`send()` composes the message with `nodemailer`, then files a copy in Sent by
building the raw bytes through nodemailer's stream transport and appending them
over IMAP. Without that copy the family's mail client would show a thread missing
half its turns. Filing is best-effort: the mail has already left, so a failure to
file is reported in the result rather than failing the send. Results name exactly
which addresses the server accepted, which it refused, and whether the Sent copy
was filed. `reply()` gets `In-Reply-To` and `References` right so the recipient's
client threads it, and marks the original answered.

`trash()` **moves** a message to the Trash mailbox rather than expunging it.
"Delete that" means "get it out of my inbox", and a mistake stays recoverable in
the mail app; permanent deletion is left to the family. When an account has no
Trash mailbox, it falls back to the `\Deleted` flag, as a client would.

## API surface

- `list()` / `account(name?)` — configured accounts, and the address one sends from.
- `mailboxes(options?)` — the folders on an account, with unread counts.
- `search(query?, options?)` — matching messages, newest first, without bodies.
- `read(uid, options?)` — one message with its (clipped) plain-text body.
- `send(message)` — send, filing a copy in Sent.
- `reply(uid, body, options?)` — threaded reply, with optional reply-all and quoting.
- `forward(uid, to, options?)` — forward with an optional note.
- `flag(uid, change, options?)` — set or clear seen / flagged / answered.
- `move(uid, destination, options?)` — move to another mailbox.
- `trash(uid, options?)` — move to Trash.
- `probe(options?)` — check an account is reachable and its password works.

Message bodies are decoded to plain text (HTML reduced enough to read), whitespace
tidied, and clipped to `maxBodyChars` (8000 by default) so a newsletter cannot
crowd out the rest of a prompt. Every operation emits `mail/request` with
`{ account, operation, durationMs, ok }` and no subjects, addresses, or bodies.
Failures carry a `MailError` with a stable `code` (`auth-failed`,
`credential-unconfigured`, `connect-failed`, `mailbox-not-found`,
`message-not-found`, `no-recipients`, `send-failed`, `sdk-missing`, and so on).

## SDKs and testing

`imapflow`, `nodemailer`, and `mailparser` are optional peers, loaded lazily so a
calendar-only household never pays for them. The specs substitute the
`internals.loadSdk` seam with a fake server, so the suite runs without a socket.

```yaml
- insert:
    - id: mail
      name: 'dsh-mail'
      config:
        defaultAccount: family
        accounts:
          family:
            address: 'your-family@yahoo.com'
            displayName: 'The Family'
            passwordRef: 'YAHOO_APP_PASSWORD'
            preset: yahoo
```

See the root README for install, the optional-peer list, and the app-password
walkthrough.
