/**
 * Types and configuration for the mail seam.
 *
 * @module dsh-mail/types
 */

import z from '@deepseek-ai/schemastery'

/**
 * Well-known providers, so a household does not have to look up host names.
 *
 * Yahoo — and every provider here — requires an **app password** rather than the
 * account password once two-factor authentication is on. There is no way around
 * this from a program: the normal password will be refused at login.
 */
export const PRESETS = {
  yahoo: { imapHost: 'imap.mail.yahoo.com', imapPort: 993, smtpHost: 'smtp.mail.yahoo.com', smtpPort: 465 },
  gmail: { imapHost: 'imap.gmail.com', imapPort: 993, smtpHost: 'smtp.gmail.com', smtpPort: 465 },
  outlook: { imapHost: 'outlook.office365.com', imapPort: 993, smtpHost: 'smtp.office365.com', smtpPort: 587 },
  icloud: { imapHost: 'imap.mail.me.com', imapPort: 993, smtpHost: 'smtp.mail.me.com', smtpPort: 587 },
  fastmail: { imapHost: 'imap.fastmail.com', imapPort: 993, smtpHost: 'smtp.fastmail.com', smtpPort: 465 },
} as const

/** A configured provider preset. */
export type PresetName = keyof typeof PRESETS

/** One mailbox account the household can read and send from. */
export interface AccountConfig {
  /** The address mail is sent from and received at, e.g. `smiths@yahoo.com`. */
  address: string
  /** The name recipients see, e.g. `The Smith Family`. Defaults to the address. */
  displayName?: string
  /** Login username when it differs from the address. Yahoo uses the address. */
  username?: string
  /**
   * Name of the credential holding the **app password** — not the password
   * itself. Resolved through `ctx.credentials` at each connection.
   */
  passwordRef: string
  /** Fills in host names and ports for a well-known provider. */
  preset?: PresetName
  /** IMAP host, when not using a preset. */
  imapHost?: string
  /** IMAP port. Defaults to 993. */
  imapPort?: number
  /** Whether IMAP is TLS from the first byte. Defaults to true for port 993. */
  imapSecure?: boolean
  /** SMTP host, when not using a preset. */
  smtpHost?: string
  /** SMTP port. Defaults to 465. */
  smtpPort?: number
  /** Whether SMTP is TLS from the first byte. Defaults to true for port 465. */
  smtpSecure?: boolean
}

export const AccountConfig: z<AccountConfig> = z.object({
  address: z.string().required(),
  displayName: z.string(),
  username: z.string(),
  passwordRef: z.string().required(),
  preset: z.union(['yahoo', 'gmail', 'outlook', 'icloud', 'fastmail'] as const),
  imapHost: z.string(),
  imapPort: z.natural(),
  imapSecure: z.boolean(),
  smtpHost: z.string(),
  smtpPort: z.natural(),
  smtpSecure: z.boolean(),
})

/** Service configuration. */
export interface Config {
  /** Accounts by short name. Most households configure exactly one. */
  accounts: Record<string, AccountConfig>
  /** Which account to use when a call does not name one. */
  defaultAccount?: string
  /**
   * How long an idle IMAP connection is kept warm. A held connection makes the
   * second question of a conversation fast; letting it lapse means a rotated
   * password takes effect without a restart.
   */
  idleTtlMs?: number
  /** Connection timeout for IMAP and SMTP. */
  timeoutMs?: number
  /** Longest message body handed back before it is truncated. */
  maxBodyChars?: number
}

/** Default idle connection lifetime: five minutes. */
export const DEFAULT_IDLE_TTL_MS = 300_000
/** Default connection timeout. */
export const DEFAULT_TIMEOUT_MS = 20_000
/** Default body cap. Long enough for any real letter, short enough for a prompt. */
export const DEFAULT_MAX_BODY_CHARS = 8_000

