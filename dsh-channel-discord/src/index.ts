/**
 * dsh-channel-discord — the family's way of talking to the butler.
 *
 * The reference XMTP channel maps one conversation to one person. A family room
 * is not that: several people share one thread and one context, and the useful
 * answer to "can you move it an hour later" depends on who asked and on what
 * somebody else said two messages ago.
 *
 * So this channel keeps **one agent session per Discord channel**, not per
 * person, and prefixes every inbound turn with the speaker resolved through
 * `ctx.household`. The model reads a transcript it can reason about — "Alex
 * asked for the dentist, then Sam said Thursday is better" — and a chore created
 * from "add mine" is filed against whoever actually typed it.
 *
 * Access control is deliberately absent: a household is one trust domain, and
 * the roster exists for attribution, not authorization. What *is* enforced is
 * where the butler listens — only the configured channels, so adding the bot to
 * a server does not make it read everything.
 *
 * `ctx.discord` also lets other plugins speak unprompted; `dsh-briefing` uses it
 * for the morning digest.
 *
 * @module dsh-channel-discord
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
// Type-only: carries the `ctx.agentDefaultModel` Context declaration.
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
// Type-only: carries the `ctx.household` Context declaration.
import type {} from 'dsh-household'
import { describeSender, loadDiscordSdk, splitForDiscord } from './discord.ts'
import { createSerialQueue, roomSessionId, startRoomSession } from './session.ts'
import type { DiscordChannel as Channel, DiscordClient, DiscordMessage } from './discord.ts'
import type { DiscordChannelStatus } from './types.ts'
// Type-only: carries the `discord/inbound` and `discord/status` event declarations.
import type {} from './types.ts'

export {
  DISCORD_MESSAGE_LIMIT,
  describeSender,
  internals,
  loadDiscordSdk,
  splitForDiscord,
} from './discord.ts'
export type { DiscordClient, DiscordMessage, DiscordSdk } from './discord.ts'
export { createSerialQueue, roomSessionId, startRoomSession } from './session.ts'
export type { RoomSessionStart, RoomSessionStarter, SerialQueue } from './session.ts'
export type {
  DiscordChannelStatus,
  DiscordInboundEvent,
  DiscordSessionEvent,
  DiscordStatusEvent,
} from './types.ts'

/**
 * Plugin name used to attribute a scheduled turn.
 *
 * Spelled out rather than derived so a scheduled prompt is never mistaken for a
 * family member in the transcript.
 */
export const PLUGIN_NAME = 'dsh-channel-discord'

/** One turn to run in a room: what to say, how to attribute it, where to reply. */
interface RoomTurn {
  /** Text to put in the agent's inbox. */
  readonly text: string
  /** Producer attribution — a family member, or a plugin acting on its own. */
  readonly source: Parameters<typeof createUserMessage>[0]['source']
  /** Channel object to reply through, when one is already to hand. */
  readonly channel?: Channel | undefined
  /** Show a typing indicator for this message while the model works. */
  readonly typingFor?: DiscordMessage | undefined
}

/** Consecutive failed reconnects before the channel gives up. */
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10
/** Delay between reconnect attempts. */
export const DEFAULT_RECONNECT_DELAY_MS = 5_000
/** Message ids remembered for deduplication before the oldest half is dropped. */
export const MAX_DEDUP_SIZE = 5_000

/** When the butler answers in a room it is listening to. */
export type RespondMode = 'all' | 'mention'

/** Plugin configuration. */
export interface Config {
  /**
   * Credential *reference* naming the bot token — a POSIX-style
   * environment-variable name such as `DISCORD_BOT_TOKEN`, never the token
   * itself. A pasted token fails loud at load.
   */
  tokenRef: string
  /**
   * Channel ids the butler listens to. **Required**: an empty list makes the
   * butler mute rather than making it listen everywhere, because a bot with the
   * Message Content intent can read every message in every channel it can see.
   */
  channelIds: string[]
  /**
   * `all` answers every message in a listened channel — right for a channel
   * that exists for the butler. `mention` answers only when the bot is
   * mentioned — right for a general family channel.
   */
  respondTo?: RespondMode
  /** Whether to answer direct messages from roster members. */
  allowDirectMessages?: boolean
  /** Session-id prefix, distinguishing parallel channel mounts. */
  channelName?: string
  /** Show the typing indicator while the butler is thinking. */
  typingIndicator?: boolean
  /** Consecutive failed reconnects before the channel gives up. */
  maxReconnectAttempts?: number
  /** Delay between reconnect attempts. */
  reconnectDelayMs?: number
}

