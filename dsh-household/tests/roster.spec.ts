/**
 * The roster: who counts as whom, and the configuration mistakes that must be
 * refused rather than guessed past.
 *
 * The service is constructed directly against a bare cordis context. That is
 * deliberate: the validation that matters here runs in the constructor, and
 * loading through `ctx.plugin` would turn a thrown configuration error into a
 * fiber error that a test cannot assert on precisely.
 */

import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import Household, { HouseholdError, type Config } from '../src/index.ts'

/** A configuration with the shapes the roster has to cope with. */
function config(overrides: Partial<Config> = {}): Config {
  return {
    familyName: 'The Bakers',
    timezone: 'Europe/Amsterdam',
    sharedCalendar: 'Family',
    choresCalendar: 'Household',
    members: {
      alex: {
        displayName: 'Alex',
        aliases: ['Dad', 'Alexander'],
        tag: 'alex',
        discordUserId: '111',
        email: 'alex@example.com',
        calendar: 'Alex',
        role: 'adult',
      },
      sam: {
        displayName: 'Sam',
        aliases: ['Mum', 'Mom'],
        tag: 'sam',
        discordUserId: '222',
        role: 'adult',
      },
      kit: {
        displayName: 'Kit',
        aliases: [],
        tag: 'kit',
        birthday: '2015-04-09',
        role: 'child',
      },
    },
    ...overrides,
  } as Config
}

/**
 * Build the service on a throwaway context.
 * @param overrides - configuration overrides.
 * @returns the service.
 */
function build(overrides: Partial<Config> = {}): Household {
  return new Household(new Context(), config(overrides))
}

describe('roster construction', () => {
  let household: Household

  beforeEach(() => {
    household = build()
  })

  it('keeps members in configuration order', () => {
    expect(household.list().map(member => member.key)).toEqual(['alex', 'sam', 'kit'])
  })

  it('exposes the family name and time zone', () => {
    expect(household.familyName).toBe('The Bakers')
    expect(household.timezone).toBe('Europe/Amsterdam')
  })

  it('exposes the configured collections', () => {
    expect(household.sharedCalendar).toBe('Family')
    expect(household.choresCalendar).toBe('Household')
  })
})

describe('resolving a person', () => {
  let household: Household

  beforeEach(() => {
    household = build()
  })

  it('resolves the configuration key', () => {
    expect(household.resolve('alex')?.displayName).toBe('Alex')
  })

  it('resolves the display name regardless of case', () => {
    expect(household.resolve('SAM')?.key).toBe('sam')
    expect(household.resolve('sam')?.key).toBe('sam')
  })

  it('resolves the names a family actually says', () => {
    expect(household.resolve('Dad')?.key).toBe('alex')
    expect(household.resolve('mum')?.key).toBe('sam')
    expect(household.resolve('Mom')?.key).toBe('sam')
    expect(household.resolve('Alexander')?.key).toBe('alex')
  })

  it('returns undefined for someone who is not in the family', () => {
    expect(household.resolve('Gandalf')).toBeUndefined()
  })

  it('refuses an empty name rather than picking someone', () => {
    expect(household.resolve('')).toBeUndefined()
    expect(household.resolve('   ')).toBeUndefined()
  })

  it('names everyone it does know when a lookup must succeed and does not', () => {
    expect(() => household.require('Gandalf')).toThrow(HouseholdError)
    try {
      household.require('Gandalf')
    } catch (error) {
      // The message has to be usable in a chat reply, not just in a log.
      expect((error as Error).message).toContain('Alex')
      expect((error as Error).message).toContain('Sam')
      expect((error as Error).message).toContain('Kit')
    }
  })
})

describe('Discord attribution', () => {
  it('maps a Discord user id to a member', () => {
    const household = build()
    expect(household.byDiscordId('111')?.key).toBe('alex')
    expect(household.byDiscordId('222')?.key).toBe('sam')
  })

  it('returns undefined for a stranger in the room', () => {
    expect(build().byDiscordId('999')).toBeUndefined()
  })
})