export const Config: z<Config> = z.object({
  accounts: z.dict(AccountConfig).default({}),
  defaultAccount: z.string(),
  idleTtlMs: z.natural().default(DEFAULT_IDLE_TTL_MS),
  timeoutMs: z.natural().default(DEFAULT_TIMEOUT_MS),
  maxBodyChars: z.natural().default(DEFAULT_MAX_BODY_CHARS),
})

/** A resolved account, with every default filled in. */
export interface ResolvedAccount {
  /** Short name of the account. */
  readonly name: string
  /** The address mail comes from and goes to. */
  readonly address: string
  /** The display name recipients see. */
  readonly displayName: string
  /** Login username. */
  readonly username: string
  /** Credential name holding the app password. */
  readonly passwordRef: string
  /** IMAP host. */
  readonly imapHost: string
  /** IMAP port. */
  readonly imapPort: number
  /** Whether IMAP is implicit TLS. */
  readonly imapSecure: boolean
  /** SMTP host. */
  readonly smtpHost: string
  /** SMTP port. */
  readonly smtpPort: number
  /** Whether SMTP is implicit TLS. */
  readonly smtpSecure: boolean
}

/** One mailbox (IMAP folder). */
export interface MailboxInfo {
  /** Full IMAP path, the identifier every other call takes. */
  readonly path: string
  /** Leaf name as a person would read it. */
  readonly name: string
  /** RFC 6154 role, e.g. `\Inbox`, `\Sent`, `\Trash`, `\Junk`, when the server says. */
  readonly specialUse?: string
  /** Total messages, when the server reported it. */
  readonly total?: number
  /** Unread messages, when the server reported it. */
  readonly unread?: number
}

/** One participant on a message. */
export interface MailAddress {
  /** Display name, when the message carried one. */
  readonly name?: string
  /** Email address. */
  readonly address: string
}

/** A message as it appears in a list: everything but the body. */
export interface MessageSummary {
  /** IMAP UID — stable within the mailbox, and the handle every other call takes. */
  readonly uid: number
  /** The mailbox the UID belongs to. A UID means nothing without it. */
  readonly mailbox: string
  /** Subject line, or a stand-in when absent. */
  readonly subject: string
  /** Senders. */
  readonly from: MailAddress[]
  /** Primary recipients. */
  readonly to: MailAddress[]
  /** Copied recipients. */
  readonly cc: MailAddress[]
  /** When the sender says it was sent, as an ISO instant. */
  readonly date?: string
  /** RFC 5322 Message-ID, needed to thread a reply. */
  readonly messageId?: string
  /** Whether it has been read. */
  readonly seen: boolean
  /** Whether it is starred. */
  readonly flagged: boolean
  /** Whether it has been replied to. */
  readonly answered: boolean
  /** Whether it carries attachments. */
  readonly hasAttachments: boolean
  /** Size in bytes, when reported. */
  readonly size?: number
}

/** A message with its body, ready to be read. */
export interface MessageDetail extends MessageSummary {
  /** Plain-text body, decoded and normalised. */
  readonly body: string
  /** Whether the body was cut short at the configured cap. */
  readonly truncated: boolean
  /** Attachment names and sizes. The bytes are not fetched. */
  readonly attachments: { filename: string; contentType: string; size: number }[]
  /** `Reply-To`, when it differs from the sender. */
  readonly replyTo: MailAddress[]
  /** `In-Reply-To` header, for threading. */
  readonly inReplyTo?: string
  /** `References` header chain, for threading. */
  readonly references: string[]
}

/** What to search for. Fields combine with AND. */
export interface SearchQuery {
  /** Mailbox to search. Defaults to the inbox. */
  mailbox?: string
  /** Match the sender. */
  from?: string
  /** Match a recipient. */
  to?: string
  /** Match the subject line. */
  subject?: string
  /** Match anywhere in headers or body — the closest thing to a web search box. */
  text?: string
  /** Match within the body only. */
  body?: string
  /** Only unread, or only read. */
  seen?: boolean
  /** Only starred, or only unstarred. */
  flagged?: boolean
  /** On or after this date. */
  since?: Date
  /** Strictly before this date. */
  before?: Date
  /** Cap on results, newest first. */
  limit?: number
}

