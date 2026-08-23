/**
 * The Tricount wire protocol, and the balance arithmetic over it.
 *
 * No network. The transport is replaced through `internals.fetch`, and the parsing
 * is exercised against payloads shaped like the real envelopes.
 *
 * The tests that matter most here are the balance ones. The reference Python client
 * computes balances from `abs()` of every amount, which erases the sign that
 * distinguishes money going out from money coming back — so a refund lands as a
 * second purchase and *doubles* the debt it was meant to clear. That is checked
 * directly, as an invariant: a refund must exactly invert its expense.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  BASE_URL,
  computeBalances,
  createEntry,
  deleteEntry,
  entryBody,
  fetchLedger,
  generateDevice,
  internals,
  joinLedger,
  openSession,
  parseLedger,
  settleUp,
  stripRef,
  updateEntry,
} from '../src/wire.ts'
import type { Device, Session } from '../src/wire.ts'
import { TricountError } from '../src/types.ts'
import type { Ledger } from '../src/types.ts'

const DEVICE: Device = { appId: 'app-uuid-1', publicKeyPem: '-----BEGIN RSA PUBLIC KEY-----\nAAA\n-----END RSA PUBLIC KEY-----\n' }
const SESSION: Session = { token: 'session-token-1', userId: 4242 }

/** Replace the transport with canned replies, and record what was sent. */
function stub(replies: (unknown | Error)[]) {
  const sent: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = []
  let call = 0
  vi.spyOn(internals, 'fetch').mockImplementation((async (url: string, init: RequestInit) => {
    const reply = replies[Math.min(call, replies.length - 1)]
    call += 1
    sent.push({
      url: String(url),
      method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    })
    if (reply instanceof Error) throw reply
    const record = reply as { status?: number; json?: unknown; text?: string }
    const status = record.status ?? 200
    const text = record.text ?? JSON.stringify(record.json ?? { Response: [] })
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
    } as unknown as Response
  }) as typeof globalThis.fetch)
  return { sent }
}

describe('generateDevice', () => {
  it('mints a uuid and a PKCS#1 public key', () => {
    const device = generateDevice()
    expect(device.appId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(device.publicKeyPem).toContain('BEGIN RSA PUBLIC KEY')
    expect(device.publicKeyPem).toContain('END RSA PUBLIC KEY')
  })

  it('mints a different identity each time', () => {
    expect(generateDevice().appId).not.toBe(generateDevice().appId)
  })
})

describe('openSession', () => {
  it('registers the device and returns the token and user id', async () => {
    const { sent } = stub([{ json: { Response: [{ Token: { token: 'tok-9' } }, { UserPerson: { id: 77 } }] } }])
    const session = await openSession(DEVICE)
    expect(session).toEqual({ token: 'tok-9', userId: 77 })
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/session-registry-installation`)
    expect(sent[0]!.body).toMatchObject({
      app_installation_uuid: DEVICE.appId,
      client_public_key: DEVICE.publicKeyPem,
      device_description: 'Android',
    })
  })

  it('sends the app id and a fresh request id on every call', async () => {
    stub([{ json: { Response: [{ Token: { token: 't' } }, { UserPerson: { id: 1 } }] } }])
    await openSession(DEVICE)
    await openSession(DEVICE)
    const spy = vi.mocked(internals.fetch)
    const first = (spy.mock.calls[0]![1] as RequestInit).headers as Record<string, string>
    const second = (spy.mock.calls[1]![1] as RequestInit).headers as Record<string, string>
    expect(first['app-id']).toBe(DEVICE.appId)
    expect(first['X-Bunq-Client-Request-Id']).not.toBe(second['X-Bunq-Client-Request-Id'])
  })

  it('fails clearly when the reply carries no token', async () => {
    stub([{ json: { Response: [{ UserPerson: { id: 1 } }] } }])
    await expect(openSession(DEVICE)).rejects.toThrow(TricountError)
    await expect(openSession(DEVICE)).rejects.toThrow(/no session token/)
  })

  it('reports the failure through the event sink', async () => {
    stub([{ status: 401, text: '{"Error":[{"error_description":"bad device"}]}' }])
    const events: { ok: boolean; error?: string; status?: number }[] = []
    await expect(openSession(DEVICE, event => events.push(event))).rejects.toThrow(/bad device/)
    expect(events[0]).toMatchObject({ ok: false, status: 401, error: 'transport-failed' })
  })

  it('reports a success through the event sink without amounts', async () => {
    stub([{ json: { Response: [{ Token: { token: 't' } }, { UserPerson: { id: 1 } }] } }])
    const events: Record<string, unknown>[] = []
    await openSession(DEVICE, event => events.push(event as Record<string, unknown>))
    expect(events[0]).toMatchObject({ operation: 'authenticate', method: 'POST', ok: true, status: 200 })
    expect(JSON.stringify(events[0])).not.toContain('PUBLIC KEY')
  })

  it('turns a network failure into a transport error', async () => {
    stub([new Error('ECONNREFUSED')])
    await expect(openSession(DEVICE)).rejects.toThrow(/could not reach the server/)
  })
})

describe('joinLedger', () => {
  it('syncs by sharing token and returns the registry id', async () => {
    const { sent } = stub([{
      json: {
        Response: [{
          RegistrySynchronization: {
            all_registry_active: [{ public_identifier_token: 'tABC', id: 555 }],
          },
        }],
      },
    }])
    expect(await joinLedger(DEVICE, SESSION, 'tABC')).toBe(555)
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/user/4242/registry-synchronization`)
    expect(sent[0]!.headers['X-Bunq-Client-Authentication']).toBe('session-token-1')
  })

  it('ignores a registry that is not the one asked for', async () => {
    stub([{
      json: {
        Response: [{
          RegistrySynchronization: {
            all_registry_active: [
              { public_identifier_token: 'tOTHER', id: 1 },
              { public_identifier_token: 'tABC', id: 2 },
            ],
          },
        }],
      },
    }])
    expect(await joinLedger(DEVICE, SESSION, 'tABC')).toBe(2)
  })

  it('fails clearly when the token matches nothing', async () => {
    stub([{ json: { Response: [{ RegistrySynchronization: { all_registry_active: [] } }] } }])
    await expect(joinLedger(DEVICE, SESSION, 'tNOPE')).rejects.toThrow(/sharing token/)
  })
})

