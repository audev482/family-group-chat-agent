/**
 * The IMAP and SMTP transport: sockets, sessions, and the one place that knows
 * `imapflow`, `nodemailer`, and `mailparser` exist.
 *
 * Two things here are deliberate and worth knowing before changing anything:
 *
 * **Everything addresses messages by UID, never by sequence number.** Sequence
 * numbers renumber the moment anyone deletes a message from a phone. A butler
 * that read "message 4" and then flagged "message 4" a minute later would
 * eventually flag the wrong letter. UIDs are stable for the life of the mailbox.
 *
 * **The connection is kept warm but not kept forever.** A per-operation connect
 * costs a second or two of TLS and login on every question, which is very
 * noticeable in a chat. A permanent connection means a rotated app password
 * never takes effect and a dead socket has to be detected. So the connection is
 * cached with an idle deadline, and any unusable connection is dropped and
 * remade once.
 *
 * @module dsh-mail/imap
 */

import {
  DEFAULT_MAX_BODY_CHARS,
  MailError,
  type FlagChange,
  type MailboxInfo,
  type MessageDetail,
  type MessageSummary,
  type OutgoingMessage,
  type ResolvedAccount,
  type SearchQuery,
  type SendResult,
} from './types.ts'
import {
  chooseBody,
  clipBody,
  formatAddress,
  NO_SUBJECT,
  normaliseAddresses,
  normaliseWhitespace,
  parseAddress,
} from './message.ts'

/* ------------------------------------------------------------------ *
 * Narrow structural views of the optional peers.
 *
 * Declared rather than imported so the package typechecks without the
 * libraries present, and so tests can substitute a fake that satisfies
 * only what is actually used.
 * ------------------------------------------------------------------ */

/** An IMAP envelope as `imapflow` reports it. */
export interface ImapEnvelope {
  date?: Date
  subject?: string
  messageId?: string
  inReplyTo?: string
  from?: { name?: string; address?: string }[]
  replyTo?: { name?: string; address?: string }[]
  to?: { name?: string; address?: string }[]
  cc?: { name?: string; address?: string }[]
}

/** A MIME body structure node, walked to spot attachments. */
export interface ImapBodyStructure {
  type?: string
  disposition?: string
  dispositionParameters?: Record<string, string>
  parameters?: Record<string, string>
  size?: number
  childNodes?: ImapBodyStructure[]
}

/** A fetched message. */
export interface ImapFetchMessage {
  uid: number
  seq: number
  size?: number
  flags?: Set<string>
  envelope?: ImapEnvelope
  bodyStructure?: ImapBodyStructure
  source?: Uint8Array
}

/** A mailbox as `list()` reports it. */
export interface ImapListEntry {
  path: string
  name: string
  specialUse?: string
  status?: { messages?: number; unseen?: number }
}

