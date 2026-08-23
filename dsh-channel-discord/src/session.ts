/**
 * How a room's agent session is started.
 *
 * This is its own module because the interesting part is a *policy* — resume the
 * family's thread if it exists, otherwise begin one — and that policy is worth
 * testing without standing up a Discord client, a model provider and four
 * injected services.
 *
 * The policy exists because the room's session id is stable across restarts. If
 * the butler always created, the transcript would still be written to disk and
 * never read back, and the family would find it had forgotten Thursday's
 * conversation by Friday.
 *
 * @module dsh-channel-discord/session
 */

/**
 * The room's durable session identity.
 *
 * Derived only from the configured channel name and the Discord channel id, so
 * it is **stable across restarts** — which is the whole reason a resume can find
 * anything. Nothing time-based or random may enter this string.
 * @param channelName - configured name for this deployment, defaulting to `discord`.
 * @param room - Discord channel id.
 * @returns the session id string.
 */
export function roomSessionId(channelName: string | undefined, room: string): string {
  return `${channelName ?? 'discord'}-${room}`
}

/** The two ways to obtain an agent for a room. */
export interface RoomSessionStarter<H> {
  /** Load the room's persisted session. Rejects when there is nothing to load. */
  resume(): Promise<H>
  /** Begin a fresh session for the room. */
  create(): Promise<H>
}

/** What happened when the room's session started. */
export interface RoomSessionStart<H> {
  /** The live agent handle. */
  readonly handle: H
  /** Whether a persisted session was loaded rather than a fresh one begun. */
  readonly resumed: boolean
  /** Why resume was not possible. Absent when it succeeded. */
  readonly reason?: string
}

/**
 * Resume the room's session, falling back to a fresh one.
 *
 * Resume is tried first and its failure is **not** an error, because two
 * legitimate situations are indistinguishable from here: a room's very first
 * message has no session to load, and a bundle without session persistence
 * mounted can never load one. Both want a working butler rather than a refusal,
 * so the reason is reported and a fresh session begins.
 *
 * A `create` failure, by contrast, propagates — at that point there is genuinely
 * no way to answer.
 * @param starter - the resume and create operations for this room.
 * @returns the handle plus whether history was loaded.
 */
export async function startRoomSession<H>(starter: RoomSessionStarter<H>): Promise<RoomSessionStart<H>> {
  try {
    return { handle: await starter.resume(), resumed: true }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { handle: await starter.create(), resumed: false, reason }
  }
}

/** Runs work one item at a time per key, and different keys in parallel. */
export interface SerialQueue {
  /**
   * Queue work behind anything already running for this key.
   * @param key - work sharing a key never overlaps.
   * @param work - the operation to run when its turn comes.
   * @returns the operation's result, or its rejection.
   */
  run<T>(key: string, work: () => Promise<T>): Promise<T>
  /** How many keys currently have work in flight. Diagnostics and leak checks. */
  size(): number
}

/**
 * A per-key serial queue.
 *
 * Every turn in a room passes through this, whoever started it, which is what
 * makes a scheduled prompt safe: it waits for the butler to finish replying to
 * whoever is talking instead of arriving mid-answer and interleaving two
 * conversations in one session.
 *
 * A failed item does not poison the queue — the next one still runs — because one
 * bad turn should not silence a room until restart. Keys are dropped once nothing
 * is left running under them, so a long-lived process does not accumulate an
 * entry per channel it has ever seen.
 * @returns the queue.
 */
export function createSerialQueue(): SerialQueue {
  const tails = new Map<string, Promise<void>>()
  return {
    async run<T>(key: string, work: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve()
      const current = previous.then(work)
      // The stored tail swallows rejections so the next item is not skipped;
      // the caller still sees the real outcome through `current`.
      const tail = current.then(() => undefined, () => undefined)
      tails.set(key, tail)
      try {
        return await current
      } finally {
        if (tails.get(key) === tail) tails.delete(key)
      }
    },
    size(): number {
      return tails.size
    },
  }
}