export const Config: z<Config> = z.object({
  tokenRef: z.string().required(),
  channelIds: z.array(z.string()).default([]),
  respondTo: z.union(['all', 'mention']).default('all'),
  allowDirectMessages: z.boolean().default(true),
  channelName: z.string().default('discord'),
  typingIndicator: z.boolean().default(true),
  maxReconnectAttempts: z.number().step(1).min(0).default(DEFAULT_MAX_RECONNECT_ATTEMPTS),
  reconnectDelayMs: z.number().step(1).min(0).default(DEFAULT_RECONNECT_DELAY_MS),
})

/** Join the assistant text appended at or after `firstSeq`. */
function lastAssistantText(events: readonly SessionEvent[], firstSeq: number): string {
  let text = ''
  for (const event of events) {
    if (event.seq < firstSeq || event.type !== 'assistant/message') continue
    const joined = event.data.message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    if (joined !== '') text = joined
  }
  return text
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    discord: DiscordChannel
  }
}

/**
 * The Discord runtime (`ctx.discord`): one bot connection, one agent per room,
 * and the outbound path other plugins use to speak unprompted.
 */
export class DiscordChannel extends Service {
  static inject = ['agents', 'agentDefaultModel', 'credentials', 'household']
  static Config: z<Config> = Config

  private status: DiscordChannelStatus = 'disconnected'
  private client: DiscordClient | undefined
  private botUserId: string | undefined
  private reconnectAttempts = 0
  private stopped = false
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  /** Dedup by message id, insertion-ordered so pruning drops the oldest half. */
  private readonly seen = new Set<string>()
  /** One live agent handle per room. */
  private readonly agents = new Map<string, Promise<AgentHandle>>()
  /**
   * Per-room turn queue: every turn in a room runs in order, whoever started it,
   * so a scheduled prompt cannot land halfway through an answer.
   */
  private readonly turns = createSerialQueue()
  private readonly listening: ReadonlySet<string>
  private readonly config: Config

