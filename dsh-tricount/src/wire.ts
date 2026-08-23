/**
 * The Tricount (bunq) wire protocol, and the balance arithmetic over it.
 *
 * Tricount's app talks to a bunq host with an API that is unusual in one helpful
 * respect: **nothing is signed**. A device registers by posting a UUID and an RSA
 * public key, gets a session token back, and from then on it is plain REST with a
 * bearer-ish header. The public key is never used to verify anything the client
 * sends — the reference Python implementation generates a keypair and discards the
 * private half — so a client needs no crypto beyond producing a PKCS#1 public PEM,
 * which Node does natively. That is what makes speaking this protocol directly a
 * better option for the butler than shelling out to a Python CLI.
 *
 * Two conventions in the API matter more than anything else here, and both are
 * about signs:
 *
 *   * **Amounts are signed by meaning.** An expense is stored negative and income
 *     positive, in whole currency units as a decimal string. The sign is not
 *     decoration; it is how the ledger distinguishes money going out from money
 *     coming back.
 *   * **Balances must therefore be computed from the signed values.** The reference
 *     implementation takes the absolute value of every amount before adding it up,
 *     which discards exactly the information that tells a refund from a purchase —
 *     see {@link computeBalances}.
 *
 * @module
 */

import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { formatMinor, parseMinor } from './money.ts'
import { TricountError } from './types.ts'
import type {
  AllocationType,
  EntryAllocation,
  EntryStatus,
  EntryType,
  Ledger,
  LedgerEntry,
  LedgerMember,
} from './types.ts'

/** Where the Tricount app's API lives. */
export const BASE_URL = 'https://api.tricount.bunq.com'

/**
 * The client string the app sends.
 *
 * Kept byte-identical to the Android app's, because an API that is reached by
 * pretending to be that app is an API that may well check.
 */
export const USER_AGENT = 'com.bunq.tricount.android:RELEASE:7.0.7:3174:ANDROID:13:C'

/** The tag the bank-feed agent writes into descriptions to make its rows idempotent. */
export const REF_PATTERN = /\[ref:([^\]]+)\]/

/**
 * A registered device: the identity a session is opened with.
 *
 * Both halves must be **stable across restarts**. A new `appId` registers a new
 * anonymous user, which still works — the ledger is reachable by its sharing token
 * — but leaves an orphaned user behind on every boot and loses the link between the
 * session and a member of the ledger. So these are configuration, not something to
 * regenerate on a whim.
 */
export interface Device {
  /** The installation UUID. Stable per deployment. */
  readonly appId: string
  /** An RSA public key in PKCS#1 PEM form. Its private half is never needed. */
  readonly publicKeyPem: string
}

/**
 * Mint a fresh device identity.
 *
 * The private key is generated and immediately dropped, which looks wrong and is
 * not: the protocol never asks the client to prove possession of it. Generating a
 * real keypair rather than inventing a PEM-shaped string is what makes the
 * registration acceptable to the host.
 *
 * @returns a device identity to persist and reuse.
 */
export function generateDevice(): Device {
  const { publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  })
  return { appId: randomUUID(), publicKeyPem: publicKey }
}

/** An open session: what every subsequent request needs. */
export interface Session {
  /** The session token, sent as `X-Bunq-Client-Authentication`. */
  readonly token: string
  /** Our numeric user id, which appears in every path. */
  readonly userId: number
}

/**
 * Test seam. Substitute `fetch` to exercise the protocol without a network.
 *
 * Kept as a mutable object rather than a parameter so that the service's own call
 * sites stay readable, matching how `dsh-mail` substitutes its SDK loader.
 */
export const internals = {
  /** The HTTP transport. */
  fetch: (...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args),
}

/** One HTTP call, described in terms this module can log and test. */
interface Call {
  /** Operation name, for the event log. */
  readonly operation: string
  /** HTTP method. */
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Path below the base URL, starting with a slash. */
  readonly path: string
  /** JSON body, when there is one. */
  readonly body?: unknown
  /** The session, for authenticated calls. */
  readonly session?: Session
  /** The device, whose appId is sent on every request. */
  readonly device: Device
  /** Called with the outcome, whether or not it succeeded. */
  readonly report?: (event: {
    operation: string
    method: string
    path: string
    status?: number
    durationMs: number
    ok: boolean
    error?: string
  }) => void
}

