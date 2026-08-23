/**
 * Service Definition and single runtime of the shared-expense capability seam
 * (`ctx.tricount`): one household ledger, read and written over the Tricount API.
 *
 * This is the transport half of a pair, the same shape as `dsh-caldav` beneath
 * `dsh-chores`: it knows about sessions, sharing tokens and signed decimal strings,
 * and knows nothing about who the family is or what a sensible split looks like.
 * `dsh-expenses` supplies that.
 *
 * Two custody notes:
 *
 * The **sharing token** is a credential, not an identifier. Anyone holding it can
 * read and write the ledger, which is exactly how the app's share-by-link works. So
 * it is configured as a credential *reference* and resolved per connect, never
 * pasted into config, and never included in an event.
 *
 * The **device identity** must be stable across restarts. A fresh `appId` registers
 * a new anonymous user every boot: the ledger is still reachable, but each restart
 * leaves an orphan behind. So the device is configuration too. Absent one, the seam
 * mints a device and reports it once through `tricount/device` so the operator can
 * write it down — rather than silently generating a new identity forever.
 *
 * @module dsh-tricount
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import {
  computeBalances,
  createEntry,
  deleteEntry,
  fetchLedger,
  generateDevice,
  joinLedger,
  openSession,
  settleUp,
  stripRef,
  updateEntry,
} from './wire.ts'
import type { Balance, Device, EntryInput, Session, Settlement } from './wire.ts'
import { TricountError } from './types.ts'
import type { Ledger, LedgerEntry, LedgerMember, TricountErrorCode } from './types.ts'
// Type-only: carries the `tricount/request` and `tricount/device` event declarations.
import type {} from './types.ts'

export { TricountError, asCategory, ENTRY_CATEGORIES } from './types.ts'
export type {
  AllocationType,
  EntryAllocation,
  EntryCategory,
  EntryStatus,
  EntryType,
  Ledger,
  LedgerEntry,
  LedgerMember,
  TricountErrorCode,
  TricountRequestEvent,
} from './types.ts'
export {
  BASE_URL,
  REF_PATTERN,
  computeBalances,
  entryBody,
  generateDevice,
  internals,
  parseLedger,
  settleUp,
  stripRef,
} from './wire.ts'
export type {
  AllocationInput,
  Balance,
  Device,
  EntryInput,
  Session,
  Settlement,
} from './wire.ts'
export {
  DEFAULT_EXPONENT,
  MoneyError,
  exponentOf,
  formatMinor,
  formatMoney,
  gcd,
  parseMinor,
  reduceToParts,
  requireHundred,
  round2,
  splitByRatio,
} from './money.ts'
export type { Money, Share } from './money.ts'

/**
 * How long a fetched ledger may be reused.
 *
 * Short, because the bank-feed agent writes to the same ledger and a stale snapshot
 * would make the butler answer "what have we spent" with yesterday's total. Long
 * enough that reading the ledger, deciding, and writing does not re-fetch three
 * times within one tool call.
 */
export const LEDGER_TTL_MS = 30_000

/** How long a session token is assumed good for before a fresh one is opened. */
export const SESSION_TTL_MS = 30 * 60_000

/** Configuration as an operator writes it. */
export interface TricountConfigDescriptor {
  /**
   * Credential reference naming the ledger's public sharing token — a name to look
   * up, not the token itself. The token grants full read and write access to the
   * ledger, so it is treated as the secret it is.
   */
  tokenRef: string
  /**
   * The device installation UUID. Must be stable across restarts; a new one
   * registers a new anonymous user each boot. Omit only for a first run, then copy
   * the value the seam reports and set it here.
   */
  appId?: string
  /**
   * Credential reference naming the device's RSA public key in PKCS#1 PEM form.
   * Paired with `appId`. Not secret in any cryptographic sense — the protocol never
   * uses it to verify anything — but it is bulky and identity-bearing, so it lives
   * with the credentials rather than in config.
   */
  publicKeyRef?: string
}

/** Configuration after validation. */
export interface TricountConfig {
  /** Reference to the sharing token. */
  readonly tokenRef: CredentialRef
  /** The stable device UUID, when one is configured. */
  readonly appId?: string
  /** Reference to the device public key, when one is configured. */
  readonly publicKeyRef?: CredentialRef
}

