/**
 * The IMAP and SMTP transport, against a fake mail server.
 *
 * `internals.loadSdk` is substituted, so no socket is opened. The assertions
 * concentrate on the things that would fail quietly against real Yahoo:
 *
 * - every message operation addresses by UID, not sequence number;
 * - a rejected password is reported as an app-password problem rather than as a
 *   generic failure, and is not retried into an account lockout;
 * - the warm connection is reused, dropped when the server closes it, and
 *   re-resolves the password when it reconnects;
 * - "delete" is a move to Trash.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildSearchCriteria,
  hasAttachment,
  isAuthFailure,
  MailTransport,
  mailInternals,
  resolveAccount,
} from '../src/index.ts'
import type { ImapClientLike, ImapFetchMessage, MailSdk } from '../src/index.ts'

const ACCOUNT = resolveAccount('family', {
  address: 'family@yahoo.com',
  displayName: 'The Bakers',
  passwordRef: 'YAHOO_APP_PASSWORD',
  preset: 'yahoo',
})

const RAW_MESSAGE = [
  'From: Kit\'s School <office@school.example>',
  'To: family@yahoo.com',
  'Subject: Parents evening',
  'Date: Fri, 21 Aug 2026 09:15:00 +0000',
  'Message-ID: <abc@school.example>',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Parents evening is on Thursday at 18:00.',
  'Please bring the form.',
].join('\r\n')

/** What the fake server was asked to do. */
interface Recorded {
  connects: number
  logouts: number
  passwords: string[]
  searches: { criteria: Record<string, unknown>; uid?: boolean }[]
  fetches: { range: string | number[]; uid?: boolean }[]
  flagsAdded: { range: string | number[]; flags: string[]; uid?: boolean }[]
  flagsRemoved: { range: string | number[]; flags: string[]; uid?: boolean }[]
  moves: { range: string | number[]; destination: string; uid?: boolean }[]
  appends: { path: string; flags?: string[] }[]
  sent: Record<string, unknown>[]
  locks: string[]
}

