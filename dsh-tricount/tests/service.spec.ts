/**
 * The `ctx.tricount` seam: configuration, connection, and edits.
 *
 * The edit tests are the reason this file is long. The reference Python client's
 * `edit_transaction` corrupts money in three separate ways, and each one is checked
 * here as a behaviour rather than trusted to a comment:
 *
 *   * it writes a caller's positive amount straight through, which flips an expense
 *     into income and reverses its effect on every balance;
 *   * it rewrites every split as fixed amounts, destroying the ratios that make a
 *     split still mean something after the total changes;
 *   * it divides the new total per-share with independent rounding, so the parts no
 *     longer add up to the whole.
 *
 * The service is constructed directly rather than through `ctx.plugin()`, because
 * configuration validation throws in the constructor and a fiber error would hide it.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LEDGER_TTL_MS, Tricount, resolveConfig } from '../src/index.ts'
import { internals } from '../src/wire.ts'
import { TricountError } from '../src/types.ts'

/** Stands in for the credential provider. */
class FakeCredentials extends Service {
  /** What the next resolve returns, by reference name. */
  values: Record<string, string> = { TRICOUNT_TOKEN: 'tSHARE123' }
  /** How many times a credential was resolved. */
  resolves = 0

  constructor(ctx: Context) {
    super(ctx, 'credentials')
  }

  /**
   * Resolve a reference.
   * @param ref - the credential name.
   * @returns the resolved credential, or undefined when unset.
   */
  async resolve(ref: string): Promise<{ value: string; source: string } | undefined> {
    this.resolves += 1
    const value = this.values[ref]
    return value === undefined ? undefined : { value, source: 'test' }
  }
}

/** One registry entry, in the API's response shape. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RegistryEntry: {
      id: 900,
      uuid: 'entry-uuid',
      description: 'Shell gas [ref:pTxN123]',
      amount: { value: '-54.20', currency: 'USD' },
      membership_uuid_owner: 'm-alex',
      type_transaction: 'NORMAL',
      status: 'ACTIVE',
      category: 'TRANSPORT',
      date: '2026-08-20 12:00:00.000000',
      allocations: [
        { membership_uuid: 'm-alex', amount: { value: '-32.52' }, type: 'RATIO', share_ratio: 3 },
        { membership_uuid: 'm-sam', amount: { value: '-21.68' }, type: 'RATIO', share_ratio: 2 },
      ],
      ...overrides,
    },
  }
}

/** The registry payload the fake server returns. */
function registry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 555, uuid: 'ledger-uuid', title: 'Household', currency: 'USD',
    public_identifier_token: 'tSHARE123', status: 'READ_WRITE',
    memberships: [
      { M: { id: 1, uuid: 'm-alex', status: 'ACTIVE', alias: { display_name: 'Alex' } } },
      { M: { id: 2, uuid: 'm-sam', status: 'ACTIVE', alias: { display_name: 'Sam' } } },
      { M: { id: 3, uuid: 'm-sadie', status: 'ACTIVE', alias: { display_name: 'Sadie' } } },
      { M: { id: 4, uuid: 'm-gone', status: 'DELETED', alias: { display_name: 'Departed' } } },
    ],
    all_registry_entry: [entry()],
    ...overrides,
  }
}

/**
 * Build the service over a fake transport.
 *
 * The fake answers the three calls a connect makes — authenticate, join, fetch —
 * and records every write for inspection.
 */
function build(options: { registry?: Record<string, unknown>; config?: Record<string, unknown> } = {}) {
  const ctx = new Context()
  const credentials = new FakeCredentials(ctx)
  const writes: { method: string; url: string; body: Record<string, unknown> }[] = []
  const events: Record<string, unknown>[] = []
  ctx.on('tricount/request', event => events.push(event as unknown as Record<string, unknown>))
  ctx.on('tricount/device', event => events.push({ device: true, ...event }))

  vi.spyOn(internals, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const path = String(url)
    const method = String(init.method)
    const body = init.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
    let json: unknown = { Response: [] }
    if (path.endsWith('/session-registry-installation')) {
      json = { Response: [{ Token: { token: 'tok' } }, { UserPerson: { id: 42 } }] }
    } else if (path.endsWith('/registry-synchronization')) {
      json = { Response: [{ RegistrySynchronization: { all_registry_active: [{ public_identifier_token: 'tSHARE123', id: 555 }] } }] }
    } else if (method === 'GET' && path.endsWith('/registry')) {
      json = { Response: [{ Registry: options.registry ?? registry() }] }
    } else {
      writes.push({ method, url: path, body })
      json = { Response: [{ Id: { id: 1234 } }] }
    }
    return { ok: true, status: 200, text: async () => JSON.stringify(json) } as unknown as Response
  }) as typeof globalThis.fetch)

  const tricount = new Tricount(ctx, { tokenRef: 'TRICOUNT_TOKEN', ...options.config })
  return { ctx, tricount, credentials, writes, events }
}

