/**
 * The `discord.js` boundary: the narrow structural interface this channel
 * drives, the lazy SDK loader, and message chunking for Discord's length limit.
 *
 * `discord.js` is an optional peer and is never imported at module load, so the
 * channel mounts, typechecks, and tests without it. The interfaces below are
 * declared structurally rather than imported from `discord.js` for the same
 * reason: the package must typecheck in a profile that has no Discord at all.
 *
 * @module dsh-channel-discord/discord
 */

/** Discord's hard limit on one message's content. */
export const DISCORD_MESSAGE_LIMIT = 2000

/** A channel the bot can post to. */
export interface DiscordChannel {
  /** Snowflake id. */
  id: string
  /** Post one message. */
  send(content: string): Promise<unknown>
  /** Show the typing indicator for a few seconds; absent on channel kinds that lack it. */
  sendTyping?: () => Promise<void>
  /** Whether this channel accepts messages, which narrows the union `discord.js` returns. */
  isTextBased?: () => boolean
}

/** One attachment on an inbound message. */
export interface DiscordAttachment {
  /** Attachment filename, e.g. `voice-message.ogg`. */
  filename: string
  /** MIME type as Discord reports it. */
  contentType?: string | null
  /** CDN URL the bytes can be fetched from. */
  url: string
  /** True when Discord flagged this as a native voice message. */
  isVoiceMessage: boolean
}

/** One inbound message. */
export interface DiscordMessage {
  /** Snowflake id, used for deduplication. */
  id: string
  /** Message text; empty unless the Message Content intent is granted. */
  content: string
  /** Channel the message was posted in. */
  channelId: string
  /** Guild the message was posted in, or `null` in a direct message. */
  guildId: string | null
  /** Who sent it. */
  author: {
    /** Snowflake id, matched against the roster. */
    id: string
    /** Whether the sender is a bot; the channel never answers bots. */
    bot: boolean
    /** Global display name, when set. */
    globalName?: string | null
    /** Legacy user name. */
    /** Optional because a webhook or a partial can arrive without one. */
    username?: string
  }
  /** Server nickname and roles, absent in a direct message. */
  member?: { displayName?: string | null } | null
  /** The channel object, when the SDK attached one. */
  channel?: DiscordChannel
  /** Snowflake ids this message mentions. */
  mentionedUserIds: string[]
  /** Attachments on the message; voice notes carry `isVoiceMessage`. */
  attachments: DiscordAttachment[]
}

/** The bot connection. */
export interface DiscordClient {
  /** Sign in and start receiving events. */
  login(token: string): Promise<unknown>
  /** Close the connection. */
  destroy(): Promise<void>
  /** The bot's own user, available once ready. */
  botUserId(): string | undefined
  /** Register the inbound-message handler. */
  onMessage(handler: (message: DiscordMessage) => void): void
  /** Register the ready handler. */
  onReady(handler: (botUserId: string) => void): void
  /** Register the transport-error handler. */
  onError(handler: (error: Error) => void): void
  /** Fetch a channel by id, for posting without an inbound message to reply to. */
  fetchChannel(channelId: string): Promise<DiscordChannel | undefined>
}

/** Factory over the SDK. */
export interface DiscordSdk {
  /**
   * Build a client with the intents a butler needs.
   * @returns a client that is not yet signed in.
   */
  createClient(): DiscordClient
}

/** Read the best available human name for a sender not in the roster. */
function senderName(raw: {
  member?: { displayName?: string | null } | null
  author: { id?: string; globalName?: string | null; username?: string }
}): string {
  // The id is the last resort. discord.js normally always supplies a username,
  // but a webhook or a partial can arrive without one, and `[undefined] ...` in
  // the room reads as a bug rather than as a person.
  return raw.member?.displayName
    ?? raw.author.globalName
    ?? raw.author.username
    ?? raw.author.id
    ?? 'someone'
}