/** Build a fake mail server. */
function fakeMail(options: {
  mailboxes?: { path: string; name: string; specialUse?: string; status?: { messages?: number; unseen?: number } }[]
  uids?: number[]
  messages?: ImapFetchMessage[]
  failConnectWith?: Error
  failSearchOnce?: Error
  sendResult?: { messageId?: string; accepted?: string[]; rejected?: string[] }
  failSendWith?: Error
} = {}): { sdk: MailSdk; recorded: Recorded; state: { password: string } } {
  const recorded: Recorded = {
    connects: 0,
    logouts: 0,
    passwords: [],
    searches: [],
    fetches: [],
    flagsAdded: [],
    flagsRemoved: [],
    moves: [],
    appends: [],
    sent: [],
    locks: [],
  }
  const state = { password: 'app-password-1' }
  const mailboxes = options.mailboxes ?? [
    { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', status: { messages: 12, unseen: 3 } },
    { path: 'Sent', name: 'Sent', specialUse: '\\Sent', status: { messages: 40, unseen: 0 } },
    { path: 'Trash', name: 'Trash', specialUse: '\\Trash', status: { messages: 5, unseen: 0 } },
    { path: 'Archive/School', name: 'School', status: { messages: 8, unseen: 1 } },
  ]
  let searchFailuresLeft = options.failSearchOnce === undefined ? 0 : 1

  const sdk: MailSdk = {
    createImapClient(clientOptions) {
      const auth = clientOptions.auth as { pass: string }
      recorded.passwords.push(auth.pass)
      const client: ImapClientLike = {
        usable: false,
        async connect() {
          recorded.connects += 1
          if (options.failConnectWith !== undefined) throw options.failConnectWith
          client.usable = true
        },
        async logout() {
          recorded.logouts += 1
          client.usable = false
        },
        close() {
          client.usable = false
        },
        on() {
          return client
        },
        async list() {
          return mailboxes
        },
        async getMailboxLock(path) {
          recorded.locks.push(path)
          return { path, release: () => undefined }
        },
        async search(criteria, searchOptions) {
          if (searchFailuresLeft > 0) {
            searchFailuresLeft -= 1
            client.usable = false
            throw options.failSearchOnce
          }
          recorded.searches.push({ criteria, ...searchOptions })
          return options.uids ?? [101, 102, 103]
        },
        async fetchAll(range, _query, fetchOptions) {
          recorded.fetches.push({ range, ...fetchOptions })
          const wanted = Array.isArray(range) ? range : []
          const all = options.messages ?? []
          return wanted.length === 0 ? all : all.filter(message => wanted.includes(message.uid))
        },
        async messageFlagsAdd(range, flags, flagOptions) {
          recorded.flagsAdded.push({ range, flags, ...flagOptions })
          return true
        },
        async messageFlagsRemove(range, flags, flagOptions) {
          recorded.flagsRemoved.push({ range, flags, ...flagOptions })
          return true
        },
        async messageMove(range, destination, moveOptions) {
          recorded.moves.push({ range, destination, ...moveOptions })
          return {}
        },
        async append(path, _content, flags) {
          recorded.appends.push({ path, ...flags === undefined ? {} : { flags } })
          return {}
        },
      }
      return client
    },
    createSmtpTransport() {
      return {
        async sendMail(message) {
          if (options.failSendWith !== undefined) throw options.failSendWith
          recorded.sent.push(message)
          return options.sendResult ?? {
            messageId: '<sent-1@yahoo.com>',
            accepted: ['office@school.example'],
            rejected: [],
          }
        },
        close() {
          // Nothing to release.
        },
      }
    },
    async parseMessage(source) {
      const text = typeof source === 'string' ? source : Buffer.from(source).toString('utf8')
      const body = text.split('\r\n\r\n').slice(1).join('\r\n\r\n')
      return { text: body, attachments: [] }
    },
    async buildMessage() {
      return RAW_MESSAGE
    },
  }
  return { sdk, recorded, state }
}

/** A message the fake server can return. */
function fetched(overrides: Partial<ImapFetchMessage> = {}): ImapFetchMessage {
  return {
    uid: 101,
    seq: 1,
    size: 2048,
    flags: new Set<string>(),
    envelope: {
      date: new Date('2026-08-21T09:15:00.000Z'),
      subject: 'Parents evening',
      messageId: '<abc@school.example>',
      from: [{ name: 'Kit\'s School', address: 'office@school.example' }],
      to: [{ address: 'family@yahoo.com' }],
    },
    source: Buffer.from(RAW_MESSAGE, 'utf8'),
    ...overrides,
  }
}

/** Build a transport wired to a fake server. */
function build(options: Parameters<typeof fakeMail>[0] = {}) {
  const fake = fakeMail(options)
  vi.spyOn(mailInternals, 'loadSdk').mockResolvedValue(fake.sdk)
  const transport = new MailTransport(ACCOUNT, {
    resolvePassword: async () => fake.state.password,
    idleTtlMs: 300_000,
    timeoutMs: 5_000,
    maxBodyChars: 200,
  })
  return { transport, ...fake }
}

describe('resolveAccount', () => {
  it('fills in Yahoo\'s hosts from the preset', () => {
    expect(ACCOUNT.imapHost).toBe('imap.mail.yahoo.com')
    expect(ACCOUNT.imapPort).toBe(993)
    expect(ACCOUNT.smtpHost).toBe('smtp.mail.yahoo.com')
    expect(ACCOUNT.smtpPort).toBe(465)
  })

  it('treats 993 and 465 as implicit TLS', () => {
    expect(ACCOUNT.imapSecure).toBe(true)
    expect(ACCOUNT.smtpSecure).toBe(true)
  })

  it('treats 587 as STARTTLS rather than implicit TLS', () => {
    const account = resolveAccount('work', {
      address: 'a@example.com',
      passwordRef: 'REF',
      imapHost: 'imap.example.com',
      smtpHost: 'smtp.example.com',
      smtpPort: 587,
    })
    expect(account.smtpSecure).toBe(false)
  })

  it('defaults the login name and display name to the address', () => {
    const account = resolveAccount('a', { address: 'a@example.com', passwordRef: 'REF', preset: 'yahoo' })
    expect(account.username).toBe('a@example.com')
    expect(account.displayName).toBe('a@example.com')
  })

  it('refuses an account with neither a preset nor host names', () => {
    expect(() => resolveAccount('broken', { address: 'a@example.com', passwordRef: 'REF' }))
      .toThrow(/preset/)
  })
})

describe('mailboxes', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports paths, roles, and unread counts', async () => {
    const { transport } = build()
    const boxes = await transport.mailboxes()
    expect(boxes[0]).toMatchObject({ path: 'INBOX', specialUse: '\\Inbox', unread: 3, total: 12 })
  })

  it('caches briefly, so a follow-up question does not re-list', async () => {
    const { transport, recorded } = build()
    await transport.mailboxes()
    await transport.mailboxes()
    expect(recorded.connects).toBe(1)
  })

  it('re-lists when asked for fresh data', async () => {
    const { transport } = build()
    await transport.mailboxes()
    const boxes = await transport.mailboxes({ fresh: true })
    expect(boxes).toHaveLength(4)
  })
})