  constructor(ctx: Context, config: Config) {
    super(ctx, 'discord')
    this.config = config
    this.listening = new Set(config.channelIds)
    // Fail loud at load: a token pasted where a reference belongs cannot be a
    // credential reference, and the message says what belongs there instead.
    try {
      credentialRef(config.tokenRef)
    } catch (cause) {
      throw new Error(
        'dsh-channel-discord: tokenRef is not a credential reference. Configuration carries the NAME of a '
        + 'credential (a POSIX-style environment-variable name, e.g. "DISCORD_BOT_TOKEN"), never the token '
        + `itself. Cause: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    if (config.channelIds.length === 0) {
      ctx.emit('discord/status', {
        status: 'disconnected',
        reason: 'no channelIds are configured, so the butler will not listen anywhere',
      })
    }
  }

  /** Start the connect loop as a disposable effect once construction is complete. */
  [Service.init](): void {
    this.ctx.effect(() => {
      void this.start()
      return async () => {
        await this.stop()
      }
    })
  }

  /** Enter the connect loop; never throws (failures feed the reconnect policy). */
  async start(): Promise<void> {
    if (this.config.channelIds.length === 0) return
    this.setStatus('connecting', 'starting')
    await this.connect()
  }

  /** Tear everything down: connection, timers, and every owned agent. */
  async stop(): Promise<void> {
    this.stopped = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    const client = this.client
    this.client = undefined
    if (client !== undefined) {
      await client.destroy().catch(() => undefined)
    }
    for (const pending of this.agents.values()) {
      await pending.then(handle => handle.dispose()).catch(() => undefined)
    }
    this.agents.clear()
    this.setStatus('disconnected', 'stopped')
  }

  /** The channel's connection state. */
  get connectionStatus(): DiscordChannelStatus {
    return this.status
  }

  /** Channel ids the butler listens to. */
  get channels(): readonly string[] {
    return [...this.listening]
  }

  private setStatus(status: DiscordChannelStatus, reason: string): void {
    if (this.status === status) return
    this.status = status
    this.ctx.emit('discord/status', { status, reason })
  }

  /** Resolve the bot token NOW (per connect), never cached. */
  private async resolveToken(): Promise<string> {
    const ref = credentialRef(this.config.tokenRef)
    const resolved = await this.ctx.credentials.resolve(ref)
    if (resolved === undefined) {
      throw new Error(
        `dsh-channel-discord: credential reference "${this.config.tokenRef}" resolves to no value — create a bot `
        + 'at https://discord.com/developers/applications, copy its token, and configure it with your credential '
        + 'provider before connecting',
      )
    }
    return resolved.value
  }

  /** One connect attempt; failure schedules a bounded retry. */
  private async connect(): Promise<void> {
    if (this.stopped) return
    try {
      const token = await this.resolveToken()
      const sdk = await loadDiscordSdk()
      const client = sdk.createClient()
      client.onReady((botUserId) => {
        this.botUserId = botUserId
        this.reconnectAttempts = 0
        this.setStatus('connected', `connected as bot ${botUserId}, listening in ${this.listening.size} channel(s)`)
      })
      client.onError((error) => {
        void this.reconnect(`gateway error: ${error.message}`)
      })
      client.onMessage((message) => {
        this.onMessage(message)
      })
      await client.login(token)
      if (this.stopped) {
        await client.destroy().catch(() => undefined)
        return
      }
      this.client = client
    } catch (error) {
      await this.reconnect(error instanceof Error ? error.message : String(error))
    }
  }

  /** Bounded fixed-delay retry. */
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped) return
    const client = this.client
    this.client = undefined
    if (client !== undefined) await client.destroy().catch(() => undefined)
    this.reconnectAttempts += 1
    if (this.reconnectAttempts > (this.config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)) {
      this.setStatus('disconnected', `reconnect attempts exhausted: ${reason}`)
      return
    }
    this.setStatus('reconnecting', reason)
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      void this.connect()
    }, this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS)
    this.timers.add(timer)
  }

  /**
   * Decide whether one message is for the butler.
   *
   * Order: own messages and bots, then the channel allowlist, then the respond
   * mode, then empty content, then deduplication.
   * @param message - the inbound message.
   * @returns why the message was rejected, or `undefined` when it is accepted.
   */
  shouldAnswer(message: DiscordMessage): string | undefined {
    if (message.author.bot) return 'sender is a bot'
    if (this.botUserId !== undefined && message.author.id === this.botUserId) return 'own message'
    const isDirect = message.guildId === null
    if (isDirect) {
      if (this.config.allowDirectMessages === false) return 'direct messages are disabled'
      if (this.ctx.household.byDiscordId(message.author.id) === undefined) {
        return 'direct message from someone outside the household'
      }
    } else if (!this.listening.has(message.channelId)) {
      return 'channel is not in channelIds'
    }
    if ((message.content.trim() === '') && !message.attachments.some(a => a.isVoiceMessage
      || (a.contentType?.startsWith('audio/') ?? false))) {
      return 'no text content'
    }
    // A mention-only room stays quiet until addressed; a direct message is
    // already addressed to the butler.
    if (!isDirect && (this.config.respondTo ?? 'all') === 'mention'
      && this.botUserId !== undefined
      && !message.mentionedUserIds.includes(this.botUserId)) {
      return 'not mentioned'
    }
    return undefined
  }

  /** Filter, deduplicate, and hand one message to its room's agent. */
  private onMessage(message: DiscordMessage): void {
    if (this.stopped) return
    if (this.shouldAnswer(message) !== undefined) return
    if (this.seen.has(message.id)) return
    this.seen.add(message.id)
    if (this.seen.size > MAX_DEDUP_SIZE) {
      for (const id of this.seen) {
        if (this.seen.size <= MAX_DEDUP_SIZE / 2) break
        this.seen.delete(id)
      }
    }
    const member = this.ctx.household.byDiscordId(message.author.id)
    this.ctx.emit('discord/inbound', {
      messageId: message.id,
      channelId: message.channelId,
      userId: message.author.id,
      ...member !== undefined ? { memberKey: member.key } : {},
    })
    void (async () => {
      const voiceText = await this.transcribeVoiceNotes(message).catch((cause: unknown) => {
        // A failed transcription must not silently drop the message: say so in
        // the room, the way a failed turn would.
        const detail = cause instanceof Error ? cause.message : String(cause)
        void this.post(message.channelId, `I could not listen to that voice note: ${detail}`, message.channel).catch(() => undefined)
        return undefined as string | undefined
      })
      if (voiceText === undefined && message.content.trim() === '') return
      await this.deliver({
        ...message,
        content: voiceText === undefined
          ? message.content
          : message.content.trim() === ''
            ? voiceText
            : `${message.content}\n${voiceText}`,
      })
    })()
  }

  /**
   * Transcribe every voice-note attachment on one message with local Whisper.
   *
   * Returns the joined transcript prefixed per clip, or `undefined` when the
   * message carries no voice notes. A missing binary or model is a hard error:
   * voice arriving while transcription is unconfigured should be visible, not
   * silently swallowed.
   */
  private async transcribeVoiceNotes(message: DiscordMessage): Promise<string | undefined> {
    const clips = message.attachments.filter(attachment => attachment.isVoiceMessage
      || (attachment.contentType?.startsWith('audio/') ?? false))
    if (clips.length === 0) return undefined

    const bin = process.env.DSH_WHISPER_BIN ?? '/opt/whisper.cpp/build/bin/whisper-cli'
    const model = process.env.DSH_WHISPER_MODEL ?? '/opt/whisper.cpp/models/ggml-tiny.en.bin'
    const dir = await mkdtemp(path.join(tmpdir(), 'dsh-voice-'))
    try {
      const parts: string[] = []
      let index = 0
      for (const clip of clips) {
        index += 1
        const ext = path.extname(clip.filename) || '.ogg'
        const rawPath = path.join(dir, `clip-${index}${ext}`)
        const wavPath = path.join(dir, `clip-${index}.wav`)
        const response = await fetch(clip.url)
        if (!response.ok || response.body === null) {
          throw new Error(`downloading the audio failed (${response.status})`)
        }
        await pipeline(response.body, createWriteStream(rawPath))
        // whisper-cli needs 16 kHz mono WAV; ffmpeg converts anything else. When
        // the clip is already 16 kHz mono WAV the convert is a cheap copy.
        await new Promise<void>((resolve, reject) => {
          execFile('ffmpeg', ['-y', '-i', rawPath, '-ar', '16000', '-ac', '1', wavPath],
            { timeout: 60_000 }, error => error === null ? resolve() : reject(new Error('converting the audio failed')));
        })
        const text = await new Promise<string>((resolve, reject) => {
          execFile(bin, ['-m', model, '-nt', '-l', 'en', wavPath],
            { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
              if (error !== null) { reject(new Error('transcription failed')); return }
              resolve(stdout.trim())
            });
        })
        if (text !== '') parts.push(text)
      }
      return parts.length === 0 ? undefined : `[voice] ${parts.join(' ')}`
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  /**
   * Attribute one message to its speaker.
   *
   * This prefix is the whole multi-user mechanism: it is what lets one shared
   * session tell the family apart. An unrostered sender is marked as such so
   * the butler does not file their request against a member.
   * @param message - the inbound message.
   * @returns the text to put in the agent's inbox.
   */
  attribute(message: DiscordMessage): string {
    const member = this.ctx.household.byDiscordId(message.author.id)
    const speaker = member?.displayName ?? `${describeSender(message)} (not in the family roster)`
    return `[${speaker}] ${message.content.trim()}`
  }

  /** Route one message through its room's agent and send the reply back. */
  private async deliver(message: DiscordMessage): Promise<void> {
    const room = message.channelId
    try {
      await this.queueTurn(room, {
        text: this.attribute(message),
        source: { kind: 'user' },
        channel: message.channel,
        typingFor: message,
      })
    } catch (error) {
      const text = `I hit a problem answering that: ${error instanceof Error ? error.message : String(error)}`
      await this.post(room, text, message.channel).catch(() => undefined)
    }
  }

  /**
   * Run one turn in a room's session, in order, and post whatever comes back.
   *
   * Every turn in a room goes through this one promise chain, whoever started it.
   * That is what keeps a scheduled prompt from arriving in the middle of the
   * butler answering somebody: the second turn waits for the first to finish
   * rather than interleaving with it.
   * @param room - Discord channel id.
   * @param turn - the text to deliver, how to attribute it, and where to reply.
   * @returns the reply text, or `undefined` when the butler said nothing.
   */
  private async queueTurn(room: string, turn: RoomTurn): Promise<string | undefined> {
    return await this.turns.run(room, async () => {
      const handle = await this.agentFor(room)
      const agent = handle.agent
      await agent.whenIdle()
      const firstSeq = agent.session.seq
      const typing = turn.typingFor !== undefined && this.config.typingIndicator !== false
        ? this.startTyping(turn.typingFor)
        : undefined
      try {
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: turn.text }] as never,
          source: turn.source,
        }))
        await agent.whenIdle()
      } finally {
        typing?.()
      }
      if (this.stopped) return undefined
      const reply = lastAssistantText(agent.session.events, firstSeq)
      if (reply.trim() === '') return undefined
      await this.post(room, reply, turn.channel)
      return reply
    })
  }

  /** Keep the typing indicator alive while the model works; returns a stopper. */
  private startTyping(message: DiscordMessage): () => void {
    const channel = message.channel
    if (channel?.sendTyping === undefined) return () => undefined
    const send = (): void => {
      void channel.sendTyping?.().catch(() => undefined)
    }
    send()
    // Discord's indicator lapses after about ten seconds.
    const interval = setInterval(send, 8_000)
    return () => {
      clearInterval(interval)
    }
  }

  /** Send text to a room, splitting it into messages Discord accepts. */
  private async post(channelId: string, text: string, known?: Channel): Promise<void> {
    const chunks = splitForDiscord(text)
    if (chunks.length === 0) return
    const channel = known ?? await this.client?.fetchChannel(channelId)
    if (channel === undefined) {
      throw new Error(`cannot post to Discord channel ${channelId}: the bot cannot see it`)
    }
    for (const chunk of chunks) {
      await channel.send(chunk)
    }
  }

  /**
   * Say something in a room without being asked, for scheduled digests and
   * reminders.
   * @param channelId - the room to post in.
   * @param text - what to say; split automatically if long.
   */
  async announce(channelId: string, text: string): Promise<void> {
    if (this.client === undefined) {
      throw new Error('dsh-channel-discord is not connected, so there is nothing to announce to yet')
    }
    await this.post(channelId, text)
  }

  /**
   * Run a prompt in a room's own session and post whatever the butler says.
   *
   * This is how a plugin gets the butler to **start** a conversation rather than
   * answer one. `announce` posts fixed text and the model never sees it; this
   * puts a turn in the room's inbox, so the butler can look things up, decide
   * what is worth raising, and be followed up on afterwards by the family.
   *
   * The turn runs in the room's shared session on purpose. A separate session —
   * a subagent, say — would keep the planning conversation out of the transcript
   * the family is actually having, and the butler would not remember next week
   * that the coast was discussed. It is queued on the same chain as inbound
   * messages, so it cannot land halfway through the butler answering someone.
   *
   * The message is attributed to this plugin rather than dressed up as a family
   * member, because the model should be able to tell that nobody asked.
   *
   * A failure is thrown rather than posted. Nobody requested this, so an error
   * message in the room would be unexplained noise; the caller can decide whether
   * to try again on its next pass.
   * @param channelId - the room to run it in.
   * @param text - instructions for the butler, in the second person.
   * @returns what the butler said, or `undefined` if it said nothing.
   */
  async prompt(channelId: string, text: string): Promise<string | undefined> {
    if (this.client === undefined) {
      throw new Error('dsh-channel-discord is not connected, so there is no room to speak in yet')
    }
    return await this.queueTurn(channelId, {
      text,
      source: { kind: 'plugin', plugin: PLUGIN_NAME },
    })
  }

  /**
   * One agent per room, resumed where possible.
   *
   * The session id is derived from the channel, not the speaker, which is what
   * gives the family a shared thread the butler can follow. Because that id is
   * stable across restarts, the room's transcript is still on disk when the
   * process comes back — so this **resumes** rather than creating, and the
   * butler remembers Thursday's conversation on Friday.
   *
   * Resume is attempted first and `create` is the fallback, because the two
   * failure cases are indistinguishable from here and both want the same
   * answer: a room's very first message has no session to load, and a bundle
   * without session persistence mounted can never load one. Falling back keeps
   * the butler working in both cases instead of refusing to answer.
   */
  private agentFor(room: string): Promise<AgentHandle> {
    const existing = this.agents.get(room)
    if (existing !== undefined) return existing
    const started = this.startAgent(room, this.sessionIdFor(room))
    this.agents.set(room, started)
    started.catch(() => this.agents.delete(room))
    return started
  }

  /** The room's durable session identity. Stable across restarts by design. */
  private sessionIdFor(room: string): SessionId {
    return SessionId(roomSessionId(this.config.channelName, room))
  }

  /**
   * Resume the room's persisted session, or start a fresh one if there is
   * nothing to resume. Either way `discord/session` records which happened.
   */
  private async startAgent(room: string, sessionId: SessionId): Promise<AgentHandle> {
    const selection = this.ctx.agentDefaultModel.currentSelection()
    const agentOptions = { provider: selection.provider, model: selection.model }
    const setup = (agentCtx: Context) => {
      const selected: ModelSelectionRef = { current: selection, assembled: undefined }
      installModelSelection(agentCtx, selected)
    }
    const started = await startRoomSession<AgentHandle>({
      resume: () => this.ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup }),
      create: () => this.ctx.agents.create({
        sessionId,
        meta: { cwd: process.cwd() },
        agentOptions,
        setup,
      }),
    })
    this.ctx.emit('discord/session', {
      channelId: room,
      sessionId,
      resumed: started.resumed,
      ...started.reason === undefined ? {} : { reason: started.reason },
    })
    return started.handle
  }
}

// Service packages default-export their service class and nothing else
// plugin-shaped: mixing a default export with a function-plugin `apply` makes
// the Loader drop the plugin namespace.
export default DiscordChannel