/** The subset of `ImapFlow` this module uses. */
export interface ImapClientLike {
  usable: boolean
  connect(): Promise<void>
  logout(): Promise<void>
  close(): void
  on(event: string, listener: (...args: never[]) => void): unknown
  list(options?: { statusQuery?: { messages?: boolean; unseen?: boolean } }): Promise<ImapListEntry[]>
  getMailboxLock(path: string): Promise<{ path: string; release(): void }>
  search(query: Record<string, unknown>, options?: { uid?: boolean }): Promise<number[] | false>
  fetchAll(
    range: string | number[],
    query: Record<string, unknown>,
    options?: { uid?: boolean },
  ): Promise<ImapFetchMessage[]>
  messageFlagsAdd(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>
  messageFlagsRemove(range: string | number[], flags: string[], options?: { uid?: boolean }): Promise<boolean>
  messageMove(range: string | number[], destination: string, options?: { uid?: boolean }): Promise<unknown>
  append(path: string, content: string, flags?: string[], date?: Date): Promise<unknown>
}

/** The subset of a `nodemailer` transport this module uses. */
export interface SmtpTransportLike {
  sendMail(message: Record<string, unknown>): Promise<{
    messageId?: string
    accepted?: (string | { address: string })[]
    rejected?: (string | { address: string })[]
  }>
  close?(): void
}

/** The parsed-mail shape this module reads. */
export interface ParsedMailLike {
  text?: string
  html?: string | false
  attachments?: { filename?: string; contentType?: string; size?: number }[]
}

/** How the transport reaches its libraries. Replaced wholesale in tests. */
export interface MailSdk {
  /**
   * Build an unconnected IMAP client.
   * @param options - connection options.
   * @returns the client.
   */
  createImapClient(options: Record<string, unknown>): ImapClientLike
  /**
   * Build an SMTP transport.
   * @param options - connection options.
   * @returns the transport.
   */
  createSmtpTransport(options: Record<string, unknown>): SmtpTransportLike
  /**
   * Parse a raw RFC 822 message.
   * @param source - the raw message.
   * @returns the parsed message.
   */
  parseMessage(source: Uint8Array | string): Promise<ParsedMailLike>
  /**
   * Build the raw bytes of an outgoing message, for filing in Sent.
   * @param message - nodemailer message options.
   * @returns the raw message.
   */
  buildMessage(message: Record<string, unknown>): Promise<string>
}

let sdk: MailSdk | undefined

/**
 * Load the mail libraries on first use.
 *
 * Lazy so that a household using only the calendar never pays for them, and so
 * that a missing install is reported as a clear message instead of a crash at
 * plugin load.
 * @returns the loaded SDK.
 */
async function loadSdk(): Promise<MailSdk> {
  if (sdk !== undefined) return sdk
  let imapflow: { ImapFlow: new (options: Record<string, unknown>) => ImapClientLike }
  let nodemailer: {
    createTransport: (options: Record<string, unknown>) => SmtpTransportLike & {
      sendMail(message: Record<string, unknown>): Promise<{ message?: unknown }>
    }
  }
  let mailparser: { simpleParser: (source: Uint8Array | string) => Promise<ParsedMailLike> }
  try {
    // CommonJS packages: the namespace may arrive under `default` from ESM.
    const imapMod = await import('imapflow') as Record<string, unknown>
    const mailerMod = await import('nodemailer') as Record<string, unknown>
    const parserMod = await import('mailparser') as Record<string, unknown>
    imapflow = (imapMod.ImapFlow !== undefined ? imapMod : imapMod.default) as typeof imapflow
    nodemailer = (mailerMod.createTransport !== undefined ? mailerMod : mailerMod.default) as typeof nodemailer
    mailparser = (parserMod.simpleParser !== undefined ? parserMod : parserMod.default) as typeof mailparser
  } catch (error) {
    throw new MailError(
      'sdk-missing',
      'mail support needs the imapflow, nodemailer, and mailparser packages. Install them alongside this plugin: '
      + 'dsh plugin add <path-to-dsh-mail> imapflow nodemailer mailparser',
      { cause: error },
    )
  }
  sdk = {
    createImapClient: options => new imapflow.ImapFlow(options),
    createSmtpTransport: options => nodemailer.createTransport(options),
    parseMessage: source => mailparser.simpleParser(source),
    buildMessage: async (message) => {
      // The stream transport hands back the composed bytes without sending.
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' })
      const info = await transport.sendMail(message) as { message?: Uint8Array | string }
      const raw = info.message
      if (raw === undefined) throw new MailError('send-failed', 'could not compose the message for filing in Sent')
      return typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
    },
  }
  return sdk
}

/** Test seam. Substitute `loadSdk` to run the transport without a mail server. */
export const internals = {
  /** How the SDK is obtained. */
  loadSdk,
  /**
   * Discard the memoised SDK.
   */
  resetSdk(): void {
    sdk = undefined
  },
}

/** How the transport resolves the app password at each connection. */
export type PasswordResolver = (account: ResolvedAccount) => Promise<string>

/** One warm IMAP connection and when it stops being trusted. */
interface WarmConnection {
  client: ImapClientLike
  expiresAt: number
}

/** Flags IMAP uses for the states a person thinks of as read, starred, replied. */
const FLAG = { seen: '\\Seen', flagged: '\\Flagged', answered: '\\Answered', deleted: '\\Deleted' } as const

/** Special-use attributes, in the order a mailbox role is looked for. */
const SENT_ROLES = ['\\Sent'] as const
const TRASH_ROLES = ['\\Trash'] as const

/**
 * The mail transport for one configured account.
 *
 * Owns the connection, not the meaning: it knows how to search and send, and
 * nothing about families, names, or chores.
 */
export class MailTransport {
  private readonly account: ResolvedAccount
  private readonly resolvePassword: PasswordResolver
  private readonly idleTtlMs: number
  private readonly timeoutMs: number
  private readonly maxBodyChars: number
  private warm: WarmConnection | undefined
  /** Serialises IMAP work: one command sequence at a time per connection. */
  private queue: Promise<unknown> = Promise.resolve()
  private mailboxCache: { entries: MailboxInfo[]; at: number } | undefined