/** A registry payload shaped like the API's, with two members and one expense. */
function registryPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 555,
    uuid: 'ledger-uuid',
    title: 'Household',
    currency: 'USD',
    public_identifier_token: 'tABC',
    status: 'READ_WRITE',
    memberships: [
      { RegistryMembershipNonUser: { id: 1, uuid: 'm-alex', status: 'ACTIVE', alias: { display_name: 'Alex' } } },
      { RegistryMembershipNonUser: { id: 2, uuid: 'm-sam', status: 'ACTIVE', alias: { display_name: 'Sam' } } },
    ],
    all_registry_entry: [{
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
          { membership_uuid: 'm-alex', amount: { value: '-32.52', currency: 'USD' }, type: 'RATIO', share_ratio: 3 },
          { membership_uuid: 'm-sam', amount: { value: '-21.68', currency: 'USD' }, type: 'RATIO', share_ratio: 2 },
        ],
      },
    }],
    ...overrides,
  }
}

describe('parseLedger', () => {
  it('reads the ledger header', () => {
    const ledger = parseLedger(registryPayload())
    expect(ledger).toMatchObject({ id: 555, title: 'Household', currency: 'USD', token: 'tABC', status: 'READ_WRITE' })
  })

  it('reads members out of their single-key wrappers', () => {
    expect(parseLedger(registryPayload()).members.map(m => m.displayName)).toEqual(['Alex', 'Sam'])
  })

  it('reads an entry with its signed amount in minor units', () => {
    const entry = parseLedger(registryPayload()).entries[0]!
    expect(entry.amount).toEqual({ minor: -5420, currency: 'USD' })
    expect(entry.type).toBe('NORMAL')
    expect(entry.category).toBe('TRANSPORT')
  })

  it('reads allocations with their ratios', () => {
    const entry = parseLedger(registryPayload()).entries[0]!
    expect(entry.allocations).toEqual([
      { memberUuid: 'm-alex', amount: { minor: -3252, currency: 'USD' }, type: 'RATIO', shareRatio: 3 },
      { memberUuid: 'm-sam', amount: { minor: -2168, currency: 'USD' }, type: 'RATIO', shareRatio: 2 },
    ])
  })

  // The bank-feed agent's tag is bookkeeping; a person should never see it, but the
  // raw description has to be kept because that agent matches on it.
  it('separates the machine tag from what a person reads', () => {
    const entry = parseLedger(registryPayload()).entries[0]!
    expect(entry.ref).toBe('pTxN123')
    expect(entry.title).toBe('Shell gas')
    expect(entry.description).toBe('Shell gas [ref:pTxN123]')
  })

  it('leaves ref absent on a hand-entered row', () => {
    const payload = registryPayload()
    const entry = (payload['all_registry_entry'] as Record<string, Record<string, unknown>>[])[0]!['RegistryEntry']!
    entry['description'] = 'Dinner out'
    const parsed = parseLedger(payload).entries[0]!
    expect(parsed.ref).toBeUndefined()
    expect(parsed.title).toBe('Dinner out')
  })

  it('reduces the timestamp to the day the family means', () => {
    expect(parseLedger(registryPayload()).entries[0]!.day).toBe('2026-08-20')
  })

  it('accepts the nested membership shape a write echoes back', () => {
    const payload = registryPayload()
    const entry = (payload['all_registry_entry'] as Record<string, Record<string, unknown>>[])[0]!['RegistryEntry']!
    delete entry['membership_uuid_owner']
    entry['membership_owned'] = { RegistryMembershipNonUser: { uuid: 'm-alex' } }
    entry['allocations'] = [{ membership: { RegistryMembershipNonUser: { uuid: 'm-sam' } }, amount: { value: '-54.20' }, type: 'AMOUNT' }]
    const parsed = parseLedger(payload).entries[0]!
    expect(parsed.payerUuid).toBe('m-alex')
    expect(parsed.allocations[0]!.memberUuid).toBe('m-sam')
  })

  // One malformed row must not make the whole ledger unreadable.
  it('skips an entry with no id rather than failing the parse', () => {
    const payload = registryPayload({
      all_registry_entry: [
        { RegistryEntry: { description: 'no id here' } },
        (registryPayload()['all_registry_entry'] as unknown[])[0],
      ],
    })
    expect(parseLedger(payload).entries).toHaveLength(1)
  })

  it('reads an unparseable amount as zero rather than throwing', () => {
    const payload = registryPayload()
    const entry = (payload['all_registry_entry'] as Record<string, Record<string, unknown>>[])[0]!['RegistryEntry']!
    entry['amount'] = { value: 'not money', currency: 'USD' }
    expect(parseLedger(payload).entries[0]!.amount.minor).toBe(0)
  })

  it('copes with a ledger that has no entries at all', () => {
    expect(parseLedger(registryPayload({ all_registry_entry: [] })).entries).toEqual([])
  })

  it('reads a zero-decimal currency in whole units', () => {
    const payload = registryPayload({ currency: 'JPY' })
    const entry = (payload['all_registry_entry'] as Record<string, Record<string, unknown>>[])[0]!['RegistryEntry']!
    entry['amount'] = { value: '-1500', currency: 'JPY' }
    expect(parseLedger(payload).entries[0]!.amount.minor).toBe(-1500)
  })
})

