/**
 * Finding the right person, and reading what the model asked to group by.
 *
 * Name resolution is the load-bearing part. The family says "mum" in chat, the ledger
 * says "Samantha", and the household config is what bridges them — so a butler that
 * resolves the wrong one files money against the wrong person, and nobody notices until
 * the balance is wrong.
 */

import { describe, expect, it } from 'vitest'
import { ExpenseInputError, readGrouping, resolveLedgerMember } from '../src/format.ts'
import type { RosterLookup } from '../src/format.ts'
import type { Ledger, LedgerMember } from 'dsh-tricount'

/** A ledger with the given member names, all active unless prefixed with a dash. */
function ledgerWith(names: readonly string[]): Ledger {
  const members: LedgerMember[] = names.map((name, index) => ({
    uuid: `m-${name.replace(/^-/, '').toLowerCase()}`,
    id: index + 1,
    displayName: name.replace(/^-/, ''),
    status: name.startsWith('-') ? 'DELETED' : 'ACTIVE',
  }))
  return { id: 1, uuid: 'l', title: 'Household', currency: 'USD', token: 't', status: 'READ_WRITE', members, entries: [] }
}

/** A roster that knows a few aliases. */
const ROSTER: RosterLookup = {
  resolve: (name) => {
    const folded = name.trim().toLowerCase()
    const people = [
      { key: 'alex', displayName: 'Alex', aliases: ['dad', 'alexander'] },
      { key: 'sam', displayName: 'Sam', aliases: ['mum'] },
      { key: 'kit', displayName: 'Kit', aliases: [] },
    ]
    const found = people.find(person =>
      person.key === folded
      || person.displayName.toLowerCase() === folded
      || person.aliases.includes(folded))
    return found === undefined ? undefined : { key: found.key, displayName: found.displayName }
  },
}

/** A roster that knows nobody, for the fall-through cases. */
const NO_ROSTER: RosterLookup = { resolve: () => undefined }

describe('resolveLedgerMember', () => {
  it('matches a ledger name directly', () => {
    expect(resolveLedgerMember(ledgerWith(['Alex', 'Sam']), 'Alex', ROSTER).uuid).toBe('m-alex')
  })

  it('is case and space insensitive', () => {
    expect(resolveLedgerMember(ledgerWith(['Alex']), '  aLeX ', ROSTER).uuid).toBe('m-alex')
  })

  // The whole reason the household roster is consulted first: the ledger has never
  // heard the word "mum".
  it('resolves a household alias to the ledger name', () => {
    expect(resolveLedgerMember(ledgerWith(['Alex', 'Sam']), 'mum', ROSTER).displayName).toBe('Sam')
    expect(resolveLedgerMember(ledgerWith(['Alex', 'Sam']), 'dad', ROSTER).displayName).toBe('Alex')
  })

  it('uses the configured mapping when the two systems disagree on a name', () => {
    const ledger = ledgerWith(['Alexander Baker', 'Sam'])
    expect(resolveLedgerMember(ledger, 'dad', ROSTER, { alex: 'Alexander Baker' }).uuid)
      .toBe('m-alexander baker')
  })

  it('falls back to the household display name when no mapping is configured', () => {
    expect(resolveLedgerMember(ledgerWith(['Alex']), 'dad', ROSTER).displayName).toBe('Alex')
  })

  it('falls back to the household key', () => {
    const ledger = ledgerWith(['alex'])
    expect(resolveLedgerMember(ledger, 'dad', ROSTER).displayName).toBe('alex')
  })

  // Somebody can be on the ledger without being in the household config, and refusing
  // to name them would make their entries unreadable rather than merely unattributed.
  it('finds a ledger member the household has never heard of', () => {
    expect(resolveLedgerMember(ledgerWith(['Alex', 'Lodger']), 'Lodger', NO_ROSTER).displayName).toBe('Lodger')
  })

  it('accepts a unique prefix', () => {
    expect(resolveLedgerMember(ledgerWith(['Alexander', 'Sam']), 'alexa', NO_ROSTER).displayName).toBe('Alexander')
  })

  // A prefix match that beat an exact one would resolve "Sam" to "Samantha".
  it('prefers an exact match over a name it merely prefixes', () => {
    expect(resolveLedgerMember(ledgerWith(['Sam', 'Samantha']), 'Sam', NO_ROSTER).displayName).toBe('Sam')
  })

  it('refuses an ambiguous prefix and names the candidates', () => {
    expect(() => resolveLedgerMember(ledgerWith(['Sam', 'Sadie']), 'sa', NO_ROSTER))
      .toThrow(/could be any of Sam, Sadie/)
  })

  it('names who is on the ledger when nothing matches', () => {
    expect(() => resolveLedgerMember(ledgerWith(['Alex', 'Sam']), 'Bob', NO_ROSTER))
      .toThrow(/The ledger has: Alex, Sam/)
  })

  it('throws the package error type, so a tool reports it as input trouble', () => {
    expect(() => resolveLedgerMember(ledgerWith(['Alex']), 'Bob', NO_ROSTER)).toThrow(ExpenseInputError)
  })

  it('ignores a member who has left the ledger', () => {
    expect(() => resolveLedgerMember(ledgerWith(['Alex', '-Departed']), 'Departed', NO_ROSTER))
      .toThrow(ExpenseInputError)
  })

  it('does not resolve an ambiguous prefix by ignoring a departed member', () => {
    // "Sa" is only ambiguous among active members; Sadie having left makes it unique.
    expect(resolveLedgerMember(ledgerWith(['Sam', '-Sadie']), 'sa', NO_ROSTER).displayName).toBe('Sam')
  })

  it('refuses an empty name', () => {
    expect(() => resolveLedgerMember(ledgerWith(['Alex']), '   ', NO_ROSTER)).toThrow(ExpenseInputError)
  })
})

describe('readGrouping', () => {
  it('defaults to category', () => {
    expect(readGrouping(undefined)).toBe('category')
    expect(readGrouping('')).toBe('category')
  })

  it('reads the four groupings', () => {
    expect(readGrouping('category')).toBe('category')
    expect(readGrouping('month')).toBe('month')
    expect(readGrouping('payer')).toBe('payer')
    expect(readGrouping('member')).toBe('member')
  })

  // The model is paraphrasing a person, so rejecting two of three synonyms would make
  // the tool feel arbitrary.
  it('accepts the synonyms a model will actually produce', () => {
    expect(readGrouping('monthly')).toBe('month')
    expect(readGrouping('months')).toBe('month')
    expect(readGrouping('categories')).toBe('category')
    expect(readGrouping('people')).toBe('member')
    expect(readGrouping('person')).toBe('member')
    expect(readGrouping('share')).toBe('member')
    expect(readGrouping('who paid')).toBe('payer')
  })

  it('is case and space insensitive', () => {
    expect(readGrouping('  MONTH  ')).toBe('month')
  })

  // Returning undefined rather than silently defaulting means the tool can say what it
  // does understand instead of quietly answering a different question.
  it('returns nothing for a grouping it does not know', () => {
    expect(readGrouping('by vibe')).toBeUndefined()
    expect(readGrouping('currency')).toBeUndefined()
  })
})