/** Load `discord.js` on first use, or explain exactly how to install it. */
async function importSdk(): Promise<DiscordSdk> {
  interface RawModule {
    Client: new (options: unknown) => RawClient
    GatewayIntentBits: Record<string, number>
    Partials: Record<string, number>
    Events: Record<string, string>
  }
  interface RawClient {
    login(token: string): Promise<string>
    destroy(): Promise<void>
    user: { id: string } | null
    on(event: string, handler: (...args: unknown[]) => void): unknown
    channels: { fetch(id: string): Promise<unknown> }
  }
  let module: RawModule
  try {
    module = await import('discord.js') as unknown as RawModule
  } catch (cause) {
    throw new Error(
      'dsh-channel-discord requires the optional peer dependency "discord.js". Install it into the profile, '
      + 'e.g. `dsh plugin --profile <name> add discord.js`, or `pnpm add discord.js` in a source checkout. '
      + `Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
  const { Client, GatewayIntentBits, Partials, Events } = module
  return {
    createClient(): DiscordClient {
      const client = new Client({
        intents: [
          GatewayIntentBits['Guilds'],
          GatewayIntentBits['GuildMessages'],
          // Without MessageContent every inbound `content` arrives empty. It is a
          // privileged intent: enable it on the bot's application page.
          GatewayIntentBits['MessageContent'],
          GatewayIntentBits['DirectMessages'],
        ],
        // Direct-message channels arrive uncached, so the partial must be allowed
        // or a DM raises no event at all.
        partials: [Partials['Channel']],
      })
      return {
        login: token => client.login(token),
        destroy: () => client.destroy(),
        botUserId: () => client.user?.id,
        onMessage(handler) {
          client.on(Events['MessageCreate']!, (...args: unknown[]) => {
            const raw = args[0] as {
              id: string
              content: string
              channelId: string
              guildId: string | null
              author: { id: string; bot: boolean; globalName?: string | null; username?: string }
              member?: { displayName?: string | null } | null
              channel?: DiscordChannel
              mentions?: { users?: { keys?: () => Iterable<string> } }
              attachments?: Map<string, {
                name?: string
                contentType?: string | null
                url: string
                flags?: Set<string> | string[]
              }>
            }
            const mentionedUserIds = [...raw.mentions?.users?.keys?.() ?? []]
            const attachments = [...raw.attachments?.values() ?? []].map(attachment => ({
              filename: attachment.name ?? 'attachment',
              contentType: attachment.contentType,
              url: attachment.url,
              isVoiceMessage: (() => {
                const flags = attachment.flags
                if (flags instanceof Set) return flags.has('IS_VOICE_MESSAGE')
                if (Array.isArray(flags)) return flags.includes('IS_VOICE_MESSAGE')
                return false
              })(),
            }))
            handler({
              id: raw.id,
              content: raw.content,
              channelId: raw.channelId,
              guildId: raw.guildId,
              author: raw.author,
              member: raw.member ?? null,
              mentionedUserIds,
              attachments,
              ...raw.channel !== undefined ? { channel: raw.channel } : {},
            })
          })
        },
        onReady(handler) {
          client.on(Events['ClientReady']!, () => {
            const id = client.user?.id
            if (id !== undefined) handler(id)
          })
        },
        onError(handler) {
          client.on(Events['Error'] ?? 'error', (...args: unknown[]) => {
            const error = args[0]
            handler(error instanceof Error ? error : new Error(String(error)))
          })
        },
        async fetchChannel(channelId) {
          const fetched = await client.channels.fetch(channelId)
          if (fetched === null || typeof fetched !== 'object') return undefined
          const channel = fetched as DiscordChannel
          return typeof channel.send === 'function' ? channel : undefined
        },
      }
    },
  }
}

/**
 * Test seam. Replacing `loadSdk` substitutes a fake Discord gateway, which is
 * how every spec in this package runs without a bot token or a network.
 */
export const internals: { loadSdk: () => Promise<DiscordSdk> } = { loadSdk: importSdk }

/**
 * Load the SDK through the {@link internals} seam.
 * @returns the client factory.
 */
export function loadDiscordSdk(): Promise<DiscordSdk> {
  return internals.loadSdk()
}

/** The name to attribute a message to when the sender is not in the roster. */
export function describeSender(message: DiscordMessage): string {
  return senderName(message)
}

/**
 * Split a reply into messages Discord will accept.
 *
 * Breaks at paragraph, then line, then word boundaries so a split never lands
 * mid-sentence, and reopens an unbalanced code fence in the next chunk so a
 * fenced block does not leak formatting across the break.
 * @param text - the whole reply.
 * @param limit - maximum characters per message; Discord's own limit by default.
 * @returns one string per message to send, in order.
 */
export function splitForDiscord(text: string, limit: number = DISCORD_MESSAGE_LIMIT): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (trimmed.length <= limit) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  let openFence = ''
  while (rest.length > 0) {
    const prefix = openFence === '' ? '' : `${openFence}\n`
    const room = limit - prefix.length
    if (rest.length <= room) {
      chunks.push(`${prefix}${rest}`)
      break
    }
    const cut = breakPoint(rest, room)
    const piece = rest.slice(0, cut).replace(/\s+$/, '')
    rest = rest.slice(cut).replace(/^\s+/, '')
    const body = `${prefix}${piece}`
    const fence = danglingFence(body)
    chunks.push(fence === '' ? body : `${body}\n\`\`\``)
    openFence = fence
  }
  return chunks.filter(chunk => chunk.trim() !== '')
}

/** The latest boundary at or before `room`, preferring the largest structural break. */
function breakPoint(text: string, room: number): number {
  for (const separator of ['\n\n', '\n', ' ']) {
    const index = text.lastIndexOf(separator, room)
    // Require the break to be past the halfway mark, or a long unbroken run
    // would produce a stream of tiny chunks.
    if (index > room / 2) return index + separator.length
  }
  return room
}

/** The fence opener left unclosed in a chunk, or `''` when fences balance. */
function danglingFence(text: string): string {
  const fences = text.match(/^```[^\n]*$/gm) ?? []
  if (fences.length % 2 === 0) return ''
  return fences[fences.length - 1]!
}