beforeEach(() => {
  vi.restoreAllMocks()
})

describe('resolveConfig', () => {
  it('accepts a credential reference', () => {
    expect(resolveConfig({ tokenRef: 'TRICOUNT_TOKEN' }).tokenRef).toBe('TRICOUNT_TOKEN')
  })

  // A sharing token in a config file reaches logs, backups and version control.
  // Catching it at load turns that into a startup error instead.
  it('refuses a pasted sharing token', () => {
    expect(() => resolveConfig({ tokenRef: 'tABC123xyz789' })).toThrow(/looks like an actual Tricount sharing token/)
  })

  it('refuses a pasted PEM body', () => {
    expect(() => resolveConfig({
      tokenRef: 'TRICOUNT_TOKEN',
      publicKeyRef: '-----BEGIN RSA PUBLIC KEY-----\nAAA\n-----END RSA PUBLIC KEY-----',
    })).toThrow(/contains a PEM body/)
  })

  it('keeps a configured device identity', () => {
    const config = resolveConfig({ tokenRef: 'TRICOUNT_TOKEN', appId: 'uuid-1', publicKeyRef: 'TRICOUNT_KEY' })
    expect(config.appId).toBe('uuid-1')
    expect(config.publicKeyRef).toBe('TRICOUNT_KEY')
  })

  it('leaves the device absent when it is not configured', () => {
    const config = resolveConfig({ tokenRef: 'TRICOUNT_TOKEN' })
    expect(config.appId).toBeUndefined()
    expect(config.publicKeyRef).toBeUndefined()
  })
})

describe('ledger', () => {
  it('authenticates, joins, and reads', async () => {
    const { tricount } = build()
    const ledger = await tricount.ledger()
    expect(ledger.title).toBe('Household')
    expect(ledger.members.map(m => m.displayName)).toEqual(['Alex', 'Sam', 'Sadie', 'Departed'])
    expect(ledger.entries).toHaveLength(1)
  })

  it('reuses a recent snapshot rather than re-fetching', async () => {
    const { tricount } = build()
    await tricount.ledger()
    const before = vi.mocked(internals.fetch).mock.calls.length
    await tricount.ledger()
    expect(vi.mocked(internals.fetch).mock.calls.length).toBe(before)
  })

  it('re-fetches when forced', async () => {
    const { tricount } = build()
    await tricount.ledger()
    const before = vi.mocked(internals.fetch).mock.calls.length
    await tricount.ledger(true)
    expect(vi.mocked(internals.fetch).mock.calls.length).toBeGreaterThan(before)
  })

  // The bank-feed agent writes to the same ledger, so a long-lived snapshot would
  // have the butler answering "what have we spent" with a stale total.
  it('keeps the snapshot window short', () => {
    expect(LEDGER_TTL_MS).toBeLessThanOrEqual(60_000)
  })

  it('re-fetches after the snapshot is invalidated', async () => {
    const { tricount } = build()
    await tricount.ledger()
    tricount.invalidate()
    const before = vi.mocked(internals.fetch).mock.calls.length
    await tricount.ledger()
    expect(vi.mocked(internals.fetch).mock.calls.length).toBeGreaterThan(before)
  })

  it('says what to do when the token is not configured', async () => {
    const { tricount, credentials } = build()
    credentials.values = {}
    await expect(tricount.ledger()).rejects.toThrow(/resolves to no value/)
    await expect(tricount.ledger()).rejects.toThrow(/Share/)
  })

  it('reports each request without the token in it', async () => {
    const { tricount, events } = build()
    await tricount.ledger()
    const requests = events.filter(event => event['operation'] !== undefined)
    expect(requests.map(event => event['operation'])).toEqual(['authenticate', 'join', 'fetch'])
    expect(JSON.stringify(requests)).not.toContain('tSHARE123')
  })
})