/**
 * Make one request and return the parsed `Response` array.
 *
 * Every bunq reply is `{"Response": [...]}` — a list of single-key objects whose
 * key names the type. The envelope is unwrapped here so no caller has to know it.
 *
 * @param call - what to send.
 * @returns the items inside the `Response` array. Empty for a 204.
 * @throws TricountError with `transport-failed` for a network failure or error status,
 *   or `unexpected-response` when the body is not the expected envelope.
 */
async function request(call: Call): Promise<unknown[]> {
  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    'app-id': call.device.appId,
    'X-Bunq-Client-Request-Id': randomUUID(),
    'Content-Type': 'application/json',
  }
  if (call.session !== undefined) headers['X-Bunq-Client-Authentication'] = call.session.token

  const started = Date.now()
  let status: number | undefined
  try {
    const response = await internals.fetch(`${BASE_URL}${call.path}`, {
      method: call.method,
      headers,
      ...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
    })
    status = response.status
    if (!response.ok) {
      const detail = await readErrorDetail(response)
      throw new TricountError(
        'transport-failed',
        `Tricount ${call.operation} failed with HTTP ${response.status}${detail !== undefined ? `: ${detail}` : ''}`,
      )
    }
    if (response.status === 204) {
      call.report?.({ operation: call.operation, method: call.method, path: call.path, status, durationMs: Date.now() - started, ok: true })
      return []
    }
    const text = await response.text()
    // A delete replies 200 with an empty body often enough to be normal.
    if (text.trim() === '') {
      call.report?.({ operation: call.operation, method: call.method, path: call.path, status, durationMs: Date.now() - started, ok: true })
      return []
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (cause) {
      throw new TricountError('unexpected-response', `Tricount ${call.operation} returned a body that is not JSON`, { cause })
    }
    const items = (parsed as { Response?: unknown }).Response
    if (!Array.isArray(items)) {
      throw new TricountError('unexpected-response', `Tricount ${call.operation} returned no Response list`)
    }
    call.report?.({ operation: call.operation, method: call.method, path: call.path, status, durationMs: Date.now() - started, ok: true })
    return items
  } catch (error) {
    const code = error instanceof TricountError ? error.code : 'transport-failed'
    call.report?.({
      operation: call.operation, method: call.method, path: call.path,
      ...(status !== undefined ? { status } : {}),
      durationMs: Date.now() - started, ok: false, error: code,
    })
    if (error instanceof TricountError) throw error
    throw new TricountError('transport-failed', `Tricount ${call.operation} could not reach the server: ${describe(error)}`, { cause: error })
  }
}

/**
 * Pull a human-usable sentence out of an error response, without letting the
 * attempt itself become a second failure.
 *
 * @param response - the failed response.
 * @returns a short description, or undefined if the body says nothing useful.
 */
async function readErrorDetail(response: Response): Promise<string | undefined> {
  try {
    const body = await response.text()
    if (body.trim() === '') return undefined
    const parsed = JSON.parse(body) as { Error?: { error_description?: string }[] }
    const described = parsed.Error?.[0]?.error_description
    if (typeof described === 'string' && described !== '') return described
    return body.length > 200 ? `${body.slice(0, 200)}…` : body
  } catch {
    return undefined
  }
}

/**
 * Describe an unknown thrown value for a message.
 *
 * @param error - whatever was caught.
 * @returns its message, or its string form.
 */
export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Open a session for a device.
 *
 * @param device - the identity to register.
 * @param report - optional event sink.
 * @returns the session token and our user id.
 * @throws TricountError `auth-failed` when the reply carries no token or user.
 */