  /**
   * @param account - the resolved account.
   * @param options - password resolution and timing.
   */
  constructor(account: ResolvedAccount, options: {
    resolvePassword: PasswordResolver
    idleTtlMs: number
    timeoutMs: number
    maxBodyChars?: number
  }) {
    this.account = account
    this.resolvePassword = options.resolvePassword
    this.idleTtlMs = options.idleTtlMs
    this.timeoutMs = options.timeoutMs
    this.maxBodyChars = options.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS
  }

  /**
   * Run IMAP work on a live connection, one caller at a time.
   *
   * A single retry covers the ordinary case of a warm connection the server has
   * since dropped. A second failure is real and is reported.
   * @param work - what to do with the connection.
   * @returns the result of the work.
   */
  private async withImap<T>(work: (client: ImapClientLike) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      try {
        return await work(await this.connection())
      } catch (error) {
        if (isAuthFailure(error)) {
          // A rejected password will be rejected again; do not hammer the server,
          // which is how a mail provider decides to lock an account.
          await this.drop()
          throw new MailError(
            'auth-failed',
            `${this.account.address} rejected the login. Yahoo and most providers require an app password rather `
            + `than the account password once two-factor authentication is on; check the credential named `
            + `${JSON.stringify(this.account.passwordRef)}.`,
            { account: this.account.name, cause: error },
          )
        }
        await this.drop()
        return await work(await this.connection())
      }
    })
    // Keep the chain alive regardless of this caller's outcome.
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * The current connection, opening one when needed.
   * @returns a usable client.
   */
  private async connection(): Promise<ImapClientLike> {
    const warm = this.warm
    if (warm !== undefined && warm.client.usable && warm.expiresAt > Date.now()) {
      warm.expiresAt = Date.now() + this.idleTtlMs
      return warm.client
    }
    await this.drop()
    const loaded = await internals.loadSdk()
    const password = await this.resolvePassword(this.account)
    const client = loaded.createImapClient({
      host: this.account.imapHost,
      port: this.account.imapPort,
      secure: this.account.imapSecure,
      auth: { user: this.account.username, pass: password },
      // The gateway's own logs would carry message subjects and addresses.
      logger: false,
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
      socketTimeout: Math.max(this.timeoutMs, 60_000),
      clientInfo: { name: 'dsh-butler' },
    })
    // An EventEmitter with no 'error' listener takes the process down with it.
    // A dropped IMAP socket is ordinary; it must not be fatal.
    client.on('error', () => undefined)
    try {
      await client.connect()
    } catch (error) {
      if (isAuthFailure(error)) {
        throw new MailError(
          'auth-failed',
          `${this.account.address} rejected the login. Providers with two-factor authentication on require an `
          + `app password; check the credential named ${JSON.stringify(this.account.passwordRef)}.`,
          { account: this.account.name, cause: error },
        )
      }
      throw new MailError(
        'connect-failed',
        `could not reach ${this.account.imapHost}:${this.account.imapPort} for ${this.account.address}: `
        + describe(error),
        { account: this.account.name, cause: error },
      )
    }
    this.warm = { client, expiresAt: Date.now() + this.idleTtlMs }
    return client
  }