describe('device identity', () => {
  // A fresh appId registers a new anonymous user on every boot. The consequence is
  // invisible, so the notice has to be loud.
  it('reports once when it has to mint an identity', async () => {
    const { tricount, events } = build()
    await tricount.ledger()
    await tricount.ledger(true)
    const notices = events.filter(event => event['device'] === true)
    expect(notices).toHaveLength(1)
    expect(notices[0]!['reason']).toMatch(/across restarts/)
    expect(String(notices[0]!['publicKeyPem'])).toContain('BEGIN RSA PUBLIC KEY')
  })

  it('uses a configured identity and says nothing', async () => {
    const { tricount, credentials, events } = build({
      config: { appId: 'stable-uuid', publicKeyRef: 'TRICOUNT_KEY' },
    })
    credentials.values['TRICOUNT_KEY'] = '-----BEGIN RSA PUBLIC KEY-----\nSTABLE\n-----END RSA PUBLIC KEY-----\n'
    await tricount.ledger()
    expect(events.filter(event => event['device'] === true)).toHaveLength(0)
    const auth = vi.mocked(internals.fetch).mock.calls[0]!
    expect(JSON.parse(String((auth[1] as RequestInit).body))).toMatchObject({ app_installation_uuid: 'stable-uuid' })
  })

  it('says what to do when the key reference resolves to nothing', async () => {
    const { tricount } = build({ config: { appId: 'stable-uuid', publicKeyRef: 'MISSING_KEY' } })
    await expect(tricount.ledger()).rejects.toThrow(/resolves to no value/)
  })
})

describe('member', () => {
  it('finds a member by exact name, whatever the case', async () => {
    const { tricount } = build()
    expect((await tricount.member('alex')).uuid).toBe('m-alex')
    expect((await tricount.member('ALEX')).uuid).toBe('m-alex')
  })

  it('accepts a unique prefix, because people type names in chat', async () => {
    const { tricount } = build()
    expect((await tricount.member('sad')).displayName).toBe('Sadie')
  })

  // "Sa" is both Sam and Sadie. Guessing would file money against the wrong person.
  it('refuses an ambiguous prefix and names the candidates', async () => {
    const { tricount } = build()
    await expect(tricount.member('sa')).rejects.toThrow(/could be any of Sam, Sadie/)
  })

  it('prefers an exact match over a longer name it prefixes', async () => {
    const { tricount } = build()
    expect((await tricount.member('Sam')).uuid).toBe('m-sam')
  })

  it('names who is on the ledger when nobody matches', async () => {
    const { tricount } = build()
    await expect(tricount.member('Bob')).rejects.toThrow(/Alex, Sam, Sadie/)
  })

  it('ignores a removed member', async () => {
    const { tricount } = build()
    await expect(tricount.member('Departed')).rejects.toThrow(TricountError)
  })
})

describe('entry', () => {
  it('finds an entry by id', async () => {
    const { tricount } = build()
    expect((await tricount.entry(900)).title).toBe('Shell gas')
  })

  it('fails clearly for an id that is not there', async () => {
    const { tricount } = build()
    await expect(tricount.entry(1)).rejects.toThrow(/no ledger entry 1/)
  })
})

describe('add', () => {
  it('creates the entry and invalidates the snapshot', async () => {
    const { tricount, writes } = build()
    const id = await tricount.add({
      description: 'Dinner', minor: -5000, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -2500, shareRatio: 1 }, { memberUuid: 'm-sam', minor: -2500, shareRatio: 1 }],
    })
    expect(id).toBe(1234)
    expect(writes[0]!.method).toBe('POST')
    const before = vi.mocked(internals.fetch).mock.calls.length
    await tricount.ledger()
    expect(vi.mocked(internals.fetch).mock.calls.length).toBeGreaterThan(before)
  })

  it('refuses to write to an archived ledger', async () => {
    const { tricount } = build({ registry: registry({ status: 'READ_ONLY' }) })
    await expect(tricount.add({
      description: 'x', minor: -1, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -1 }],
    })).rejects.toThrow(/archived/)
  })
})