export async function openSession(device: Device, report?: Call['report']): Promise<Session> {
  const items = await request({
    operation: 'authenticate',
    method: 'POST',
    path: '/v1/session-registry-installation',
    body: {
      app_installation_uuid: device.appId,
      client_public_key: device.publicKeyPem,
      device_description: 'Android',
    },
    device,
    ...(report !== undefined ? { report } : {}),
  })
  let token: string | undefined
  let userId: number | undefined
  for (const item of items) {
    const record = item as Record<string, { token?: unknown; id?: unknown }>
    if (record['Token']?.token !== undefined) token = String(record['Token'].token)
    if (record['UserPerson']?.id !== undefined) userId = Number(record['UserPerson'].id)
  }
  if (token === undefined || userId === undefined || !Number.isFinite(userId)) {
    throw new TricountError('auth-failed', 'Tricount accepted the device but returned no session token — the API may have changed')
  }
  return { token, userId }
}

/**
 * Attach a ledger to our account by its sharing token, so we can write to it.
 *
 * Anyone holding the sharing link can do this; it is how the app's "join by link"
 * works. Joining is idempotent — an already-attached ledger simply comes back again
 * — so this is safe to call on every connect rather than tracked as state.
 *
 * @param device - our identity.
 * @param session - an open session.
 * @param token - the public sharing token, e.g. `tABC123xyz`.
 * @param report - optional event sink.
 * @returns the ledger's numeric registry id.
 * @throws TricountError `ledger-not-found` when the token matches nothing.
 */
export async function joinLedger(device: Device, session: Session, token: string, report?: Call['report']): Promise<number> {
  const items = await request({
    operation: 'join',
    method: 'POST',
    path: `/v1/user/${session.userId}/registry-synchronization`,
    body: {
      all_registry_active: [{ public_identifier_token: token }],
      all_registry_archived: [],
      all_registry_deleted: [],
    },
    device,
    session,
    ...(report !== undefined ? { report } : {}),
  })
  for (const item of items) {
    const sync = (item as Record<string, { all_registry_active?: unknown[] }>)['RegistrySynchronization']
    for (const registry of sync?.all_registry_active ?? []) {
      const record = registry as { public_identifier_token?: string; id?: number }
      if (record.public_identifier_token === token && typeof record.id === 'number') return record.id
    }
  }
  throw new TricountError(
    'ledger-not-found',
    `No Tricount ledger answers to that sharing token — check the token from the app's "Share" link`,
  )
}

/**
 * Fetch one ledger in full, including every entry.
 *
 * @param device - our identity.
 * @param session - an open session.
 * @param ledgerId - the registry id from {@link joinLedger}.
 * @param report - optional event sink.
 * @returns the parsed ledger.
 * @throws TricountError `ledger-not-found` when the id is not among our registries.
 */
export async function fetchLedger(device: Device, session: Session, ledgerId: number, report?: Call['report']): Promise<Ledger> {
  const items = await request({
    operation: 'fetch',
    method: 'GET',
    path: `/v1/user/${session.userId}/registry`,
    device,
    session,
    ...(report !== undefined ? { report } : {}),
  })
  for (const item of items) {
    const registry = (item as Record<string, Record<string, unknown>>)['Registry']
    if (registry !== undefined && Number(registry['id']) === ledgerId) return parseLedger(registry)
  }
  throw new TricountError('ledger-not-found', `Tricount ledger ${ledgerId} is no longer attached to this account`)
}

/**
 * Read a registry object into a {@link Ledger}.
 *
 * Exported because the parse is the part most likely to drift when the API changes,
 * and it is worth testing against recorded payloads without a network.
 *
 * @param registry - the `Registry` object from a response.
 * @returns the ledger, with entries parsed and `[ref:...]` tags extracted.
 */
