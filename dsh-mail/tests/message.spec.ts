/**
 * MIME and prose handling.
 *
 * All pure, and all of it the sort of thing that looks obviously right and is
 * quietly wrong: `Re:` stacking forever, a display name with a comma breaking a
 * header, a reply going to the sender when the sender asked for `Reply-To`.
 */

import { describe, expect, it } from 'vitest'
import {
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
  replyReferences,
  replyRecipients,
  replySubject,
} from '../src/message.ts'
import type { MessageSummary } from '../src/types.ts'

/** A summary with only the fields under test filled in. */
function summary(overrides: Partial<MessageSummary> = {}): MessageSummary {
  return {
    uid: 42,
    mailbox: 'INBOX',
    subject: 'Parents evening',
    from: [{ name: 'Kit\'s School', address: 'office@school.example' }],
    to: [{ address: 'family@example.com' }],
    cc: [],
    date: '2026-08-21T09:15:00.000Z',
    messageId: '<abc@school.example>',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    ...overrides,
  }
}

describe('normaliseAddresses', () => {
  it('keeps name and address together', () => {
    expect(normaliseAddresses([{ name: 'Kit', address: 'kit@example.com' }]))
      .toEqual([{ name: 'Kit', address: 'kit@example.com' }])
  })

  it('drops an empty name rather than carrying a blank one', () => {
    expect(normaliseAddresses([{ name: '  ', address: 'kit@example.com' }]))
      .toEqual([{ address: 'kit@example.com' }])
  })

  it('drops an entry with no address, which cannot be replied to anyway', () => {
    expect(normaliseAddresses([{ name: 'Nobody' }, { address: 'kit@example.com' }]))
      .toEqual([{ address: 'kit@example.com' }])
  })

  it('handles an absent list', () => {
    expect(normaliseAddresses(undefined)).toEqual([])
  })
})

describe('formatAddress', () => {
  it('writes a bare address bare', () => {
    expect(formatAddress({ address: 'kit@example.com' })).toBe('kit@example.com')
  })

  it('writes a name with the address in angle brackets', () => {
    expect(formatAddress({ name: 'Kit', address: 'kit@example.com' })).toBe('Kit <kit@example.com>')
  })

  it('quotes a display name containing a comma, which would otherwise split the header', () => {
    expect(formatAddress({ name: 'Smith, John', address: 'j@example.com' }))
      .toBe('"Smith, John" <j@example.com>')
  })

  it('escapes a quote inside a display name', () => {
    expect(formatAddress({ name: 'He said "hi"', address: 'h@example.com' }))
      .toBe('"He said \\"hi\\"" <h@example.com>')
  })

  it('joins a list with commas', () => {
    expect(formatAddresses([{ address: 'a@x.com' }, { name: 'B', address: 'b@x.com' }]))
      .toBe('a@x.com, B <b@x.com>')
  })
})

describe('parseAddress', () => {
  it('parses a bare address', () => {
    expect(parseAddress('kit@example.com')).toEqual({ address: 'kit@example.com' })
  })

  it('parses a name and address', () => {
    expect(parseAddress('Kit <kit@example.com>')).toEqual({ name: 'Kit', address: 'kit@example.com' })
  })

  it('strips quotes from a quoted display name', () => {
    expect(parseAddress('"Smith, John" <j@example.com>'))
      .toEqual({ name: 'Smith, John', address: 'j@example.com' })
  })

  it('passes an already-parsed address through', () => {
    expect(parseAddress({ address: 'kit@example.com' })).toEqual({ address: 'kit@example.com' })
  })

  it('returns undefined for nothing usable', () => {
    expect(parseAddress('')).toBeUndefined()
    expect(parseAddress('   ')).toBeUndefined()
    expect(parseAddress('Kit <>')).toBeUndefined()
    expect(parseAddress('Kit <kit@example.com')).toBeUndefined()
  })
})

