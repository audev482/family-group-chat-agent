/**
 * Turning MIME into something a person (and a model) can read, and back again.
 *
 * Everything here is pure: no sockets, no library imports. That keeps the fiddly
 * parts — address formatting, HTML stripping, reply threading, quoting — testable
 * without a mail server.
 *
 * @module dsh-mail/message
 */

import type { MailAddress, MessageSummary } from './types.ts'

/** Stand-in subject for a message that arrived without one. */
export const NO_SUBJECT = '(no subject)'

/**
 * Normalise the address shapes an IMAP envelope can carry.
 *
 * An envelope address may have a name, an address, or — for a malformed message —
 * neither. Entries with no address are dropped: an address-less participant
 * cannot be replied to and would only mislead.
 * @param list - envelope addresses, possibly absent.
 * @returns clean addresses.
 */
export function normaliseAddresses(list: { name?: string; address?: string }[] | undefined): MailAddress[] {
  if (list === undefined) return []
  const out: MailAddress[] = []
  for (const entry of list) {
    const address = entry.address?.trim()
    if (address === undefined || address === '') continue
    const name = entry.name?.trim()
    out.push(name === undefined || name === '' ? { address } : { name, address })
  }
  return out
}

/**
 * Render an address the way a person writes one.
 * @param address - the address.
 * @returns `Name <a@b.c>`, or the bare address.
 */
export function formatAddress(address: MailAddress): string {
  if (address.name === undefined || address.name === '') return address.address
  // Quote a display name containing anything a header parser would choke on.
  const name = /[",<>:;@[\]\\]/.test(address.name)
    ? `"${address.name.replace(/(["\\])/g, '\\$1')}"`
    : address.name
  return `${name} <${address.address}>`
}

/**
 * Render a list of addresses.
 * @param addresses - the addresses.
 * @returns a comma-separated list, or an empty string.
 */
export function formatAddresses(addresses: MailAddress[]): string {
  return addresses.map(formatAddress).join(', ')
}

/**
 * Parse a recipient a person typed, which may be bare or `Name <addr>`.
 * @param input - the typed recipient.
 * @returns the parsed address, or undefined when there is no address in it.
 */
export function parseAddress(input: string | MailAddress): MailAddress | undefined {
  if (typeof input !== 'string') {
    return input.address.trim() === '' ? undefined : input
  }
  const text = input.trim()
  if (text === '') return undefined
  const angled = /^(.*?)<([^>]*)>$/.exec(text)
  if (angled !== null) {
    const address = angled[2]!.trim()
    // `Kit <>` names nobody. Falling through would treat the whole string as an
    // address and produce a recipient that cannot receive anything.
    if (address === '') return undefined
    const name = angled[1]!.trim().replace(/^"|"$/g, '').trim()
    return name === '' ? { address } : { name, address }
  }
  // Anything left containing a bracket is malformed rather than a bare address.
  if (text.includes('<') || text.includes('>')) return undefined
  return { address: text }
}

/** A very small HTML-to-text reduction: enough to read a letter, not a renderer. */
export function htmlToText(html: string): string {
  return html
    // Drop anything that was never prose.
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // Keep link targets, which often carry the actual information in an email.
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_all, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return text === '' || text === href ? href : `${text} (${href})`
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_all, code: string) => String.fromCodePoint(Number(code)))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Choose the readable body, preferring what the sender wrote as text.
 * @param parts - the decoded text and HTML alternatives.
 * @returns the body as plain text.
 */
export function chooseBody(parts: { text?: string; html?: string }): string {
  const text = parts.text?.trim()
  if (text !== undefined && text !== '') return normaliseWhitespace(text)
  const html = parts.html?.trim()
  if (html !== undefined && html !== '') return normaliseWhitespace(htmlToText(html))
  return ''
}

/**
 * Collapse the whitespace that email formats introduce.
 * @param text - the body.
 * @returns the tidied body.
 */