export function parseLedger(registry: Record<string, unknown>): Ledger {
  const currency = String(registry['currency'] ?? 'USD')
  const members: LedgerMember[] = []
  for (const wrapper of asArray(registry['memberships'])) {
    for (const value of Object.values(wrapper as Record<string, unknown>)) {
      const member = parseMember(value as Record<string, unknown>)
      if (member !== undefined) members.push(member)
    }
  }
  const entries: LedgerEntry[] = []
  for (const wrapper of asArray(registry['all_registry_entry'])) {
    const record = wrapper as Record<string, unknown>
    const entry = record['RegistryEntry']
    if (entry === undefined) continue
    const parsed = parseEntry(entry as Record<string, unknown>, currency)
    if (parsed !== undefined) entries.push(parsed)
  }
  return {
    id: Number(registry['id'] ?? 0),
    uuid: String(registry['uuid'] ?? ''),
    title: String(registry['title'] ?? ''),
    currency,
    token: String(registry['public_identifier_token'] ?? ''),
    members,
    entries,
    status: String(registry['status'] ?? 'READ_WRITE'),
  }
}

/**
 * Read one membership object.
 *
 * @param data - the membership record.
 * @returns the member, or undefined when it carries no uuid to refer to it by.
 */
function parseMember(data: Record<string, unknown>): LedgerMember | undefined {
  const uuid = data['uuid']
  if (typeof uuid !== 'string' || uuid === '') return undefined
  const alias = (data['alias'] ?? {}) as Record<string, unknown>
  const displayName = alias['display_name']
  return {
    uuid,
    id: Number(data['id'] ?? 0),
    displayName: typeof displayName === 'string' && displayName !== '' ? displayName : uuid,
    status: String(data['status'] ?? 'ACTIVE'),
  }
}

/**
 * Read one registry entry.
 *
 * The owner uuid and each allocation's member uuid appear in two different shapes
 * depending on whether the object came back from a read or is echoing a write, so
 * both are accepted.
 *
 * @param data - the entry record.
 * @param currency - the ledger currency, since amounts do not always carry one.
 * @returns the entry, or undefined when it has no id and so cannot be addressed.
 */
function parseEntry(data: Record<string, unknown>, currency: string): LedgerEntry | undefined {
  const id = Number(data['id'])
  if (!Number.isFinite(id) || id === 0) return undefined
  const description = String(data['description'] ?? '')
  const ref = REF_PATTERN.exec(description)?.[1]
  const date = String(data['date'] ?? '')
  const allocations: EntryAllocation[] = []
  for (const raw of asArray(data['allocations'])) {
    const record = raw as Record<string, unknown>
    const memberUuid = readMemberUuid(record)
    if (memberUuid === undefined) continue
    const shareRatio = record['share_ratio']
    allocations.push({
      memberUuid,
      amount: readAmount(record['amount'], currency),
      type: readAllocationType(record['type']),
      ...(typeof shareRatio === 'number' ? { shareRatio } : {}),
    })
  }
  const category = data['category']
  const categoryCustom = data['category_custom']
  return {
    id,
    uuid: String(data['uuid'] ?? ''),
    description,
    title: stripRef(description),
    ...(ref !== undefined ? { ref } : {}),
    amount: readAmount(data['amount'], currency),
    payerUuid: readOwnerUuid(data),
    allocations,
    date,
    day: date.slice(0, 10),
    status: readStatus(data['status']),
    type: readType(data['type_transaction']),
    ...(typeof category === 'string' && category !== '' ? { category } : {}),
    ...(typeof categoryCustom === 'string' && categoryCustom !== '' ? { categoryCustom } : {}),
  }
}

/**
 * Find the owning member's uuid, in either the read or the write shape.
 *
 * @param data - the entry record.
 * @returns the uuid, or an empty string when the entry names no owner.
 */
function readOwnerUuid(data: Record<string, unknown>): string {
  const direct = data['membership_uuid_owner']
  if (typeof direct === 'string' && direct !== '') return direct
  const owned = (data['membership_owned'] ?? {}) as Record<string, unknown>
  for (const value of Object.values(owned)) {
    const uuid = (value as Record<string, unknown>)['uuid']
    if (typeof uuid === 'string' && uuid !== '') return uuid
  }
  return ''
}

/**
 * Find an allocation's member uuid, in either shape.
 *
 * @param data - the allocation record.
 * @returns the uuid, or undefined when there is none.
 */