describe('fetchLedger', () => {
  it('picks the registry with the requested id', async () => {
    stub([{ json: { Response: [{ Registry: registryPayload({ id: 1 }) }, { Registry: registryPayload({ id: 555 }) }] } }])
    expect((await fetchLedger(DEVICE, SESSION, 555)).id).toBe(555)
  })

  it('fails clearly when the ledger is no longer attached', async () => {
    stub([{ json: { Response: [] } }])
    await expect(fetchLedger(DEVICE, SESSION, 555)).rejects.toThrow(/no longer attached/)
  })
})

describe('entryBody', () => {
  it('writes an expense as a negative decimal string', () => {
    const body = entryBody({
      description: 'Dinner', minor: -5420, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -2710, shareRatio: 1 }, { memberUuid: 'm-sam', minor: -2710, shareRatio: 1 }],
    }, 'USD', '11111111-2222-3333-4444-555555555555')
    expect(body['amount']).toEqual({ value: '-54.20', currency: 'USD' })
    expect(body['type_transaction']).toBe('NORMAL')
    expect(body['uuid']).toBe('11111111-2222-3333-4444-555555555555')
  })

  it('marks a ratio allocation as RATIO and carries its share', () => {
    const body = entryBody({
      description: 'Dinner', minor: -10000, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -6000, shareRatio: 3 }, { memberUuid: 'm-sam', minor: -4000, shareRatio: 2 }],
    }, 'USD')
    expect(body['allocations']).toEqual([
      { membership_uuid: 'm-alex', amount: { value: '-60.00', currency: 'USD' }, type: 'RATIO', share_ratio: 3 },
      { membership_uuid: 'm-sam', amount: { value: '-40.00', currency: 'USD' }, type: 'RATIO', share_ratio: 2 },
    ])
  })

  it('marks an allocation with no share as a fixed AMOUNT', () => {
    const body = entryBody({
      description: 'Dinner', minor: -5000, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -5000 }],
    }, 'USD')
    expect((body['allocations'] as Record<string, unknown>[])[0]).toEqual({
      membership_uuid: 'm-alex', amount: { value: '-50.00', currency: 'USD' }, type: 'AMOUNT',
    })
  })

  // The family means a day. Noon keeps that day stable whatever timezone the server
  // reads the timestamp in — midnight would not.
  it('times an entry at noon so the date cannot slip a day', () => {
    const body = entryBody({
      description: 'x', minor: -100, payerUuid: 'm', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm', minor: -100 }],
    }, 'USD')
    expect(body['date']).toBe('2026-08-22 12:00:00.000000')
  })

  it('clears a custom category when a standard one is set', () => {
    const body = entryBody({
      description: 'x', minor: -100, payerUuid: 'm', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm', minor: -100 }], category: 'GROCERIES',
    }, 'USD')
    expect(body['category']).toBe('GROCERIES')
    expect(body['category_custom']).toBe('')
  })

  it('forces the category to OTHER when a custom one is given, as the app does', () => {
    const body = entryBody({
      description: 'x', minor: -100, payerUuid: 'm', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm', minor: -100 }], categoryCustom: 'Coffee ☕️',
    }, 'USD')
    expect(body['category']).toBe('OTHER')
    expect(body['category_custom']).toBe('Coffee ☕️')
  })

  it('omits both category fields when neither is given', () => {
    const body = entryBody({
      description: 'x', minor: -100, payerUuid: 'm', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm', minor: -100 }],
    }, 'USD')
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('category_custom')
  })

  it('writes income as a positive amount', () => {
    const body = entryBody({
      description: 'Refund', minor: 3804, payerUuid: 'm-alex', type: 'INCOME', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: 1902, shareRatio: 1 }, { memberUuid: 'm-sam', minor: 1902, shareRatio: 1 }],
    }, 'USD')
    expect(body['amount']).toEqual({ value: '38.04', currency: 'USD' })
    expect(body['type_transaction']).toBe('INCOME')
  })
})