/** The validation schema. */
export const Config: z<TricountConfigDescriptor> = z.object({
  tokenRef: z.string().required().description(
    'Credential reference naming the Tricount sharing token (from the app\'s Share link). '
    + 'A reference, not the token — the token grants full write access to the ledger.',
  ),
  appId: z.string().description(
    'Stable device installation UUID. Omit on a first run and copy the value the seam reports.',
  ),
  publicKeyRef: z.string().description(
    'Credential reference naming the device RSA public key (PKCS#1 PEM), paired with appId.',
  ),
}).description('The household\'s shared expense ledger.')

/**
 * Validate configuration, refusing a pasted secret.
 *
 * A sharing token looks like `tABC123xyz`, and someone will paste one into
 * `tokenRef` sooner or later. Catching it at load turns a secret in a config file —
 * which then reaches logs, backups and version control — into a startup error.
 *
 * @param descriptor - configuration as written.
 * @returns the validated configuration.
 * @throws TricountError `invalid-request` when a reference looks like a token.
 */
export function resolveConfig(descriptor: TricountConfigDescriptor): TricountConfig {
  let tokenRef: CredentialRef
  try {
    tokenRef = credentialRef(descriptor.tokenRef)
  } catch (cause) {
    throw new TricountError(
      'invalid-request',
      `tokenRef "${descriptor.tokenRef}" is not a credential reference. It must name a credential `
      + '(for example "TRICOUNT_TOKEN"), not contain the sharing token itself.',
      { cause },
    )
  }
  // A token starts with 't' and is a long run of letters and digits with no separator.
  if (/^t[A-Za-z0-9]{8,}$/.test(descriptor.tokenRef)) {
    throw new TricountError(
      'invalid-request',
      'tokenRef looks like an actual Tricount sharing token rather than a reference to one. '
      + 'Store the token with your credential provider and name it here.',
    )
  }
  let publicKeyRef: CredentialRef | undefined
  if (descriptor.publicKeyRef !== undefined && descriptor.publicKeyRef !== '') {
    if (descriptor.publicKeyRef.includes('BEGIN')) {
      throw new TricountError(
        'invalid-request',
        'publicKeyRef contains a PEM body rather than a reference to one. Store the key with your '
        + 'credential provider and name it here.',
      )
    }
    publicKeyRef = credentialRef(descriptor.publicKeyRef)
  }
  return {
    tokenRef,
    ...(descriptor.appId !== undefined && descriptor.appId !== '' ? { appId: descriptor.appId } : {}),
    ...(publicKeyRef !== undefined ? { publicKeyRef } : {}),
  }
}

/** What an edit changes. Anything omitted is left exactly as it was. */
export interface EntryPatch {
  /** New description, with no `[ref:...]` tag; any existing tag is preserved separately. */
  readonly title?: string
  /** New total in minor units, unsigned — the seam applies the entry's own sign. */
  readonly amountMinor?: number
  /** New payer's membership uuid. */
  readonly payerUuid?: string
  /** New day, `YYYY-MM-DD`. */
  readonly day?: string
  /** New standard category. */
  readonly category?: string
  /**
   * A new split, as relative parts per member uuid. Omit to keep the existing split
   * — including its ratios, which is the behaviour that matters when only the total
   * changes.
   */
  readonly split?: readonly { memberUuid: string; parts: number }[]
}

/**
 * The shared-expense seam.
 *
 * One instance serves one ledger. A household with two ledgers would run two
 * plugin rows, the same way two CalDAV servers are two rows.
 */
export class Tricount extends Service {
  /** The credential store, resolved per connect so a rotation needs no restart. */
  static inject = ['credentials'] as const

  /** Validated configuration. */
  private readonly settings: TricountConfig

  /** The device identity, resolved or minted on first connect. */
  private device: Device | undefined

  /** The open session, with when it was opened. */
  private session: { session: Session; at: number } | undefined

  /** The ledger's registry id, once joined. */
  private ledgerId: number | undefined

  /** The last fetched snapshot, with when it was fetched. */
  private snapshot: { ledger: Ledger; at: number } | undefined

  /** Whether the minted-device notice has been emitted, so it is said once. */
  private warnedAboutDevice = false

  /**
   * @param ctx - the cordis context.
   * @param config - configuration as written by an operator.
   */
  constructor(ctx: Context, config: TricountConfigDescriptor) {
    super(ctx, 'tricount')
    this.settings = resolveConfig(Config(config))
  }

