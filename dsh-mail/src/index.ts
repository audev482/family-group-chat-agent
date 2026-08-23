/**
 * dsh-mail — the family mailbox as a harness service.
 *
 * Registers `ctx.mail`: search, read, send, reply, forward, flag, move, and
 * trash over plain IMAP and SMTP. Yahoo is a preset, but nothing here is
 * Yahoo-specific; the same seam serves any IMAP provider.
 *
 * This package is the transport half of the mail capability and knows nothing
 * about families. The meaning — "email Grandma", "did the school write back" —
 * lives in `dsh-mail-tools`, which is what the model actually sees. Splitting
 * them means the briefing can count unread mail without mounting six tools, and
 * a different channel could reuse the mailbox without inheriting the phrasing.
 *
 * @module dsh-mail
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  Config,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_TIMEOUT_MS,
  MailError,
  resolveAccount,
} from './types.ts'
import type {
  FlagChange,
  MailAddress,
  MailboxInfo,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  ResolvedAccount,
  SearchQuery,
  SendResult,
} from './types.ts'
import { MailTransport } from './imap.ts'
import {
  forwardSubject,
  quoteBody,
  replyRecipients,
  replyReferences,
  replySubject,
} from './message.ts'

export {
  AccountConfig,
  Config,
  DEFAULT_IDLE_TTL_MS,
  DEFAULT_MAX_BODY_CHARS,
  DEFAULT_TIMEOUT_MS,
  MailError,
  PRESETS,
  resolveAccount,
} from './types.ts'
export type {
  FlagChange,
  MailAddress,
  MailboxInfo,
  MailErrorCode,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  PresetName,
  ResolvedAccount,
  SearchQuery,
  SendResult,
} from './types.ts'
export {
  chooseBody,
  clipBody,
  formatAddress,
  formatAddresses,
  forwardSubject,
  htmlToText,
  messageLine,
  NO_SUBJECT,
  normaliseAddresses,
  normaliseWhitespace,
  parseAddress,
  quoteBody,
  replyRecipients,
  replyReferences,
  replySubject,
} from './message.ts'
export type { ClippedBody } from './message.ts'
export {
  buildSearchCriteria,
  hasAttachment,
  internals as mailInternals,
  isAuthFailure,
  MailTransport,
  toSummary,
} from './imap.ts'
export type {
  ImapClientLike,
  ImapFetchMessage,
  MailSdk,
  ParsedMailLike,
  SmtpTransportLike,
} from './imap.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The family mailbox: search, read, and send over IMAP and SMTP. */
    mail: Mail
  }

  interface Events {
    /** Emitted after every mail operation, for logging without leaking content. */
    'mail/request'(event: MailRequestEvent): void
  }
}

/** One completed mail operation. Carries no subjects, addresses, or bodies. */
export interface MailRequestEvent {
  /** Account short name. */
  readonly account: string
  /** Which operation ran. */
  readonly operation: 'mailboxes' | 'search' | 'read' | 'send' | 'flag' | 'move' | 'trash' | 'probe'
  /** How long it took. */
  readonly durationMs: number
  /** Whether it succeeded. */
  readonly ok: boolean
}

/**
 * The mail service.
 *
 * Credentials are resolved per connection rather than held, so rotating the app
 * password takes effect without restarting the harness.
 */
export class Mail extends Service {
  static inject = ['credentials']
  static Config = Config

  private readonly accounts: Map<string, ResolvedAccount> = new Map()
  private readonly transports: Map<string, MailTransport> = new Map()
  private readonly defaultAccount: string | undefined