describe('createEntry', () => {
  it('posts to the registry-entry collection and returns the new id', async () => {
    const { sent } = stub([{ json: { Response: [{ Id: { id: 1234 } }] } }])
    const id = await createEntry(DEVICE, SESSION, 555, {
      description: 'Dinner', minor: -5000, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -5000 }],
    }, 'USD')
    expect(id).toBe(1234)
    expect(sent[0]!.method).toBe('POST')
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/user/4242/registry/555/registry-entry`)
  })

  it('fails clearly when the reply carries no id', async () => {
    stub([{ json: { Response: [{ Something: {} }] } }])
    await expect(createEntry(DEVICE, SESSION, 555, {
      description: 'x', minor: -1, payerUuid: 'm', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm', minor: -1 }],
    }, 'USD')).rejects.toThrow(/no entry id/)
  })
})

describe('updateEntry', () => {
  it('puts to the entry and drops the uuid, which addresses an existing row', async () => {
    const { sent } = stub([{ json: { Response: [{ Id: { id: 900 } }] } }])
    await updateEntry(DEVICE, SESSION, 555, 900, {
      description: 'Dinner out', minor: -6000, payerUuid: 'm-alex', type: 'NORMAL', day: '2026-08-22',
      allocations: [{ memberUuid: 'm-alex', minor: -6000 }],
    }, 'USD')
    expect(sent[0]!.method).toBe('PUT')
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/user/4242/registry/555/registry-entry/900`)
    expect(sent[0]!.body).not.toHaveProperty('uuid')
  })
})