  /**
   * Report one request through the event bus.
   *
   * cordis contexts carry no logger, so events are the only channel. Amounts are
   * deliberately never included: an event stream recording what the family spends
   * would be a second copy of the ledger sitting in the logs.
   *
   * @returns a sink to hand to the wire functions.
   */
  private reporter(): (event: {
    operation: string; method: string; path: string
    status?: number; durationMs: number; ok: boolean; error?: string
  }) => void {
    return (event) => {
      this.ctx.emit('tricount/request', {
        operation: event.operation,
        method: event.method,
        path: event.path,
        ...(event.status !== undefined ? { status: event.status } : {}),
        durationMs: event.durationMs,
        ok: event.ok,
        ...(event.error !== undefined ? { error: event.error as TricountErrorCode } : {}),
      })
    }
  }

  /**
   * Resolve the device identity, minting one only as a last resort.
   *
   * @returns the device to register with.
   */
  private async resolveDevice(): Promise<Device> {
    if (this.device !== undefined) return this.device
    if (this.settings.appId !== undefined && this.settings.publicKeyRef !== undefined) {
      const resolved = await this.ctx.credentials.resolve(this.settings.publicKeyRef)
      if (resolved === undefined) {
        throw new TricountError(
          'credential-unconfigured',
          `Tricount publicKeyRef "${this.settings.publicKeyRef}" resolves to no value — store the device `
          + 'public key with your credential provider, or drop both appId and publicKeyRef to have one minted.',
        )
      }
      this.device = { appId: this.settings.appId, publicKeyPem: resolved.value }
      return this.device
    }
    this.device = generateDevice()
    if (!this.warnedAboutDevice) {
      this.warnedAboutDevice = true
      // Said once, loudly, because the consequence of ignoring it is silent: a new
      // anonymous user on the ledger's host every time the butler restarts.
      this.ctx.emit('tricount/device', {
        appId: this.device.appId,
        publicKeyPem: this.device.publicKeyPem,
        reason: 'No appId/publicKeyRef configured; a device was minted for this process only. '
          + 'Set appId and store the public key to keep one identity across restarts.',
      })
    }
    return this.device
  }

  /**
   * Ensure there is a live session and the ledger is attached.
   *
   * The sharing token is resolved here and dropped on return, so rotating it takes
   * effect on the next connect without a restart.
   *
   * @returns the device, session, and ledger id.
   */
  private async connect(): Promise<{ device: Device; session: Session; ledgerId: number }> {
    const device = await this.resolveDevice()
    const fresh = this.session !== undefined && Date.now() - this.session.at < SESSION_TTL_MS
    if (fresh && this.ledgerId !== undefined) {
      return { device, session: this.session!.session, ledgerId: this.ledgerId }
    }
    const token = await this.ctx.credentials.resolve(this.settings.tokenRef)
    if (token === undefined) {
      throw new TricountError(
        'credential-unconfigured',
        `Tricount tokenRef "${this.settings.tokenRef}" resolves to no value — take the sharing link from `
        + 'the Tricount app (⋯ → Share) and store its token with your credential provider.',
      )
    }
    const report = this.reporter()
    const session = await openSession(device, report)
    this.session = { session, at: Date.now() }
    this.ledgerId = await joinLedger(device, session, token.value, report)
    return { device, session, ledgerId: this.ledgerId }
  }

  /**
   * Read the ledger, reusing a recent snapshot.
   *
   * @param force - fetch even if the cached snapshot is still young. Used after a write.
   * @returns the ledger.
   */
  async ledger(force = false): Promise<Ledger> {
    if (!force && this.snapshot !== undefined && Date.now() - this.snapshot.at < LEDGER_TTL_MS) {
      return this.snapshot.ledger
    }
    const { device, session, ledgerId } = await this.connect()
    const ledger = await fetchLedger(device, session, ledgerId, this.reporter())
    this.snapshot = { ledger, at: Date.now() }
    return ledger
  }

  /**
   * Discard the cached snapshot, so the next read goes to the server.
   *
   * Called after every write, and available to a caller who knows the other agent
   * has just filed something.
   */
  invalidate(): void {
    this.snapshot = undefined
  }

  /**
   * Where everybody stands.
   *
   * @param force - re-fetch before computing.
   * @returns one balance per member, summing to zero.
   */
  async balances(force = false): Promise<Balance[]> {
    return computeBalances(await this.ledger(force))
  }