  /** Close and forget the warm connection. */
  private async drop(): Promise<void> {
    const warm = this.warm
    this.warm = undefined
    if (warm === undefined) return
    try {
      await warm.client.logout()
    } catch {
      try {
        warm.client.close()
      } catch {
        // Already gone; nothing to release.
      }
    }
  }

  /** Release the connection. Called when the plugin unloads. */
  async close(): Promise<void> {
    await this.drop()
  }

  /**
   * The mailboxes on the account, with unread counts.
   * @param options - whether a cached listing is acceptable.
   * @returns the mailboxes.
   */
  async mailboxes(options: { fresh?: boolean } = {}): Promise<MailboxInfo[]> {
    const cached = this.mailboxCache
    if (options.fresh !== true && cached !== undefined && cached.at + 60_000 > Date.now()) return cached.entries
    const entries = await this.withImap(async (client) => {
      const listed = await client.list({ statusQuery: { messages: true, unseen: true } })
      return listed.map((entry): MailboxInfo => ({
        path: entry.path,
        name: entry.name,
        ...entry.specialUse === undefined ? {} : { specialUse: entry.specialUse },
        ...entry.status?.messages === undefined ? {} : { total: entry.status.messages },
        ...entry.status?.unseen === undefined ? {} : { unread: entry.status.unseen },
      }))
    })
    this.mailboxCache = { entries, at: Date.now() }
    return entries
  }

  /**
   * Find the mailbox holding a role, e.g. Sent or Trash.
   * @param roles - acceptable special-use attributes.
   * @param fallbackNames - names to accept when the server declares no role.
   * @returns the mailbox path, or undefined.
   */
  private async mailboxForRole(
    roles: readonly string[],
    fallbackNames: readonly string[],
  ): Promise<string | undefined> {
    const boxes = await this.mailboxes()
    const byRole = boxes.find(box => box.specialUse !== undefined && roles.includes(box.specialUse))
    if (byRole !== undefined) return byRole.path
    const folded = fallbackNames.map(name => name.toLowerCase())
    return boxes.find(box => folded.includes(box.name.toLowerCase()))?.path
  }

  /**
   * Resolve a mailbox a person named, forgivingly.
   *
   * "inbox", "Inbox", "sent", "junk", and a full IMAP path all have to work,
   * because nobody knows their own folder delimiters.
   * @param name - the requested mailbox, or undefined for the inbox.
   * @returns the IMAP path.
   */
  async resolveMailbox(name: string | undefined): Promise<string> {
    if (name === undefined || name.trim() === '') return 'INBOX'
    const wanted = name.trim()
    if (wanted.toLowerCase() === 'inbox') return 'INBOX'
    const boxes = await this.mailboxes()
    const exact = boxes.find(box => box.path === wanted)
    if (exact !== undefined) return exact.path
    const folded = wanted.toLowerCase()
    const byName = boxes.find(box => box.name.toLowerCase() === folded)
      ?? boxes.find(box => box.path.toLowerCase() === folded)
      ?? boxes.find(box => box.specialUse?.toLowerCase() === `\\${folded}`)
      ?? boxes.find(box => box.name.toLowerCase().includes(folded))
    if (byName !== undefined) return byName.path
    throw new MailError(
      'mailbox-not-found',
      `${this.account.address} has no mailbox matching ${JSON.stringify(wanted)}. It has: `
      + `${boxes.map(box => box.name).join(', ')}`,
      { account: this.account.name },
    )
  }