function readMemberUuid(data: Record<string, unknown>): string | undefined {
  const direct = data['membership_uuid']
  if (typeof direct === 'string' && direct !== '') return direct
  const nested = (data['membership'] ?? {}) as Record<string, unknown>
  for (const value of Object.values(nested)) {
    const uuid = (value as Record<string, unknown>)['uuid']
    if (typeof uuid === 'string' && uuid !== '') return uuid
  }
  return undefined
}

/**
 * Read an `{value, currency}` object into minor units.
 *
 * An unreadable amount becomes zero rather than throwing, because one malformed
 * entry should not make the whole ledger unreadable — the same reasoning that makes
 * the chore reader skip an object it cannot parse.
 *
 * @param raw - the amount object.
 * @param fallbackCurrency - used when the object names no currency.
 * @returns the amount in minor units.
 */
function readAmount(raw: unknown, fallbackCurrency: string): { minor: number; currency: string } {
  const record = (raw ?? {}) as Record<string, unknown>
  const currency = typeof record['currency'] === 'string' && record['currency'] !== ''
    ? record['currency']
    : fallbackCurrency
  const value = record['value']
  if (typeof value !== 'string' && typeof value !== 'number') return { minor: 0, currency }
  try {
    return { minor: parseMinor(String(value), currency), currency }
  } catch {
    return { minor: 0, currency }
  }
}

/**
 * Narrow a status string, defaulting to ACTIVE.
 *
 * @param raw - the status field.
 * @returns a known status.
 */
function readStatus(raw: unknown): EntryStatus {
  return raw === 'INACTIVE' || raw === 'SETTLED' ? raw : 'ACTIVE'
}

/**
 * Narrow an entry type, defaulting to an expense.
 *
 * @param raw - the `type_transaction` field.
 * @returns a known type.
 */
function readType(raw: unknown): EntryType {
  return raw === 'INCOME' || raw === 'BALANCE' ? raw : 'NORMAL'
}

/**
 * Narrow an allocation type, defaulting to a fixed amount.
 *
 * @param raw - the allocation `type` field.
 * @returns a known allocation type.
 */
function readAllocationType(raw: unknown): AllocationType {
  return raw === 'RATIO' ? 'RATIO' : 'AMOUNT'
}

/**
 * Coerce a field that should be a list into one.
 *
 * @param value - the field.
 * @returns the array, or an empty one.
 */
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/**
 * Remove a `[ref:...]` tag and tidy the space it leaves.
 *
 * The tag is bookkeeping for the bank-feed agent, so a person should never see it,
 * but the raw description is kept alongside because that is what the other agent
 * matches on.
 *
 * @param description - the stored description.
 * @returns the description without the tag.
 */
export function stripRef(description: string): string {
  return description.replace(REF_PATTERN, '').replace(/\s{2,}/g, ' ').trim()
}

/** An allocation to write, before it becomes JSON. */
export interface AllocationInput {
  /** Which member. */
  readonly memberUuid: string
  /** Their share in minor units, signed to match the entry. */
  readonly minor: number
  /** The relative part, when filing as a ratio. */
  readonly shareRatio?: number
}

/** Everything needed to write one entry. */
export interface EntryInput {
  /** The description, including any tag the caller wants stored. */
  readonly description: string
  /** The total in minor units, signed: negative for an expense, positive for income. */
  readonly minor: number
  /** Who paid, or who received. */
  readonly payerUuid: string
  /** How it is shared out. Must sum to `minor`. */
  readonly allocations: readonly AllocationInput[]
  /** Expense, income, or settling up. */
  readonly type: EntryType
  /** The day, `YYYY-MM-DD`. */
  readonly day: string
  /** A standard category, when one applies. */
  readonly category?: string
  /** A free-text category. Setting this forces `category` to OTHER, as the app does. */
  readonly categoryCustom?: string
  /** Keep an existing status when editing; defaults to ACTIVE. */
  readonly status?: EntryStatus
}

/**
 * Build the JSON body for an entry.
 *
 * Exported so a test can assert the exact payload — the sign convention and the
 * `share_ratio` on each allocation are the two things most worth pinning, because
 * getting either wrong produces a ledger that looks plausible and is wrong.
 *
 * @param input - the entry to write.
 * @param currency - the ledger currency.
 * @param uuid - the entry uuid; supplied so a test can pin it.
 * @returns the request body.
 */