describe('edit', () => {
  /*
   * Defect one. A caller naturally passes a positive amount. Writing that through
   * unchanged turns the expense into income and reverses its sign in every balance.
   */
  it('keeps an expense negative when given a positive amount', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { amountMinor: 6000 })
    expect((writes[0]!.body['amount'] as { value: string }).value).toBe('-60.00')
    expect(writes[0]!.body['type_transaction']).toBe('NORMAL')
  })

  it('keeps income positive when given a positive amount', async () => {
    const income = entry({
      id: 901, type_transaction: 'INCOME', amount: { value: '38.04' },
      allocations: [
        { membership_uuid: 'm-alex', amount: { value: '19.02' }, type: 'RATIO', share_ratio: 1 },
        { membership_uuid: 'm-sam', amount: { value: '19.02' }, type: 'RATIO', share_ratio: 1 },
      ],
    })
    const { tricount, writes } = build({ registry: registry({ all_registry_entry: [income] }) })
    await tricount.edit(901, { amountMinor: 4000 })
    expect((writes[0]!.body['amount'] as { value: string }).value).toBe('40.00')
    expect(writes[0]!.body['type_transaction']).toBe('INCOME')
  })

  /*
   * Defect two. A split filed as parts still describes the household's intent after
   * the total changes; rewritten as fixed amounts it does not.
   */
  it('preserves the ratios when only the total changes', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { amountMinor: 10000 })
    expect(writes[0]!.body['allocations']).toEqual([
      { membership_uuid: 'm-alex', amount: { value: '-60.00', currency: 'USD' }, type: 'RATIO', share_ratio: 3 },
      { membership_uuid: 'm-sam', amount: { value: '-40.00', currency: 'USD' }, type: 'RATIO', share_ratio: 2 },
    ])
  })

  /*
   * Defect three. Rounding each share independently loses a unit: a third of 100.00
   * three ways is 33.33, and three of those is 99.99.
   */
  it('re-divides a new total so the shares still sum to it exactly', async () => {
    const thirds = entry({
      allocations: [
        { membership_uuid: 'm-alex', amount: { value: '-18.07' }, type: 'RATIO', share_ratio: 1 },
        { membership_uuid: 'm-sam', amount: { value: '-18.07' }, type: 'RATIO', share_ratio: 1 },
        { membership_uuid: 'm-sadie', amount: { value: '-18.06' }, type: 'RATIO', share_ratio: 1 },
      ],
    })
    const { tricount, writes } = build({ registry: registry({ all_registry_entry: [thirds] }) })
    await tricount.edit(900, { amountMinor: 10000 })
    const allocations = writes[0]!.body['allocations'] as { amount: { value: string } }[]
    const sum = allocations.reduce((run, allocation) => run + Math.round(Number(allocation.amount.value) * 100), 0)
    expect(sum).toBe(-10000)
    expect(allocations.map(a => a.amount.value)).toEqual(['-33.34', '-33.33', '-33.33'])
  })

  it('leaves the amount and split alone when only the title changes', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { title: 'Shell gas, motorway' })
    expect((writes[0]!.body['amount'] as { value: string }).value).toBe('-54.20')
    expect(writes[0]!.body['allocations']).toEqual([
      { membership_uuid: 'm-alex', amount: { value: '-32.52', currency: 'USD' }, type: 'RATIO', share_ratio: 3 },
      { membership_uuid: 'm-sam', amount: { value: '-21.68', currency: 'USD' }, type: 'RATIO', share_ratio: 2 },
    ])
  })

  // Losing the tag would make the bank-feed agent think the expense was never filed
  // and file it a second time.
  it('preserves the bank-feed tag through a retitle', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { title: 'Shell gas, motorway' })
    expect(writes[0]!.body['description']).toBe('Shell gas, motorway [ref:pTxN123]')
  })

  it('adds no tag to a hand-entered entry', async () => {
    const plain = entry({ description: 'Dinner out' })
    const { tricount, writes } = build({ registry: registry({ all_registry_entry: [plain] }) })
    await tricount.edit(900, { title: 'Dinner in town' })
    expect(writes[0]!.body['description']).toBe('Dinner in town')
  })

  it('accepts an explicit new split', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { split: [{ memberUuid: 'm-alex', parts: 1 }, { memberUuid: 'm-sam', parts: 1 }] })
    expect(writes[0]!.body['allocations']).toEqual([
      { membership_uuid: 'm-alex', amount: { value: '-27.10', currency: 'USD' }, type: 'RATIO', share_ratio: 1 },
      { membership_uuid: 'm-sam', amount: { value: '-27.10', currency: 'USD' }, type: 'RATIO', share_ratio: 1 },
    ])
  })

  it('changes the payer', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { payerUuid: 'm-sam' })
    expect(writes[0]!.body['membership_uuid_owner']).toBe('m-sam')
  })

  it('changes the day', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { day: '2026-08-01' })
    expect(writes[0]!.body['date']).toBe('2026-08-01 12:00:00.000000')
  })

  it('changes the category', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { category: 'GROCERIES' })
    expect(writes[0]!.body['category']).toBe('GROCERIES')
  })

  it('keeps the existing category when the edit does not mention one', async () => {
    const { tricount, writes } = build()
    await tricount.edit(900, { title: 'Petrol' })
    expect(writes[0]!.body['category']).toBe('TRANSPORT')
  })

  // An uneven split of fixed amounts must stay uneven; making it even would silently
  // move money between two people.
  it('scales fixed amounts by their existing proportions', async () => {
    const fixed = entry({
      amount: { value: '-100.00' },
      allocations: [
        { membership_uuid: 'm-alex', amount: { value: '-75.00' }, type: 'AMOUNT' },
        { membership_uuid: 'm-sam', amount: { value: '-25.00' }, type: 'AMOUNT' },
      ],
    })
    const { tricount, writes } = build({ registry: registry({ all_registry_entry: [fixed] }) })
    await tricount.edit(900, { amountMinor: 20000 })
    const allocations = writes[0]!.body['allocations'] as { amount: { value: string }; type: string }[]
    expect(allocations.map(a => a.amount.value)).toEqual(['-150.00', '-50.00'])
    expect(allocations.every(a => a.type === 'AMOUNT')).toBe(true)
  })

  it('returns the entry as it was, so a caller can report the change', async () => {
    const { tricount } = build()
    const before = await tricount.edit(900, { amountMinor: 6000 })
    expect(before.amount.minor).toBe(-5420)
    expect(before.title).toBe('Shell gas')
  })

  it('refuses to edit on an archived ledger', async () => {
    const { tricount } = build({ registry: registry({ status: 'READ_ONLY' }) })
    await expect(tricount.edit(900, { title: 'x' })).rejects.toThrow(/archived/)
  })

  it('fails clearly for an entry that is not there', async () => {
    const { tricount } = build()
    await expect(tricount.edit(1, { title: 'x' })).rejects.toThrow(/no ledger entry 1/)
  })
})