  /**
   * Search a mailbox.
   *
   * Results come back newest first and capped, because a question about email is
   * nearly always about recent email.
   * @param query - what to look for.
   * @returns matching messages, without bodies.
   */
  async search(query: SearchQuery): Promise<MessageSummary[]> {
    const mailbox = await this.resolveMailbox(query.mailbox)
    const limit = Math.max(1, query.limit ?? 20)
    const criteria = buildSearchCriteria(query)
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const uids = await client.search(criteria, { uid: true })
        if (uids === false || uids.length === 0) return []
        // Highest UID is the most recently delivered.
        const newest = [...uids].sort((a, b) => b - a).slice(0, limit)
        const fetched = await client.fetchAll(newest, {
          uid: true,
          flags: true,
          envelope: true,
          size: true,
          bodyStructure: true,
        }, { uid: true })
        return fetched
          .map(message => toSummary(message, mailbox))
          .sort((a, b) => b.uid - a.uid)
      } finally {
        lock.release()
      }
    })
  }

  /**
   * Read one message in full.
   * @param uid - the message UID.
   * @param options - which mailbox it is in.
   * @returns the message with its body.
   */
  async read(uid: number, options: { mailbox?: string } = {}): Promise<MessageDetail> {
    const mailbox = await this.resolveMailbox(options.mailbox)
    const loaded = await internals.loadSdk()
    return this.withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const fetched = await client.fetchAll([uid], {
          uid: true,
          flags: true,
          envelope: true,
          size: true,
          bodyStructure: true,
          source: true,
        }, { uid: true })
        const message = fetched[0]
        if (message === undefined) {
          throw new MailError(
            'message-not-found',
            `no message with id ${uid} in ${mailbox}. It may have been moved or deleted since it was listed.`,
            { account: this.account.name },
          )
        }
        const summary = toSummary(message, mailbox)
        const parsed = message.source === undefined
          ? {}
          : await loaded.parseMessage(message.source)
        const chosen = chooseBody({
          ...parsed.text === undefined ? {} : { text: parsed.text },
          ...typeof parsed.html === 'string' ? { html: parsed.html } : {},
        })
        const clipped = clipBody(chosen, this.maxBodyChars)
        const envelope = message.envelope
        return {
          ...summary,
          body: clipped.body,
          truncated: clipped.truncated,
          attachments: (parsed.attachments ?? []).map(attachment => ({
            filename: attachment.filename ?? '(unnamed)',
            contentType: attachment.contentType ?? 'application/octet-stream',
            size: attachment.size ?? 0,
          })),
          replyTo: normaliseAddresses(envelope?.replyTo),
          ...envelope?.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo },
          references: [],
        } satisfies MessageDetail
      } finally {
        lock.release()
      }
    })
  }

  /**
   * Set or clear flags on a message.
   * @param uid - the message UID.
   * @param change - which flags to change.
   * @param options - which mailbox it is in.
   */
  async flag(uid: number, change: FlagChange, options: { mailbox?: string } = {}): Promise<void> {
    const mailbox = await this.resolveMailbox(options.mailbox)
    const add: string[] = []
    const remove: string[] = []
    for (const key of ['seen', 'flagged', 'answered'] as const) {
      const value = change[key]
      if (value === true) add.push(FLAG[key])
      else if (value === false) remove.push(FLAG[key])
    }
    if (add.length === 0 && remove.length === 0) return
    await this.withImap(async (client) => {
      const lock = await client.getMailboxLock(mailbox)
      try {
        if (add.length > 0) await client.messageFlagsAdd([uid], add, { uid: true })
        if (remove.length > 0) await client.messageFlagsRemove([uid], remove, { uid: true })
      } finally {
        lock.release()
      }
    })
    this.mailboxCache = undefined
  }

  /**
   * Move a message to another mailbox.
   * @param uid - the message UID.
   * @param destination - the target mailbox.
   * @param options - which mailbox it is in now.
   * @returns the destination path used.
   */
  async move(uid: number, destination: string, options: { mailbox?: string } = {}): Promise<string> {
    const from = await this.resolveMailbox(options.mailbox)
    const to = await this.resolveMailbox(destination)
    if (from === to) return to
    await this.withImap(async (client) => {
      const lock = await client.getMailboxLock(from)
      try {
        await client.messageMove([uid], to, { uid: true })
      } finally {
        lock.release()
      }
    })
    this.mailboxCache = undefined
    return to
  }

  /**
   * Move a message to Trash.
   *
   * Deliberately a move and not an expunge. A family member who says "delete
   * that" means "get it out of my inbox", and they can still find it in Trash if
   * they were wrong. Permanent deletion is left to the mail client.
   * @param uid - the message UID.
   * @param options - which mailbox it is in.
   * @returns where it went.
   */
  async trash(uid: number, options: { mailbox?: string } = {}): Promise<string> {
    const target = await this.mailboxForRole(TRASH_ROLES, ['Trash', 'Deleted', 'Deleted Items', 'Bin'])
    if (target === undefined) {
      // No Trash: fall back to the IMAP flag, which is what a client would do.
      const mailbox = await this.resolveMailbox(options.mailbox)
      await this.withImap(async (client) => {
        const lock = await client.getMailboxLock(mailbox)
        try {
          await client.messageFlagsAdd([uid], [FLAG.deleted], { uid: true })
        } finally {
          lock.release()
        }
      })
      return `${mailbox} (marked deleted; the account has no Trash mailbox)`
    }
    return this.move(uid, target, options)
  }

  /**
   * Send a message, and file a copy in Sent.
   *
   * The copy matters more than it looks: without it the family sees the butler's
   * replies nowhere, and a thread in their mail client is missing half its turns.
   * A failure to file is reported but does not fail the send — the mail has
   * already left.
   * @param message - what to send.
   * @returns what the server accepted.
   */
  async send(message: OutgoingMessage): Promise<SendResult> {
    const to = (message.to ?? []).map(parseAddress).filter(isPresent)
    const cc = (message.cc ?? []).map(parseAddress).filter(isPresent)
    const bcc = (message.bcc ?? []).map(parseAddress).filter(isPresent)
    if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
      throw new MailError('no-recipients', 'a message needs at least one recipient', { account: this.account.name })
    }
    const loaded = await internals.loadSdk()
    const password = await this.resolvePassword(this.account)
    const envelope: Record<string, unknown> = {
      from: formatAddress({ name: this.account.displayName, address: this.account.address }),
      subject: message.subject,
      text: normaliseWhitespace(message.body),
      ...to.length === 0 ? {} : { to: to.map(formatAddress) },
      ...cc.length === 0 ? {} : { cc: cc.map(formatAddress) },
      ...bcc.length === 0 ? {} : { bcc: bcc.map(formatAddress) },
      ...message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo },
      ...message.references === undefined || message.references.length === 0
        ? {}
        : { references: message.references },
    }
    const transport = loaded.createSmtpTransport({
      host: this.account.smtpHost,
      port: this.account.smtpPort,
      secure: this.account.smtpSecure,
      auth: { user: this.account.username, pass: password },
      connectionTimeout: this.timeoutMs,
      greetingTimeout: this.timeoutMs,
    })
    let info: Awaited<ReturnType<SmtpTransportLike['sendMail']>>
    try {
      info = await transport.sendMail(envelope)
    } catch (error) {
      if (isAuthFailure(error)) {
        throw new MailError(
          'auth-failed',
          `${this.account.smtpHost} rejected the login when sending. Check the app password in the credential `
          + `named ${JSON.stringify(this.account.passwordRef)}.`,
          { account: this.account.name, cause: error },
        )
      }
      throw new MailError(
        'send-failed',
        `the message to ${[...to, ...cc, ...bcc].map(a => a.address).join(', ')} was not sent: ${describe(error)}`,
        { account: this.account.name, cause: error },
      )
    } finally {
      transport.close?.()
    }

    let savedToSent = false
    try {
      const sentBox = await this.mailboxForRole(SENT_ROLES, ['Sent', 'Sent Items', 'Sent Messages'])
      if (sentBox !== undefined) {
        const raw = await loaded.buildMessage({ ...envelope, messageId: info.messageId })
        await this.withImap(client => client.append(sentBox, raw, [FLAG.seen], new Date()))
        savedToSent = true
      }
    } catch {
      // The mail is already gone. Not filing the copy is worth reporting, not failing.
    }

    return {
      messageId: info.messageId ?? '',
      accepted: (info.accepted ?? []).map(addressOf),
      rejected: (info.rejected ?? []).map(addressOf),
      savedToSent,
    }
  }

  /**
   * Check that the account is reachable and the password works.
   * @returns a one-line description of what was found.
   */
  async probe(): Promise<string> {
    const boxes = await this.mailboxes({ fresh: true })
    const inbox = boxes.find(box => box.path === 'INBOX')
    const unread = inbox?.unread
    return `${this.account.address}: connected, ${boxes.length} mailbox(es)`
      + `${unread === undefined ? '' : `, ${unread} unread in the inbox`}`
  }
}