export function entryBody(input: EntryInput, currency: string, uuid = randomUUID()): Record<string, unknown> {
  const allocations = input.allocations.map((allocation) => ({
    membership_uuid: allocation.memberUuid,
    amount: { value: formatMinor(allocation.minor, currency), currency },
    type: allocation.shareRatio !== undefined ? 'RATIO' : 'AMOUNT',
    ...(allocation.shareRatio !== undefined ? { share_ratio: allocation.shareRatio } : {}),
  }))
  const body: Record<string, unknown> = {
    uuid,
    description: input.description,
    amount: { value: formatMinor(input.minor, currency), currency },
    membership_uuid_owner: input.payerUuid,
    allocations,
    type_transaction: input.type,
    status: input.status ?? 'ACTIVE',
    // The API wants a timestamp; the family only ever means a day, so noon keeps the
    // date stable under any timezone interpretation the server might apply.
    date: `${input.day} 12:00:00.000000`,
  }
  if (input.categoryCustom !== undefined && input.categoryCustom !== '') {
    body['category'] = 'OTHER'
    body['category_custom'] = input.categoryCustom
  } else if (input.category !== undefined && input.category !== '') {
    body['category'] = input.category
    body['category_custom'] = ''
  }
  return body
}

/**
 * Create an entry on the ledger.
 *
 * @param device - our identity.
 * @param session - an open session.
 * @param ledgerId - the registry id.
 * @param input - the entry.
 * @param currency - the ledger currency.
 * @param report - optional event sink.
 * @returns the new entry's numeric id.
 * @throws TricountError `unexpected-response` when the reply carries no id.
 */
export async function createEntry(
  device: Device, session: Session, ledgerId: number,
  input: EntryInput, currency: string, report?: Call['report'],
): Promise<number> {
  const items = await request({
    operation: 'create-entry',
    method: 'POST',
    path: `/v1/user/${session.userId}/registry/${ledgerId}/registry-entry`,
    body: entryBody(input, currency),
    device,
    session,
    ...(report !== undefined ? { report } : {}),
  })
  return extractId(items, 'create-entry')
}

/**
 * Replace an entry on the ledger.
 *
 * The API's update is a full replacement, not a patch, so callers must send a
 * complete entry. That is why the service reads the current row first and merges.
 *
 * @param device - our identity.
 * @param session - an open session.
 * @param ledgerId - the registry id.
 * @param entryId - which entry to replace.
 * @param input - the complete replacement.
 * @param currency - the ledger currency.
 * @param report - optional event sink.
 */
export async function updateEntry(
  device: Device, session: Session, ledgerId: number, entryId: number,
  input: EntryInput, currency: string, report?: Call['report'],
): Promise<void> {
  const body = entryBody(input, currency)
  // An update addresses an existing row; sending a fresh uuid would ask the server
  // to reconcile two identities for one entry.
  delete body['uuid']
  await request({
    operation: 'update-entry',
    method: 'PUT',
    path: `/v1/user/${session.userId}/registry/${ledgerId}/registry-entry/${entryId}`,
    body,
    device,
    session,
    ...(report !== undefined ? { report } : {}),
  })
}

/**
 * Delete an entry from the ledger.
 *
 * @param device - our identity.
 * @param session - an open session.
 * @param ledgerId - the registry id.
 * @param entryId - which entry to remove.
 * @param report - optional event sink.
 */
export async function deleteEntry(
  device: Device, session: Session, ledgerId: number, entryId: number, report?: Call['report'],
): Promise<void> {
  await request({
    operation: 'delete-entry',
    method: 'DELETE',
    path: `/v1/user/${session.userId}/registry/${ledgerId}/registry-entry/${entryId}`,
    device,
    session,
    ...(report !== undefined ? { report } : {}),
  })
}

/**
 * Pull the created id out of a write reply.
 *
 * @param items - the unwrapped `Response` list.
 * @param operation - for the error message.
 * @returns the id.
 * @throws TricountError `unexpected-response` when there is none.
 */