describe('htmlToText', () => {
  it('drops tags and keeps the words', () => {
    expect(htmlToText('<p>Hello <b>there</b></p>')).toBe('Hello there')
  })

  it('keeps a link target, which often carries the actual information', () => {
    expect(htmlToText('<a href="https://school.example/form">the form</a>'))
      .toBe('the form (https://school.example/form)')
  })

  it('does not repeat a link whose text is already the URL', () => {
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example')
  })

  it('removes script and style content entirely', () => {
    expect(htmlToText('<style>p{color:red}</style><p>Hi</p><script>alert(1)</script>')).toBe('Hi')
  })

  it('turns breaks and block ends into newlines', () => {
    expect(htmlToText('<p>One</p><p>Two</p>')).toBe('One\nTwo')
    expect(htmlToText('One<br>Two')).toBe('One\nTwo')
  })

  it('renders list items as a list', () => {
    expect(htmlToText('<ul><li>Bring a coat</li><li>Bring the form</li></ul>'))
      .toBe('- Bring a coat\n- Bring the form')
  })

  it('decodes the entities that appear in real mail', () => {
    expect(htmlToText('<p>Kit&nbsp;&amp; Sam &lt;3 &quot;school&quot; &#39;s day</p>'))
      .toBe('Kit & Sam <3 "school" \'s day')
  })

  it('decodes a numeric entity', () => {
    expect(htmlToText('<p>caf&#233;</p>')).toBe('café')
  })
})

describe('chooseBody', () => {
  it('prefers what the sender wrote as text', () => {
    expect(chooseBody({ text: 'Plain version', html: '<p>HTML version</p>' })).toBe('Plain version')
  })

  it('falls back to the HTML when there is no text part', () => {
    expect(chooseBody({ html: '<p>HTML version</p>' })).toBe('HTML version')
  })

  it('ignores a text part that is only whitespace', () => {
    expect(chooseBody({ text: '   \n  ', html: '<p>Real content</p>' })).toBe('Real content')
  })

  it('returns an empty string when there is nothing readable', () => {
    expect(chooseBody({})).toBe('')
  })
})

describe('normaliseWhitespace', () => {
  it('converts CRLF to newlines', () => {
    expect(normaliseWhitespace('one\r\ntwo')).toBe('one\ntwo')
  })

  it('strips the trailing spaces that format=flowed leaves everywhere', () => {
    expect(normaliseWhitespace('one   \ntwo  ')).toBe('one\ntwo')
  })

  it('collapses runs of blank lines', () => {
    expect(normaliseWhitespace('one\n\n\n\n\ntwo')).toBe('one\n\ntwo')
  })
})

describe('clipBody', () => {
  it('leaves a short body alone', () => {
    expect(clipBody('short', 100)).toEqual({ body: 'short', truncated: false })
  })

  it('cuts a long body and says so', () => {
    const result = clipBody('x'.repeat(500), 100)
    expect(result.truncated).toBe(true)
    expect(result.body.length).toBeLessThanOrEqual(100)
  })

  it('cuts on a line boundary when there is a reasonable one', () => {
    const text = `${'a'.repeat(70)}\n${'b'.repeat(200)}`
    const result = clipBody(text, 100)
    expect(result.body).toBe('a'.repeat(70))
  })

  it('cuts mid-line rather than throwing almost everything away', () => {
    // The only newline is very early, so honouring it would lose most of the cap.
    const text = `a\n${'b'.repeat(300)}`
    expect(clipBody(text, 100).body.length).toBeGreaterThan(50)
  })
})

describe('replySubject', () => {
  it('adds Re: to a fresh subject', () => {
    expect(replySubject('Parents evening')).toBe('Re: Parents evening')
  })

  it('does not stack Re: forever', () => {
    expect(replySubject('Re: Parents evening')).toBe('Re: Parents evening')
    expect(replySubject('RE: Parents evening')).toBe('RE: Parents evening')
    expect(replySubject('re:Parents evening')).toBe('re:Parents evening')
  })

  it('handles a message that arrived without a subject', () => {
    expect(replySubject(NO_SUBJECT)).toBe('Re:')
    expect(replySubject('')).toBe('Re:')
  })
})