/**
 * Translate a household's search into IMAP criteria.
 * @param query - the search.
 * @returns the criteria object.
 */
export function buildSearchCriteria(query: SearchQuery): Record<string, unknown> {
  const criteria: Record<string, unknown> = {}
  if (query.from !== undefined && query.from !== '') criteria.from = query.from
  if (query.to !== undefined && query.to !== '') criteria.to = query.to
  if (query.subject !== undefined && query.subject !== '') criteria.subject = query.subject
  if (query.text !== undefined && query.text !== '') criteria.text = query.text
  if (query.body !== undefined && query.body !== '') criteria.body = query.body
  if (query.seen !== undefined) criteria.seen = query.seen
  if (query.flagged !== undefined) criteria.flagged = query.flagged
  if (query.since !== undefined) criteria.since = query.since
  if (query.before !== undefined) criteria.before = query.before
  // An empty criteria set means "everything", which IMAP spells ALL.
  if (Object.keys(criteria).length === 0) criteria.all = true
  return criteria
}

/**
 * Project a fetched message onto the summary shape.
 * @param message - the fetched message.
 * @param mailbox - the mailbox it came from.
 * @returns the summary.
 */
export function toSummary(message: ImapFetchMessage, mailbox: string): MessageSummary {
  const envelope = message.envelope
  const flags = message.flags ?? new Set<string>()
  const subject = envelope?.subject?.trim()
  return {
    uid: message.uid,
    mailbox,
    subject: subject === undefined || subject === '' ? NO_SUBJECT : subject,
    from: normaliseAddresses(envelope?.from),
    to: normaliseAddresses(envelope?.to),
    cc: normaliseAddresses(envelope?.cc),
    ...envelope?.date === undefined ? {} : { date: new Date(envelope.date).toISOString() },
    ...envelope?.messageId === undefined ? {} : { messageId: envelope.messageId },
    seen: flags.has(FLAG.seen),
    flagged: flags.has(FLAG.flagged),
    answered: flags.has(FLAG.answered),
    hasAttachments: hasAttachment(message.bodyStructure),
    ...message.size === undefined ? {} : { size: message.size },
  }
}