  /**
   * @param ctx - Plugin context.
   * @param config - Validated configuration.
   */
  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'mail')

    for (const [name, account] of Object.entries(config.accounts ?? {})) {
      // Fail at load, not at the first question, when a host cannot be worked out.
      this.accounts.set(name, resolveAccount(name, account))
    }

    const names = [...this.accounts.keys()]
    if (config.defaultAccount !== undefined && !this.accounts.has(config.defaultAccount)) {
      throw new Error(
        `mail defaultAccount ${JSON.stringify(config.defaultAccount)} is not a configured account. `
        + `Configured: ${names.length === 0 ? '(none)' : names.join(', ')}`,
      )
    }
    this.defaultAccount = config.defaultAccount ?? (names.length === 1 ? names[0] : undefined)

    ctx.effect(() => async () => {
      await Promise.all([...this.transports.values()].map(transport => transport.close()))
      this.transports.clear()
    })
  }

  /** The configured account names. */
  list(): string[] {
    return [...this.accounts.keys()]
  }

  /**
   * The address a named account sends from.
   * @param name - account name, or undefined for the default.
   * @returns the account.
   */
  account(name?: string): ResolvedAccount {
    return this.resolve(name)
  }

  /**
   * Pick the account a call refers to.
   * @param name - the requested account, or undefined.
   * @returns the resolved account.
   */
  private resolve(name: string | undefined): ResolvedAccount {
    if (this.accounts.size === 0) {
      throw new MailError(
        'no-accounts-configured',
        'no mail account is configured. Add one to the dsh-mail config with an address and a passwordRef.',
      )
    }
    if (name === undefined || name === '') {
      const fallback = this.defaultAccount
      if (fallback === undefined) {
        throw new MailError(
          'account-not-found',
          `more than one mail account is configured (${this.list().join(', ')}) and none is the default. `
          + 'Name the account, or set defaultAccount.',
        )
      }
      return this.accounts.get(fallback)!
    }
    const found = this.accounts.get(name)
      // A person will say the address, not the short name.
      ?? [...this.accounts.values()].find(account => account.address.toLowerCase() === name.toLowerCase())
    if (found === undefined) {
      throw new MailError(
        'account-not-found',
        `no mail account named ${JSON.stringify(name)}. Configured: ${this.list().join(', ')}`,
      )
    }
    return found
  }

  /**
   * The transport for an account, built on first use.
   * @param account - the resolved account.
   * @returns the transport.
   */
  private transport(account: ResolvedAccount): MailTransport {
    const existing = this.transports.get(account.name)
    if (existing !== undefined) return existing
    const created = new MailTransport(account, {
      resolvePassword: target => this.password(target),
      idleTtlMs: this.config.idleTtlMs ?? DEFAULT_IDLE_TTL_MS,
      timeoutMs: this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBodyChars: this.config.maxBodyChars ?? DEFAULT_MAX_BODY_CHARS,
    })
    this.transports.set(account.name, created)
    return created
  }

  /**
   * Resolve the app password for an account.
   * @param account - the account.
   * @returns the password.
   */
  private async password(account: ResolvedAccount): Promise<string> {
    let ref
    try {
      ref = credentialRef(account.passwordRef)
    } catch (error) {
      throw new MailError(
        'invalid-password-ref',
        `mail account ${account.name} has an unusable passwordRef ${JSON.stringify(account.passwordRef)}. `
        + 'It must name a credential, not contain the password itself.',
        { account: account.name, cause: error },
      )
    }
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined || resolved.value === '') {
      throw new MailError(
        'credential-unconfigured',
        `the credential ${JSON.stringify(account.passwordRef)} for ${account.address} is not set. `
        + 'Generate an app password with your mail provider and expose it under that name.',
        { account: account.name },
      )
    }
    return resolved.value
  }

  /**
   * Run an operation, timing it and reporting the outcome without content.
   * @param account - the account involved.
   * @param operation - which operation.
   * @param work - the operation.
   * @returns the operation result.
   */
  private async observe<T>(
    account: ResolvedAccount,
    operation: MailRequestEvent['operation'],
    work: () => Promise<T>,
  ): Promise<T> {
    const started = Date.now()
    try {
      const result = await work()
      this.ctx.emit('mail/request', {
        account: account.name,
        operation,
        durationMs: Date.now() - started,
        ok: true,
      })
      return result
    } catch (error) {
      this.ctx.emit('mail/request', {
        account: account.name,
        operation,
        durationMs: Date.now() - started,
        ok: false,
      })
      throw error
    }
  }

  /**
   * The mailboxes on an account.
   * @param options - account, and whether to bypass the short cache.
   * @returns the mailboxes.
   */
  async mailboxes(options: { account?: string; fresh?: boolean } = {}): Promise<MailboxInfo[]> {
    const account = this.resolve(options.account)
    return this.observe(account, 'mailboxes', () =>
      this.transport(account).mailboxes(options.fresh === undefined ? {} : { fresh: options.fresh }))
  }

  /**
   * Search for messages.
   * @param query - what to look for.
   * @param options - which account.
   * @returns matching messages, newest first, without bodies.
   */
  async search(query: SearchQuery = {}, options: { account?: string } = {}): Promise<MessageSummary[]> {
    const account = this.resolve(options.account)
    return this.observe(account, 'search', () => this.transport(account).search(query))
  }

  /**
   * Read one message in full.
   * @param uid - the message id from a search.
   * @param options - which mailbox and account.
   * @returns the message with its body.
   */
  async read(uid: number, options: { mailbox?: string; account?: string } = {}): Promise<MessageDetail> {
    const account = this.resolve(options.account)
    return this.observe(account, 'read', () =>
      this.transport(account).read(uid, options.mailbox === undefined ? {} : { mailbox: options.mailbox }))
  }

  /**
   * Send a message.
   * @param message - what to send.
   * @returns what the server accepted.
   */
  async send(message: OutgoingMessage): Promise<SendResult> {
    const account = this.resolve(message.account)
    return this.observe(account, 'send', () => this.transport(account).send(message))
  }

  /**
   * Reply to a message, threaded so the recipient's mail client groups it.
   *
   * Threading is done here rather than left to the caller because getting
   * `In-Reply-To` and `References` right is fiddly and getting it wrong produces
   * a reply that looks like a new conversation.
   * @param uid - the message being answered.
   * @param body - what to say.
   * @param options - mailbox, account, whether to reply to everyone, and whether to quote.
   * @returns what the server accepted.
   */
  async reply(uid: number, body: string, options: {
    mailbox?: string
    account?: string
    replyAll?: boolean
    quote?: boolean
  } = {}): Promise<SendResult> {
    const account = this.resolve(options.account)
    const original = await this.read(uid, {
      ...options.mailbox === undefined ? {} : { mailbox: options.mailbox },
      account: account.name,
    })
    const to = replyRecipients(original)
    const cc = options.replyAll === true
      ? [...original.to, ...original.cc].filter(entry =>
          entry.address.toLowerCase() !== account.address.toLowerCase()
          && !to.some(target => target.address.toLowerCase() === entry.address.toLowerCase()))
      : []
    const text = options.quote === false ? body : `${body}${quoteBody(original, original.body)}`
    const result = await this.send({
      to,
      ...cc.length === 0 ? {} : { cc },
      subject: replySubject(original.subject),
      body: text,
      account: account.name,
      ...original.messageId === undefined ? {} : { inReplyTo: original.messageId },
      references: replyReferences(original),
    })
    // Mark answered so the family's mail client shows the thread as handled.
    await this.flag(uid, { answered: true }, {
      ...options.mailbox === undefined ? {} : { mailbox: options.mailbox },
      account: account.name,
    }).catch(() => undefined)
    return result
  }

  /**
   * Forward a message.
   * @param uid - the message to forward.
   * @param to - the new recipients.
   * @param options - mailbox, account, and an optional note above the quoted mail.
   * @returns what the server accepted.
   */
  async forward(uid: number, to: (string | MailAddress)[], options: {
    mailbox?: string
    account?: string
    note?: string
  } = {}): Promise<SendResult> {
    const account = this.resolve(options.account)
    const original = await this.read(uid, {
      ...options.mailbox === undefined ? {} : { mailbox: options.mailbox },
      account: account.name,
    })
    const header = [
      '--- Forwarded message ---',
      `From: ${original.from.map(entry => entry.address).join(', ')}`,
      original.date === undefined ? undefined : `Date: ${original.date}`,
      `Subject: ${original.subject}`,
      `To: ${original.to.map(entry => entry.address).join(', ')}`,
    ].filter(line => line !== undefined).join('\n')
    const note = options.note === undefined || options.note === '' ? '' : `${options.note}\n\n`
    return this.send({
      to,
      subject: forwardSubject(original.subject),
      body: `${note}${header}\n\n${original.body}`,
      account: account.name,
    })
  }

  /**
   * Set or clear flags on a message.
   * @param uid - the message id.
   * @param change - which flags to change.
   * @param options - mailbox and account.
   */
  async flag(uid: number, change: FlagChange, options: { mailbox?: string; account?: string } = {}): Promise<void> {
    const account = this.resolve(options.account)
    await this.observe(account, 'flag', () =>
      this.transport(account).flag(uid, change, options.mailbox === undefined ? {} : { mailbox: options.mailbox }))
  }

  /**
   * Move a message to another mailbox.
   * @param uid - the message id.
   * @param destination - the target mailbox.
   * @param options - current mailbox and account.
   * @returns the destination path used.
   */
  async move(uid: number, destination: string, options: {
    mailbox?: string
    account?: string
  } = {}): Promise<string> {
    const account = this.resolve(options.account)
    return this.observe(account, 'move', () =>
      this.transport(account).move(uid, destination, options.mailbox === undefined
        ? {}
        : { mailbox: options.mailbox }))
  }

  /**
   * Move a message to Trash. Recoverable by design.
   * @param uid - the message id.
   * @param options - current mailbox and account.
   * @returns where it went.
   */
  async trash(uid: number, options: { mailbox?: string; account?: string } = {}): Promise<string> {
    const account = this.resolve(options.account)
    return this.observe(account, 'trash', () =>
      this.transport(account).trash(uid, options.mailbox === undefined ? {} : { mailbox: options.mailbox }))
  }

  /**
   * Check an account is reachable and its password works.
   * @param options - which account.
   * @returns a one-line description.
   */
  async probe(options: { account?: string } = {}): Promise<string> {
    const account = this.resolve(options.account)
    return this.observe(account, 'probe', () => this.transport(account).probe())
  }
}

export default Mail