describe('resolveMailbox', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults to the inbox', async () => {
    const { transport } = build()
    expect(await transport.resolveMailbox(undefined)).toBe('INBOX')
    expect(await transport.resolveMailbox('')).toBe('INBOX')
  })

  it('accepts the inbox by any capitalisation', async () => {
    const { transport } = build()
    expect(await transport.resolveMailbox('inbox')).toBe('INBOX')
  })

  it('accepts a full path', async () => {
    const { transport } = build()
    expect(await transport.resolveMailbox('Archive/School')).toBe('Archive/School')
  })

  it('accepts a leaf name, since nobody knows their own folder delimiters', async () => {
    const { transport } = build()
    expect(await transport.resolveMailbox('School')).toBe('Archive/School')
  })

  it('accepts a role name', async () => {
    const { transport } = build()
    expect(await transport.resolveMailbox('trash')).toBe('Trash')
  })

  it('names the folders it does have when one is not found', async () => {
    const { transport } = build()
    await expect(transport.resolveMailbox('Nonsense')).rejects.toThrow(/INBOX|Sent|Trash/)
  })
})

describe('search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('addresses by UID, never by sequence number', async () => {
    const { transport, recorded } = build({ messages: [fetched()] })
    await transport.search({})
    expect(recorded.searches[0]?.uid).toBe(true)
    expect(recorded.fetches[0]?.uid).toBe(true)
  })

  it('returns newest first and caps the result count', async () => {
    const { transport } = build({
      uids: [101, 102, 103, 104],
      messages: [fetched({ uid: 101 }), fetched({ uid: 102 }), fetched({ uid: 103 }), fetched({ uid: 104 })],
    })
    const found = await transport.search({ limit: 2 })
    expect(found.map(entry => entry.uid)).toEqual([104, 103])
  })

  it('returns nothing when the server matches nothing', async () => {
    const { transport } = build({ uids: [] })
    expect(await transport.search({})).toEqual([])
  })

  it('reads flags into the states a person thinks in', async () => {
    const { transport } = build({
      uids: [101],
      messages: [fetched({ flags: new Set(['\\Seen', '\\Flagged', '\\Answered']) })],
    })
    const [message] = await transport.search({})
    expect(message).toMatchObject({ seen: true, flagged: true, answered: true })
  })

  it('reports the mailbox alongside the UID, which means nothing without it', async () => {
    const { transport } = build({ uids: [101], messages: [fetched()] })
    const [message] = await transport.search({ mailbox: 'School' })
    expect(message?.mailbox).toBe('Archive/School')
  })
})

describe('read', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the decoded body', async () => {
    const { transport } = build({ messages: [fetched()] })
    const message = await transport.read(101)
    expect(message.body).toContain('Parents evening is on Thursday')
  })

  it('clips a long body and says it did', async () => {
    const long = `${'Header: x\r\n'}\r\n${'word '.repeat(500)}`
    const { transport } = build({ messages: [fetched({ source: Buffer.from(long, 'utf8') })] })
    const message = await transport.read(101)
    expect(message.truncated).toBe(true)
    expect(message.body.length).toBeLessThanOrEqual(200)
  })

  it('says which message is missing rather than returning nothing', async () => {
    const { transport } = build({ messages: [] })
    await expect(transport.read(999)).rejects.toThrow(/999/)
  })
})

describe('flag', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('adds the flags for true and removes them for false', async () => {
    const { transport, recorded } = build()
    await transport.flag(101, { seen: true, flagged: false })
    expect(recorded.flagsAdded[0]).toMatchObject({ range: [101], flags: ['\\Seen'], uid: true })
    expect(recorded.flagsRemoved[0]).toMatchObject({ range: [101], flags: ['\\Flagged'], uid: true })
  })

  it('does nothing when asked to change nothing', async () => {
    const { transport, recorded } = build()
    await transport.flag(101, {})
    expect(recorded.flagsAdded).toHaveLength(0)
    expect(recorded.flagsRemoved).toHaveLength(0)
  })
})