describe('forwardSubject', () => {
  it('adds Fwd: to a fresh subject', () => {
    expect(forwardSubject('Parents evening')).toBe('Fwd: Parents evening')
  })

  it('does not stack, and accepts either spelling', () => {
    expect(forwardSubject('Fwd: Parents evening')).toBe('Fwd: Parents evening')
    expect(forwardSubject('Fw: Parents evening')).toBe('Fw: Parents evening')
  })
})

describe('replyRecipients', () => {
  it('replies to the sender', () => {
    expect(replyRecipients({ from: [{ address: 'office@school.example' }] }))
      .toEqual([{ address: 'office@school.example' }])
  })

  it('honours Reply-To when the sender asked for it', () => {
    // A no-reply sender with a real Reply-To is common, and ignoring it means
    // the reply goes nowhere.
    expect(replyRecipients({
      from: [{ address: 'no-reply@school.example' }],
      replyTo: [{ address: 'office@school.example' }],
    })).toEqual([{ address: 'office@school.example' }])
  })

  it('ignores an empty Reply-To', () => {
    expect(replyRecipients({ from: [{ address: 'a@x.com' }], replyTo: [] }))
      .toEqual([{ address: 'a@x.com' }])
  })
})

describe('replyReferences', () => {
  it('appends the message id to an existing chain', () => {
    expect(replyReferences({ messageId: '<c@x>', references: ['<a@x>', '<b@x>'] }))
      .toEqual(['<a@x>', '<b@x>', '<c@x>'])
  })

  it('starts a chain from a message with no references', () => {
    expect(replyReferences({ messageId: '<a@x>' })).toEqual(['<a@x>'])
  })

  it('does not repeat an id already in the chain', () => {
    expect(replyReferences({ messageId: '<b@x>', references: ['<a@x>', '<b@x>'] }))
      .toEqual(['<a@x>', '<b@x>'])
  })

  it('returns the chain unchanged when there is no message id', () => {
    expect(replyReferences({ references: ['<a@x>'] })).toEqual(['<a@x>'])
  })
})

describe('quoteBody', () => {
  it('quotes every line and attributes it', () => {
    const quoted = quoteBody(
      { from: [{ name: 'School', address: 'office@school.example' }], date: '2026-08-21T09:15:00.000Z' },
      'Line one\nLine two',
    )
    expect(quoted).toContain('School <office@school.example> wrote:')
    expect(quoted).toContain('> Line one')
    expect(quoted).toContain('> Line two')
  })

  it('does not leave trailing space on a quoted blank line', () => {
    const quoted = quoteBody({ from: [{ address: 'a@x.com' }] }, 'one\n\ntwo')
    expect(quoted).not.toMatch(/> $/m)
  })

  it('copes with a message that has no sender', () => {
    expect(quoteBody({ from: [] }, 'text')).toContain('someone wrote:')
  })
})

describe('messageLine', () => {
  it('leads with the id, because every other tool needs it', () => {
    expect(messageLine(summary())).toMatch(/^#42 /)
  })

  it('marks unread rather than read, since the new ones are the answer', () => {
    expect(messageLine(summary({ seen: false }))).toContain('unread')
    expect(messageLine(summary({ seen: true }))).not.toContain('unread')
  })

  it('marks starred, replied, and attachments', () => {
    const line = messageLine(summary({ seen: true, flagged: true, answered: true, hasAttachments: true }))
    expect(line).toContain('starred')
    expect(line).toContain('replied')
    expect(line).toContain('attachment')
  })

  it('prefers the sender\'s name over their address', () => {
    expect(messageLine(summary())).toContain('Kit\'s School')
  })

  it('falls back to the address when there is no name', () => {
    expect(messageLine(summary({ from: [{ address: 'office@school.example' }] })))
      .toContain('office@school.example')
  })

  it('names the mailbox only when asked', () => {
    expect(messageLine(summary(), { showMailbox: true })).toContain('INBOX')
    expect(messageLine(summary())).not.toContain('in INBOX')
  })

  it('copes with a message that has no sender at all', () => {
    expect(messageLine(summary({ from: [] }))).toContain('unknown sender')
  })
})