function extractId(items: readonly unknown[], operation: string): number {
  for (const item of items) {
    const id = (item as Record<string, { id?: unknown }>)['Id']?.id
    if (id !== undefined && Number.isFinite(Number(id))) return Number(id)
  }
  throw new TricountError('unexpected-response', `Tricount ${operation} succeeded but returned no entry id`)
}

/** What one member is owed, or owes. */
export interface Balance {
  /** The member. */
  readonly member: LedgerMember
  /**
   * Their position in minor units. Positive means the household owes them;
   * negative means they owe the household.
   */
  readonly minor: number
}

/**
 * Work out where everybody stands.
 *
 * The arithmetic uses the **signed** amounts the API stores, and that is the whole
 * point of this function. The reference Python implementation takes `abs()` of every
 * amount first, which erases the only thing distinguishing an expense from money
 * coming back, and so treats a refund as a second purchase:
 *
 *     Alex pays 38.04, split evenly    → Alex +19.02, Sam −19.02
 *     the shop refunds Alex 38.04      → should return both to zero
 *     with abs():                        Alex +38.04, Sam −38.04   (debt doubled)
 *     with the stored signs:             Alex 0, Sam 0             (cancelled)
 *
 * Reading the signs also makes the formula uniform: every entry type is "the owner
 * put this much in, and each member took their share out", with the signs deciding
 * which direction that is. A settling-up payment needs no special case.
 *
 * @param ledger - the ledger snapshot.
 * @returns one balance per member, in the ledger's member order. Sums to zero.
 */
export function computeBalances(ledger: Ledger): Balance[] {
  const totals = new Map<string, number>(ledger.members.map(member => [member.uuid, 0]))
  for (const entry of ledger.entries) {
    if (entry.status !== 'ACTIVE') continue
    if (totals.has(entry.payerUuid)) {
      totals.set(entry.payerUuid, (totals.get(entry.payerUuid) ?? 0) - entry.amount.minor)
    }
    for (const allocation of entry.allocations) {
      if (!totals.has(allocation.memberUuid)) continue
      totals.set(allocation.memberUuid, (totals.get(allocation.memberUuid) ?? 0) + allocation.amount.minor)
    }
  }
  return ledger.members.map(member => ({ member, minor: totals.get(member.uuid) ?? 0 }))
}

/** One payment that would move the household towards settled. */
export interface Settlement {
  /** Who should pay. */
  readonly from: LedgerMember
  /** Who should be paid. */
  readonly to: LedgerMember
  /** How much, in minor units. Always positive. */
  readonly minor: number
}

/**
 * Suggest the payments that would clear the balances.
 *
 * Greedy largest-debtor-to-largest-creditor, which for a household of two or three
 * is optimal and for larger groups is within one payment of it. Minimising payment
 * count exactly is NP-hard and not worth it here: what the family wants is "who
 * pays whom", and one extra transfer among five people is not a real cost.
 *
 * @param balances - from {@link computeBalances}.
 * @returns the payments, largest first. Empty when everyone is square.
 */
export function settleUp(balances: readonly Balance[]): Settlement[] {
  const debtors = balances.filter(balance => balance.minor < 0)
    .map(balance => ({ member: balance.member, left: -balance.minor }))
    .sort((a, b) => b.left - a.left)
  const creditors = balances.filter(balance => balance.minor > 0)
    .map(balance => ({ member: balance.member, left: balance.minor }))
    .sort((a, b) => b.left - a.left)

  const payments: Settlement[] = []
  let debtorIndex = 0
  let creditorIndex = 0
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex]!
    const creditor = creditors[creditorIndex]!
    const amount = Math.min(debtor.left, creditor.left)
    if (amount > 0) payments.push({ from: debtor.member, to: creditor.member, minor: amount })
    debtor.left -= amount
    creditor.left -= amount
    if (debtor.left === 0) debtorIndex += 1
    if (creditor.left === 0) creditorIndex += 1
  }
  return payments
}