  /**
   * The payments that would clear the balances.
   *
   * @param force - re-fetch before computing.
   * @returns the suggested transfers, largest first.
   */
  async settlement(force = false): Promise<Settlement[]> {
    return settleUp(await this.balances(force))
  }

  /**
   * Find a member by any name the family might use.
   *
   * Matching is case-insensitive and accepts a unique prefix, because the butler is
   * given names by people typing in chat, not by an id.
   *
   * @param name - a display name, or enough of one to be unambiguous.
   * @param ledger - a snapshot to search; fetched if omitted.
   * @returns the member.
   * @throws TricountError `unknown-member` naming who is on the ledger.
   */
  async member(name: string, ledger?: Ledger): Promise<LedgerMember> {
    const snapshot = ledger ?? await this.ledger()
    const active = snapshot.members.filter(candidate => candidate.status === 'ACTIVE')
    const wanted = name.trim().toLowerCase()
    const exact = active.find(candidate => candidate.displayName.toLowerCase() === wanted)
    if (exact !== undefined) return exact
    const prefixed = active.filter(candidate => candidate.displayName.toLowerCase().startsWith(wanted))
    if (prefixed.length === 1) return prefixed[0]!
    const known = active.map(candidate => candidate.displayName).join(', ')
    throw new TricountError(
      'unknown-member',
      prefixed.length > 1
        ? `"${name}" could be any of ${prefixed.map(c => c.displayName).join(', ')} on the ledger — be more specific`
        : `Nobody on the ledger is called "${name}". The ledger has: ${known}`,
    )
  }

  /**
   * Find one entry by id.
   *
   * @param entryId - the numeric entry id.
   * @param ledger - a snapshot to search; fetched if omitted.
   * @returns the entry.
   * @throws TricountError `entry-not-found`.
   */
  async entry(entryId: number, ledger?: Ledger): Promise<LedgerEntry> {
    const snapshot = ledger ?? await this.ledger()
    const found = snapshot.entries.find(candidate => candidate.id === entryId)
    if (found === undefined) {
      throw new TricountError('entry-not-found', `There is no ledger entry ${entryId}`)
    }
    return found
  }

  /**
   * Refuse to write to an archived ledger.
   *
   * @param ledger - the snapshot to check.
   * @throws TricountError `read-only` when the ledger is archived.
   */
  private assertWritable(ledger: Ledger): void {
    if (ledger.status === 'READ_ONLY') {
      throw new TricountError(
        'read-only',
        `The ledger "${ledger.title}" is archived, so nothing can be added or changed. Un-archive it in the Tricount app first.`,
      )
    }
  }

  /**
   * Add an entry to the ledger.
   *
   * @param input - the entry, with a signed total and allocations that sum to it.
   * @returns the new entry's id.
   */
  async add(input: EntryInput): Promise<number> {
    const ledger = await this.ledger()
    this.assertWritable(ledger)
    const { device, session, ledgerId } = await this.connect()
    const id = await createEntry(device, session, ledgerId, input, ledger.currency, this.reporter())
    this.invalidate()
    return id
  }