describe('deleteEntry', () => {
  it('deletes the entry', async () => {
    const { sent } = stub([{ status: 200, text: '' }])
    await deleteEntry(DEVICE, SESSION, 555, 900)
    expect(sent[0]!.method).toBe('DELETE')
    expect(sent[0]!.url).toBe(`${BASE_URL}/v1/user/4242/registry/555/registry-entry/900`)
  })

  it('accepts an empty body, which a delete often returns', async () => {
    stub([{ status: 204, text: '' }])
    await expect(deleteEntry(DEVICE, SESSION, 555, 900)).resolves.toBeUndefined()
  })
})

describe('stripRef', () => {
  it('removes the tag and tidies the space it leaves', () => {
    expect(stripRef('Shell gas [ref:pTxN123]')).toBe('Shell gas')
    expect(stripRef('Shell [ref:x] gas')).toBe('Shell gas')
  })

  it('leaves an untagged description alone', () => {
    expect(stripRef('Dinner out')).toBe('Dinner out')
  })

  it('copes with an empty description', () => {
    expect(stripRef('')).toBe('')
  })
})

/** Build a ledger from plain entry descriptions, for balance arithmetic. */
function ledgerOf(entries: {
  payer: string
  minor: number
  allocations: Record<string, number>
  type?: 'NORMAL' | 'INCOME' | 'BALANCE'
  status?: 'ACTIVE' | 'INACTIVE'
}[]): Ledger {
  return {
    id: 1, uuid: 'l', title: 'Household', currency: 'USD', token: 't', status: 'READ_WRITE',
    members: [
      { uuid: 'm-alex', id: 1, displayName: 'Alex', status: 'ACTIVE' },
      { uuid: 'm-sam', id: 2, displayName: 'Sam', status: 'ACTIVE' },
      { uuid: 'm-kit', id: 3, displayName: 'Kit', status: 'ACTIVE' },
    ],
    entries: entries.map((entry, index) => ({
      id: index + 1, uuid: `e${index}`, description: 'x', title: 'x',
      amount: { minor: entry.minor, currency: 'USD' },
      payerUuid: entry.payer,
      allocations: Object.entries(entry.allocations).map(([memberUuid, minor]) => ({
        memberUuid, amount: { minor, currency: 'USD' }, type: 'AMOUNT' as const,
      })),
      date: '2026-08-20 12:00:00.000000', day: '2026-08-20',
      status: entry.status ?? 'ACTIVE', type: entry.type ?? 'NORMAL',
    })),
  }
}