/** A message to send. */
export interface OutgoingMessage {
  /** Recipients. At least one of `to`, `cc`, `bcc` is required. */
  to?: (string | MailAddress)[]
  /** Copied recipients. */
  cc?: (string | MailAddress)[]
  /** Blind-copied recipients. */
  bcc?: (string | MailAddress)[]
  /** Subject line. */
  subject: string
  /** Plain-text body. */
  body: string
  /** Account to send from. */
  account?: string
  /** `In-Reply-To`, set by {@link MailService.reply}. */
  inReplyTo?: string
  /** `References` chain, set by {@link MailService.reply}. */
  references?: string[]
}

/** The outcome of a send. */
export interface SendResult {
  /** The Message-ID the server assigned. */
  readonly messageId: string
  /** Recipients the server accepted. */
  readonly accepted: string[]
  /** Recipients the server refused. */
  readonly rejected: string[]
  /** Whether a copy was filed in the Sent mailbox. */
  readonly savedToSent: boolean
}

/** Flags that can be set or cleared on a message. */
export interface FlagChange {
  /** Mark read (true) or unread (false). */
  seen?: boolean
  /** Star (true) or unstar (false). */
  flagged?: boolean
  /** Mark as answered. */
  answered?: boolean
}

/** Why a mail operation failed. */
export type MailErrorCode =
  | 'account-not-found'
  | 'no-accounts-configured'
  | 'invalid-password-ref'
  | 'credential-unconfigured'
  | 'sdk-missing'
  | 'connect-failed'
  | 'auth-failed'
  | 'mailbox-not-found'
  | 'message-not-found'
  | 'no-recipients'
  | 'send-failed'
  | 'request-failed'

/** A mail failure with a code a tool can turn into an explanation. */
export class MailError extends Error {
  /** Machine-readable cause. */
  readonly code: MailErrorCode
  /** Account the failure relates to, when known. */
  readonly account?: string

  /**
   * @param code - machine-readable cause.
   * @param message - human-readable explanation.
   * @param options - the account involved and the underlying error.
   */
  constructor(code: MailErrorCode, message: string, options: { account?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MailError'
    this.code = code
    if (options.account !== undefined) this.account = options.account
  }
}

/**
 * Fill in every default for one configured account.
 * @param name - short name of the account.
 * @param config - the configured account.
 * @returns the resolved account.
 */
export function resolveAccount(name: string, config: AccountConfig): ResolvedAccount {
  const preset = config.preset === undefined ? undefined : PRESETS[config.preset]
  const imapHost = config.imapHost ?? preset?.imapHost
  const smtpHost = config.smtpHost ?? preset?.smtpHost
  if (imapHost === undefined || smtpHost === undefined) {
    throw new MailError(
      'account-not-found',
      `mail account ${JSON.stringify(name)} needs either a preset (yahoo, gmail, outlook, icloud, fastmail) `
      + 'or explicit imapHost and smtpHost',
      { account: name },
    )
  }
  const imapPort = config.imapPort ?? preset?.imapPort ?? 993
  const smtpPort = config.smtpPort ?? preset?.smtpPort ?? 465
  return {
    name,
    address: config.address,
    displayName: config.displayName ?? config.address,
    username: config.username ?? config.address,
    passwordRef: config.passwordRef,
    imapHost,
    imapPort,
    // Port 993 is implicit TLS; 143 is STARTTLS. Same story for 465 vs 587.
    imapSecure: config.imapSecure ?? imapPort === 993,
    smtpHost,
    smtpPort,
    smtpSecure: config.smtpSecure ?? smtpPort === 465,
  }
}