describe('remove', () => {
  it('deletes the entry and reports what went', async () => {
    const { tricount, writes } = build()
    const removed = await tricount.remove(900)
    expect(removed.title).toBe('Shell gas')
    expect(writes[0]!.method).toBe('DELETE')
    expect(writes[0]!.url).toContain('/registry-entry/900')
  })

  it('refuses to remove from an archived ledger', async () => {
    const { tricount } = build({ registry: registry({ status: 'READ_ONLY' }) })
    await expect(tricount.remove(900)).rejects.toThrow(/archived/)
  })
})

describe('balances and settlement', () => {
  it('computes balances from the ledger', async () => {
    const { tricount } = build()
    const balances = await tricount.balances()
    const byName = Object.fromEntries(balances.map(b => [b.member.displayName, b.minor]))
    expect(byName['Alex']).toBe(2168)
    expect(byName['Sam']).toBe(-2168)
    expect(balances.reduce((sum, b) => sum + b.minor, 0)).toBe(0)
  })

  it('suggests who pays whom', async () => {
    const { tricount } = build()
    const payments = await tricount.settlement()
    expect(payments).toHaveLength(1)
    expect(payments[0]!.from.displayName).toBe('Sam')
    expect(payments[0]!.to.displayName).toBe('Alex')
    expect(payments[0]!.minor).toBe(2168)
  })
})

describe('nameOf and readable', () => {
  it('names a member by uuid', async () => {
    const { tricount } = build()
    const ledger = await tricount.ledger()
    expect(tricount.nameOf(ledger, 'm-alex')).toBe('Alex')
  })

  it('says so plainly when the member has gone', async () => {
    const { tricount } = build()
    const ledger = await tricount.ledger()
    expect(tricount.nameOf(ledger, 'm-vanished')).toContain('former member')
  })

  it('strips a machine tag for reading', () => {
    const { tricount } = build()
    expect(tricount.readable('Shell gas [ref:x]')).toBe('Shell gas')
  })
})