describe('move and trash', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('moves by UID to the resolved destination', async () => {
    const { transport, recorded } = build()
    expect(await transport.move(101, 'School')).toBe('Archive/School')
    expect(recorded.moves[0]).toMatchObject({ range: [101], destination: 'Archive/School', uid: true })
  })

  it('does nothing when the destination is where the message already is', async () => {
    const { transport, recorded } = build()
    expect(await transport.move(101, 'INBOX', { mailbox: 'INBOX' })).toBe('INBOX')
    expect(recorded.moves).toHaveLength(0)
  })

  it('trashes by moving, so the family can still recover it', async () => {
    const { transport, recorded } = build()
    expect(await transport.trash(101)).toBe('Trash')
    expect(recorded.moves[0]?.destination).toBe('Trash')
  })

  it('falls back to the Deleted flag when the account has no Trash folder', async () => {
    const { transport, recorded } = build({
      mailboxes: [{ path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox' }],
    })
    const where = await transport.trash(101)
    expect(where).toContain('no Trash')
    expect(recorded.flagsAdded[0]?.flags).toEqual(['\\Deleted'])
  })
})

describe('send', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('sends from the configured address with the display name', async () => {
    const { transport, recorded } = build()
    await transport.send({ to: ['office@school.example'], subject: 'Hello', body: 'Text' })
    expect(recorded.sent[0]?.from).toBe('The Bakers <family@yahoo.com>')
  })

  it('files a copy in Sent, marked read', async () => {
    const { transport, recorded } = build()
    const result = await transport.send({ to: ['a@x.com'], subject: 'Hello', body: 'Text' })
    expect(result.savedToSent).toBe(true)
    expect(recorded.appends[0]).toMatchObject({ path: 'Sent', flags: ['\\Seen'] })
  })

  it('reports which recipients the server accepted and refused', async () => {
    const { transport } = build({
      sendResult: { messageId: '<m@x>', accepted: ['a@x.com'], rejected: ['bad@x.com'] },
    })
    const result = await transport.send({ to: ['a@x.com', 'bad@x.com'], subject: 'Hi', body: 'Text' })
    expect(result.accepted).toEqual(['a@x.com'])
    expect(result.rejected).toEqual(['bad@x.com'])
  })

  it('refuses a message with no recipient', async () => {
    const { transport } = build()
    await expect(transport.send({ to: [], subject: 'Hi', body: 'Text' }))
      .rejects.toMatchObject({ code: 'no-recipients' })
  })

  it('drops a recipient that names nobody rather than sending to a garbage address', async () => {
    const { transport } = build()
    await expect(transport.send({ to: ['Kit <>'], subject: 'Hi', body: 'Text' }))
      .rejects.toMatchObject({ code: 'no-recipients' })
  })

  it('passes threading headers through for a reply', async () => {
    const { transport, recorded } = build()
    await transport.send({
      to: ['a@x.com'],
      subject: 'Re: Hi',
      body: 'Text',
      inReplyTo: '<abc@school.example>',
      references: ['<abc@school.example>'],
    })
    expect(recorded.sent[0]?.inReplyTo).toBe('<abc@school.example>')
    expect(recorded.sent[0]?.references).toEqual(['<abc@school.example>'])
  })

  it('reports a send failure with the recipients that did not get it', async () => {
    const { transport } = build({ failSendWith: new Error('connection reset') })
    await expect(transport.send({ to: ['a@x.com'], subject: 'Hi', body: 'Text' }))
      .rejects.toMatchObject({ code: 'send-failed' })
  })

  it('explains an SMTP auth failure as an app-password problem', async () => {
    const failure = Object.assign(new Error('Invalid credentials'), { code: 'EAUTH' })
    const { transport } = build({ failSendWith: failure })
    await expect(transport.send({ to: ['a@x.com'], subject: 'Hi', body: 'Text' }))
      .rejects.toMatchObject({ code: 'auth-failed' })
  })
})