  /**
   * Change an existing entry, preserving everything not being changed.
   *
   * This is the operation the reference Python implementation gets wrong in three
   * separate ways, all of which corrupt money, so it is worth being explicit about
   * what is preserved:
   *
   *   * **The sign.** An expense is stored negative. A caller naturally passes a
   *     positive amount, and writing that through unchanged turns the expense into
   *     income — reversing its effect on every balance. The entry's existing sign is
   *     re-applied here.
   *   * **The ratios.** A split filed as parts (`3/2`) displays as shares in the app
   *     and keeps meaning something after the total changes. Rewriting it as fixed
   *     amounts discards the household's intent; the ratios are carried through and
   *     re-divided against the new total.
   *   * **The exact total.** Re-dividing uses {@link splitByRatio}, so the new
   *     allocations sum to the new total to the unit, rather than to a cent less.
   *
   * @param entryId - which entry.
   * @param patch - what to change.
   * @returns the entry as it was before the change, so a caller can report the diff.
   */
  async edit(entryId: number, patch: EntryPatch): Promise<LedgerEntry> {
    const ledger = await this.ledger()
    this.assertWritable(ledger)
    const before = await this.entry(entryId, ledger)
    const { splitByRatio } = await import('./money.ts')

    const sign = before.amount.minor < 0 ? -1 : 1
    const magnitude = patch.amountMinor !== undefined
      ? Math.abs(Math.trunc(patch.amountMinor))
      : Math.abs(before.amount.minor)
    const total = sign * magnitude

    // Keep the machine tag: it is how the bank-feed agent recognises its own rows,
    // and losing it would make that agent re-file the expense as a duplicate.
    const tag = before.ref !== undefined ? ` [ref:${before.ref}]` : ''
    const description = patch.title !== undefined ? `${patch.title.trim()}${tag}` : before.description

    let allocations: { memberUuid: string; minor: number; shareRatio?: number }[]
    if (patch.split !== undefined) {
      const shares = splitByRatio(total, patch.split.map(part => ({ key: part.memberUuid, ratio: part.parts })))
      allocations = shares.map(share => ({ memberUuid: share.key, minor: share.minor, shareRatio: share.ratio }))
    } else if (before.allocations.every(allocation => allocation.shareRatio !== undefined)) {
      // A ratio split re-divides against the new total, exactly.
      const shares = splitByRatio(
        total,
        before.allocations.map(allocation => ({ key: allocation.memberUuid, ratio: allocation.shareRatio! })),
      )
      allocations = shares.map(share => ({ memberUuid: share.key, minor: share.minor, shareRatio: share.ratio }))
    } else if (patch.amountMinor !== undefined) {
      // Fixed amounts with a new total: scale them by their existing proportions, so
      // an uneven split stays uneven rather than silently becoming an even one.
      const weights = before.allocations.map(allocation => ({
        key: allocation.memberUuid,
        ratio: Math.max(1, Math.abs(allocation.amount.minor)),
      }))
      const shares = splitByRatio(total, weights)
      allocations = shares.map(share => ({ memberUuid: share.key, minor: share.minor }))
    } else {
      allocations = before.allocations.map(allocation => ({
        memberUuid: allocation.memberUuid,
        minor: allocation.amount.minor,
        ...(allocation.shareRatio !== undefined ? { shareRatio: allocation.shareRatio } : {}),
      }))
    }

    const input: EntryInput = {
      description,
      minor: total,
      payerUuid: patch.payerUuid ?? before.payerUuid,
      allocations,
      type: before.type,
      day: patch.day ?? before.day,
      status: before.status,
      ...(patch.category !== undefined
        ? { category: patch.category }
        : before.category !== undefined ? { category: before.category } : {}),
      ...(before.categoryCustom !== undefined && patch.category === undefined
        ? { categoryCustom: before.categoryCustom }
        : {}),
    }
    const { device, session, ledgerId } = await this.connect()
    await updateEntry(device, session, ledgerId, entryId, input, ledger.currency, this.reporter())
    this.invalidate()
    return before
  }

  /**
   * Remove an entry from the ledger.
   *
   * @param entryId - which entry.
   * @returns the entry that was removed, so a caller can say what went.
   */
  async remove(entryId: number): Promise<LedgerEntry> {
    const ledger = await this.ledger()
    this.assertWritable(ledger)
    const before = await this.entry(entryId, ledger)
    const { device, session, ledgerId } = await this.connect()
    await deleteEntry(device, session, ledgerId, entryId, this.reporter())
    this.invalidate()
    return before
  }

  /**
   * The name to show for a member uuid.
   *
   * @param ledger - the snapshot.
   * @param uuid - the membership uuid.
   * @returns the display name, or a short form of the uuid when the member is gone.
   */
  nameOf(ledger: Ledger, uuid: string): string {
    return ledger.members.find(member => member.uuid === uuid)?.displayName ?? `(former member ${uuid.slice(0, 8)})`
  }

  /**
   * Strip a machine tag from a description.
   *
   * Re-exported on the service so callers do not have to reach into the wire module.
   *
   * @param description - the stored description.
   * @returns what a person should read.
   */
  readable(description: string): string {
    return stripRef(description)
  }
}

export default Tricount

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The household's shared expense ledger. */
    tricount: Tricount
  }
  interface Events {
    /**
     * Emitted once when a device identity had to be minted because none was
     * configured. Carries the values an operator must persist.
     *
     * @param event - the minted identity and why it happened.
     * @mode emit
     */
    'tricount/device'(event: { appId: string; publicKeyPem: string; reason: string }): void
  }
}