export function normaliseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Soft line breaks from format=flowed leave trailing spaces everywhere.
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A body cut down to size, and whether it was cut. */
export interface ClippedBody {
  /** The body, possibly shortened. */
  readonly body: string
  /** Whether anything was removed. */
  readonly truncated: boolean
}

/**
 * Cut a body down to a readable size, on a line boundary where possible.
 *
 * Long threads and newsletters would otherwise crowd out everything else in the
 * prompt, and the top of an email is nearly always the part that matters.
 * @param text - the body.
 * @param maxChars - the cap.
 * @returns the clipped body.
 */
export function clipBody(text: string, maxChars: number): ClippedBody {
  if (text.length <= maxChars) return { body: text, truncated: false }
  const head = text.slice(0, maxChars)
  const lastBreak = head.lastIndexOf('\n')
  const cut = lastBreak > maxChars * 0.6 ? head.slice(0, lastBreak) : head
  return { body: cut.trimEnd(), truncated: true }
}

/**
 * The subject line for a reply, without stacking `Re:` forever.
 * @param subject - the original subject.
 * @returns the reply subject.
 */
export function replySubject(subject: string): string {
  const base = subject.trim() === '' || subject === NO_SUBJECT ? '' : subject.trim()
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`.trimEnd()
}

/**
 * The subject line for a forward.
 * @param subject - the original subject.
 * @returns the forward subject.
 */
export function forwardSubject(subject: string): string {
  const base = subject.trim() === '' || subject === NO_SUBJECT ? '' : subject.trim()
  return /^fwd?\s*:/i.test(base) ? base : `Fwd: ${base}`.trimEnd()
}

/**
 * Who a reply goes to: `Reply-To` when the sender asked for it, otherwise `From`.
 * @param message - the message being answered.
 * @returns the recipients.
 */
export function replyRecipients(message: { from: MailAddress[]; replyTo?: MailAddress[] }): MailAddress[] {
  const replyTo = message.replyTo ?? []
  return replyTo.length > 0 ? replyTo : message.from
}

/**
 * The `References` chain for a reply, per RFC 5322 §3.6.4.
 * @param message - the message being answered.
 * @returns the chain, oldest first.
 */
export function replyReferences(message: { messageId?: string; references?: string[] }): string[] {
  const chain = [...message.references ?? []]
  if (message.messageId !== undefined && !chain.includes(message.messageId)) chain.push(message.messageId)
  return chain
}

/**
 * Quote a message beneath a reply, the way every mail client does.
 * @param message - the message being answered.
 * @param body - the quoted body.
 * @returns the attribution line and quoted text.
 */
export function quoteBody(message: { from: MailAddress[]; date?: string }, body: string): string {
  const who = message.from[0] === undefined ? 'someone' : formatAddress(message.from[0])
  const when = message.date === undefined ? '' : ` on ${message.date.slice(0, 16).replace('T', ' ')}`
  const quoted = body.split('\n').map(line => `> ${line}`.trimEnd()).join('\n')
  return `\n\nOn${when === '' ? '' : when.slice(1)}, ${who} wrote:\n${quoted}`
}

/**
 * One line describing a message in a list.
 *
 * Unread is marked rather than read, because in a list of twenty the three new
 * ones are the answer to the question.
 * @param message - the message.
 * @param options - whether to show which mailbox it is in.
 * @returns the line.
 */
export function messageLine(message: MessageSummary, options: { showMailbox?: boolean } = {}): string {
  const marks = [
    message.seen ? '' : 'unread',
    message.flagged ? 'starred' : '',
    message.hasAttachments ? 'attachment' : '',
    message.answered ? 'replied' : '',
  ].filter(mark => mark !== '')
  const from = message.from[0] === undefined
    ? 'unknown sender'
    : message.from[0].name ?? message.from[0].address
  const when = message.date === undefined ? '' : ` · ${message.date.slice(0, 16).replace('T', ' ')}`
  const where = options.showMailbox === true ? ` · in ${message.mailbox}` : ''
  const tags = marks.length === 0 ? '' : ` [${marks.join(', ')}]`
  return `#${message.uid} · ${message.subject} · from ${from}${when}${where}${tags}`
}