describe('connection handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reuses a warm connection between operations', async () => {
    const { transport, recorded } = build({ messages: [fetched()] })
    await transport.search({})
    await transport.search({})
    expect(recorded.connects).toBe(1)
  })

  it('reconnects once when the server dropped the connection', async () => {
    const { transport, recorded } = build({
      failSearchOnce: new Error('socket closed unexpectedly'),
      messages: [fetched()],
    })
    // The retry has to succeed transparently: a dropped IMAP socket is ordinary.
    await expect(transport.search({})).resolves.toBeDefined()
    expect(recorded.connects).toBe(2)
  })

  it('re-resolves the password when it reconnects, so a rotation takes effect', async () => {
    const { transport, recorded, state } = build({
      failSearchOnce: new Error('socket closed unexpectedly'),
      messages: [fetched()],
    })
    state.password = 'app-password-2'
    await transport.search({})
    expect(recorded.passwords.at(-1)).toBe('app-password-2')
  })

  it('does not retry a rejected password, which is how an account gets locked', async () => {
    const failure = Object.assign(new Error('Invalid credentials'), { authenticationFailed: true })
    const { transport, recorded } = build({ failSearchOnce: failure, messages: [fetched()] })
    await expect(transport.search({})).rejects.toMatchObject({ code: 'auth-failed' })
    expect(recorded.connects).toBe(1)
  })

  it('explains a connection failure with the host it could not reach', async () => {
    const { transport } = build({ failConnectWith: new Error('ETIMEDOUT') })
    await expect(transport.search({})).rejects.toThrow(/imap\.mail\.yahoo\.com/)
  })

  it('releases the connection when closed', async () => {
    const { transport, recorded } = build({ messages: [fetched()] })
    await transport.search({})
    await transport.close()
    expect(recorded.logouts).toBe(1)
  })

  it('always takes a mailbox lock, so commands cannot interleave', async () => {
    const { transport, recorded } = build({ messages: [fetched()] })
    await transport.search({})
    await transport.read(101)
    expect(recorded.locks).toEqual(['INBOX', 'INBOX'])
  })
})

describe('probe', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('reports the address, the folder count, and the unread count', async () => {
    const { transport } = build()
    const result = await transport.probe()
    expect(result).toContain('family@yahoo.com')
    expect(result).toContain('4 mailbox')
    expect(result).toContain('3 unread')
  })
})

describe('buildSearchCriteria', () => {
  it('asks for everything when nothing was specified', () => {
    expect(buildSearchCriteria({})).toEqual({ all: true })
  })

  it('combines the filters it was given', () => {
    const criteria = buildSearchCriteria({ from: 'school', subject: 'evening', seen: false })
    expect(criteria).toEqual({ from: 'school', subject: 'evening', seen: false })
  })

  it('ignores empty strings rather than searching for nothing', () => {
    expect(buildSearchCriteria({ from: '', subject: '' })).toEqual({ all: true })
  })

  it('keeps seen: false, which is not the same as unset', () => {
    expect(buildSearchCriteria({ seen: false }).seen).toBe(false)
  })

  it('passes dates through as dates', () => {
    const since = new Date('2026-08-01T00:00:00Z')
    expect(buildSearchCriteria({ since }).since).toBe(since)
  })
})

describe('hasAttachment', () => {
  it('is false for a plain message', () => {
    expect(hasAttachment({ type: 'text/plain' })).toBe(false)
  })

  it('is true for an attachment disposition', () => {
    expect(hasAttachment({ type: 'multipart/mixed', childNodes: [{ disposition: 'attachment' }] })).toBe(true)
  })

  it('counts an inline part with a filename, which a reader would call an attachment', () => {
    expect(hasAttachment({
      childNodes: [{ disposition: 'inline', dispositionParameters: { filename: 'form.pdf' } }],
    })).toBe(true)
  })

  it('ignores an inline part with no filename, which is usually a signature image', () => {
    expect(hasAttachment({ childNodes: [{ disposition: 'inline' }] })).toBe(false)
  })

  it('searches nested parts', () => {
    expect(hasAttachment({
      childNodes: [{ childNodes: [{ childNodes: [{ disposition: 'ATTACHMENT' }] }] }],
    })).toBe(true)
  })

  it('is false for an absent structure', () => {
    expect(hasAttachment(undefined)).toBe(false)
  })
})

describe('isAuthFailure', () => {
  it('recognises the shapes each library uses', () => {
    expect(isAuthFailure({ authenticationFailed: true })).toBe(true)
    expect(isAuthFailure({ code: 'EAUTH' })).toBe(true)
    expect(isAuthFailure({ responseCode: 535 })).toBe(true)
    expect(isAuthFailure(new Error('Invalid credentials'))).toBe(true)
    expect(isAuthFailure(new Error('AUTHENTICATIONFAILED'))).toBe(true)
  })

  it('does not mistake a network failure for a rejected password', () => {
    expect(isAuthFailure(new Error('ETIMEDOUT'))).toBe(false)
    expect(isAuthFailure(undefined)).toBe(false)
    expect(isAuthFailure(null)).toBe(false)
  })
})