/**
 * Whether a MIME tree carries something a person would call an attachment.
 * @param node - the body structure root.
 * @returns true when an attachment part is present.
 */
export function hasAttachment(node: ImapBodyStructure | undefined): boolean {
  if (node === undefined) return false
  const disposition = node.disposition?.toLowerCase()
  if (disposition === 'attachment') return true
  // An inline part with a filename is an attachment as far as anyone reading is concerned.
  if (disposition === 'inline' && node.dispositionParameters?.filename !== undefined) return true
  return (node.childNodes ?? []).some(hasAttachment)
}

/**
 * Read the address out of whatever nodemailer reported.
 * @param entry - an accepted or rejected entry.
 * @returns the address.
 */
function addressOf(entry: string | { address: string }): string {
  return typeof entry === 'string' ? entry : entry.address
}

/**
 * Type guard dropping undefined entries.
 * @param value - the value.
 * @returns whether it is present.
 */
function isPresent<T>(value: T | undefined): value is T {
  return value !== undefined
}

/**
 * Whether a thrown error is the server refusing the credentials.
 * @param error - the thrown value.
 * @returns true for an authentication failure.
 */
export function isAuthFailure(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const record = error as { authenticationFailed?: boolean; responseCode?: number; code?: string; message?: string }
  if (record.authenticationFailed === true) return true
  if (record.responseCode === 535 || record.responseCode === 534) return true
  if (record.code === 'EAUTH') return true
  const message = record.message?.toLowerCase() ?? ''
  return message.includes('invalid credentials')
    || message.includes('authentication failed')
    || message.includes('authenticationfailed')
}

/**
 * A short description of a thrown value.
 * @param error - the thrown value.
 * @returns the message.
 */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
