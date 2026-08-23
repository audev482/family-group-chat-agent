/**
 * Type surface of the Discord channel: status and inbound event payloads plus
 * the seam's Cordis event declarations. Types only — no runtime code.
 *
 * @module dsh-channel-discord/types
 */

/** Connection lifecycle states. */
export type DiscordChannelStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected'

/** One accepted inbound message: who said something where, never the text. */
export interface DiscordInboundEvent {
  /** Discord message id. */
  readonly messageId: string
  /** Channel the message was posted in. */
  readonly channelId: string
  /** Sender's Discord user id. */
  readonly userId: string
  /** Roster key of the sender, or `undefined` when they are not a configured member. */
  readonly memberKey?: string
}

/** One connection-state transition. */
export interface DiscordStatusEvent {
  /** New status. */
  readonly status: DiscordChannelStatus
  /** Human-readable cause. */
  readonly reason: string
}

/**
 * How a room's agent session started. Lets an operator tell a cold start from a
 * genuine persistence failure: a room's first ever message legitimately has
 * nothing to resume, but `resumed: false` on a room that has been talking for
 * weeks means the transcript is no longer being loaded.
 */
export interface DiscordSessionEvent {
  /** Channel whose room session started. */
  readonly channelId: string
  /** The room's durable session id. */
  readonly sessionId: string
  /** Whether a persisted session was loaded, rather than a fresh one started. */
  readonly resumed: boolean
  /** Why resume was not possible. Absent when it succeeded. */
  readonly reason?: string
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * One inbound Discord message passed the channel's filters and is about to
     * enter its room's agent inbox.
     * @param event - sender and channel identity; never message content.
     * @mode emit
     */
    'discord/inbound'(event: DiscordInboundEvent): void

    /**
     * The channel's connection state changed.
     * @param event - the new status and why.
     * @mode emit
     */
    'discord/status'(event: DiscordStatusEvent): void

    /**
     * A room's agent session started, either resumed from disk or fresh.
     * @param event - room and session identity, and whether history was loaded.
     * @mode emit
     */
    'discord/session'(event: DiscordSessionEvent): void
  }
}