describe('chore tags', () => {
  it('lists every tag', () => {
    expect(build().tags().sort()).toEqual(['alex', 'kit', 'sam'])
  })

  it('reads an assignee out of VTODO categories', () => {
    const household = build()
    expect(household.fromCategories(['kit'])?.key).toBe('kit')
    // A tag among unrelated tags still resolves: the Tasks UI mixes them freely.
    expect(household.fromCategories(['weekly', 'Sam', 'kitchen'])?.key).toBe('sam')
  })

  it('returns undefined when no category names a member', () => {
    expect(build().fromCategories(['weekly', 'kitchen'])).toBeUndefined()
    expect(build().fromCategories([])).toBeUndefined()
  })
})

describe('roster text for the prompt', () => {
  it('lists each member with the names that mean them', () => {
    const roster = build().roster()
    expect(roster).toContain('Alex')
    expect(roster).toContain('Dad')
    expect(roster).toContain('Kit')
  })

  it('says who is a child, so the butler can pitch an answer', () => {
    expect(build().roster().toLowerCase()).toContain('child')
  })
})

describe('configuration that must be refused', () => {
  it('refuses two members sharing a chore tag', () => {
    expect(() => build({
      members: {
        ...config().members,
        casey: { displayName: 'Casey', aliases: [], tag: 'Sam', role: 'adult' },
      },
    } as Partial<Config>)).toThrow(/already used by member/)
  })

  it('refuses two members sharing a Discord id', () => {
    expect(() => build({
      members: {
        ...config().members,
        casey: { displayName: 'Casey', aliases: [], tag: 'casey', discordUserId: '111', role: 'adult' },
      },
    } as Partial<Config>)).toThrow(/discordUserId/)
  })

  it('refuses one spoken name claimed by two members', () => {
    expect(() => build({
      members: {
        ...config().members,
        casey: { displayName: 'Casey', aliases: ['Dad'], tag: 'casey', role: 'adult' },
      },
    } as Partial<Config>)).toThrow(/resolves to both/)
  })

  it('refuses a time zone the platform does not know', () => {
    expect(() => build({ timezone: 'Middle/Earth' })).toThrow(/Middle\/Earth/)
  })

  it('accepts a household with no members, which is a new install rather than an error', () => {
    expect(() => build({ members: {} })).not.toThrow()
    expect(build({ members: {} }).list()).toEqual([])
  })
})

describe('the clock, as the service exposes it', () => {
  const now = new Date('2026-08-22T09:00:00Z')

  it('reports the family\'s own date', () => {
    expect(build().today(now)).toBe('2026-08-22')
  })

  it('understands spoken days and refuses phrases it does not know', () => {
    const household = build()
    expect(household.day('tomorrow', now)).toBe('2026-08-23')
    expect(household.day('nonsense', now)).toBeUndefined()
  })

  it('fails loud when a day is required and unparseable', () => {
    expect(() => build().requireDay('nonsense', now)).toThrow(HouseholdError)
  })
})

describe('household occasions', () => {
  it('is empty when nothing is configured, rather than undefined', () => {
    expect(build().occasions).toEqual([])
  })

  it('folds the configuration key in as a stable id', () => {
    const household = build({
      occasions: { wedding: { name: 'Wedding anniversary', date: '2014-09-20' } },
    })
    expect(household.occasions).toEqual([
      { id: 'wedding', name: 'Wedding anniversary', date: '2014-09-20' },
    ])
  })

  it('keeps configuration order', () => {
    const household = build({
      occasions: {
        wedding: { name: 'Wedding anniversary', date: '09-20' },
        'moved-in': { name: 'The day we moved in', date: '10-01' },
      },
    })
    expect(household.occasions.map(entry => entry.id)).toEqual(['wedding', 'moved-in'])
  })

  // A caller that mutated the returned array must not be able to change the
  // household's own view of itself, which is why this is a fresh snapshot.
  it('returns a fresh snapshot each time', () => {
    const household = build({
      occasions: { wedding: { name: 'Wedding anniversary', date: '09-20' } },
    })
    expect(household.occasions).not.toBe(household.occasions)
    expect(household.occasions).toEqual(household.occasions)
  })

  // Anniversaries deliberately do not live on a member: the date belongs to the
  // family, and putting it on one partner would be an arbitrary choice.
  it('is separate from the birthdays that live on members', () => {
    const household = build({
      occasions: { wedding: { name: 'Wedding anniversary', date: '09-20' } },
    })
    expect(household.occasions).toHaveLength(1)
    expect(household.list().filter(member => member.birthday !== undefined)).toHaveLength(1)
  })
})