describe('computeBalances', () => {
  it('credits the payer and debits each share', () => {
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -2500, 'm-sam': -2500 } },
    ]))
    expect(balances.map(b => [b.member.displayName, b.minor])).toEqual([['Alex', 2500], ['Sam', -2500], ['Kit', 0]])
  })

  // The ledger is closed: every unit somebody is owed is owed by somebody.
  it('always sums to zero', () => {
    const ledger = ledgerOf([
      { payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -1667, 'm-sam': -1667, 'm-kit': -1666 } },
      { payer: 'm-sam', minor: -3333, allocations: { 'm-alex': -1111, 'm-sam': -1111, 'm-kit': -1111 } },
      { payer: 'm-kit', minor: 900, allocations: { 'm-alex': 300, 'm-sam': 300, 'm-kit': 300 }, type: 'INCOME' },
    ])
    expect(computeBalances(ledger).reduce((sum, b) => sum + b.minor, 0)).toBe(0)
  })

  /*
   * The defect this module exists to avoid. Taking abs() of every amount — as the
   * reference Python client does — makes an INCOME entry indistinguishable from an
   * expense, so a refund adds to the debt instead of clearing it.
   */
  it('makes a refund exactly invert its expense', () => {
    const expense = { payer: 'm-alex', minor: -3804, allocations: { 'm-alex': -1902, 'm-sam': -1902 } }
    const refund = {
      payer: 'm-alex', minor: 3804, allocations: { 'm-alex': 1902, 'm-sam': 1902 }, type: 'INCOME' as const,
    }
    const afterExpense = computeBalances(ledgerOf([expense]))
    const afterBoth = computeBalances(ledgerOf([expense, refund]))
    expect(afterExpense.map(b => b.minor)).toEqual([1902, -1902, 0])
    expect(afterBoth.map(b => b.minor)).toEqual([0, 0, 0])
  })

  it('does not double a debt when a refund is filed', () => {
    const expense = { payer: 'm-alex', minor: -3804, allocations: { 'm-alex': -1902, 'm-sam': -1902 } }
    const refund = {
      payer: 'm-alex', minor: 3804, allocations: { 'm-alex': 1902, 'm-sam': 1902 }, type: 'INCOME' as const,
    }
    const sam = computeBalances(ledgerOf([expense, refund])).find(b => b.member.displayName === 'Sam')!
    expect(sam.minor).not.toBe(-3804)
    expect(sam.minor).toBe(0)
  })

  it('ignores an inactive entry', () => {
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -2500, 'm-sam': -2500 }, status: 'INACTIVE' },
    ]))
    expect(balances.every(b => b.minor === 0)).toBe(true)
  })

  it('handles a settling-up payment with no special case', () => {
    // Sam pays Alex 25.00 directly: Sam's debt shrinks, Alex's credit shrinks.
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -2500, 'm-sam': -2500 } },
      { payer: 'm-sam', minor: -2500, allocations: { 'm-alex': -2500 }, type: 'BALANCE' },
    ]))
    expect(balances.map(b => b.minor)).toEqual([0, 0, 0])
  })

  it('ignores an allocation to somebody no longer on the ledger', () => {
    const ledger = ledgerOf([{ payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -2500, 'm-gone': -2500 } }])
    expect(computeBalances(ledger).find(b => b.member.displayName === 'Alex')!.minor).toBe(2500)
  })

  it('gives everyone zero on an empty ledger', () => {
    expect(computeBalances(ledgerOf([])).map(b => b.minor)).toEqual([0, 0, 0])
  })
})

describe('settleUp', () => {
  it('names who pays whom', () => {
    const payments = settleUp(computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -5000, allocations: { 'm-alex': -2500, 'm-sam': -2500 } },
    ])))
    expect(payments).toHaveLength(1)
    expect(payments[0]!.from.displayName).toBe('Sam')
    expect(payments[0]!.to.displayName).toBe('Alex')
    expect(payments[0]!.minor).toBe(2500)
  })

  it('suggests nothing when everybody is square', () => {
    expect(settleUp(computeBalances(ledgerOf([])))).toEqual([])
  })

  // The payments must actually clear the balances, not merely look plausible.
  it('produces payments that settle the ledger exactly', () => {
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -9000, allocations: { 'm-alex': -3000, 'm-sam': -3000, 'm-kit': -3000 } },
      { payer: 'm-sam', minor: -1500, allocations: { 'm-alex': -500, 'm-sam': -500, 'm-kit': -500 } },
    ]))
    const payments = settleUp(balances)
    const after = new Map(balances.map(b => [b.member.uuid, b.minor]))
    for (const payment of payments) {
      after.set(payment.from.uuid, (after.get(payment.from.uuid) ?? 0) + payment.minor)
      after.set(payment.to.uuid, (after.get(payment.to.uuid) ?? 0) - payment.minor)
    }
    expect([...after.values()].every(value => value === 0)).toBe(true)
  })

  it('needs no more payments than there are people', () => {
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -9000, allocations: { 'm-alex': -3000, 'm-sam': -3000, 'm-kit': -3000 } },
      { payer: 'm-sam', minor: -1500, allocations: { 'm-alex': -500, 'm-sam': -500, 'm-kit': -500 } },
    ]))
    expect(settleUp(balances).length).toBeLessThanOrEqual(3)
  })

  it('puts the largest payment first', () => {
    const balances = computeBalances(ledgerOf([
      { payer: 'm-alex', minor: -9000, allocations: { 'm-sam': -6000, 'm-kit': -3000 } },
    ]))
    const payments = settleUp(balances)
    expect(payments[0]!.minor).toBeGreaterThanOrEqual(payments[1]?.minor ?? 0)
  })
})
