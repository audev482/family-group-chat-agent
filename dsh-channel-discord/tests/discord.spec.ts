/**
 * The Discord channel: who gets answered, who is speaking, and how a long reply
 * survives a 2000-character limit.
 *
 * `splitForDiscord` is tested hard because a mangled split is the most visible
 * possible failure: the family sees a code fence broken in half, or a sentence
 * cut mid-word, every time the butler says something long.
 */

import { describe, expect, it, vi } from 'vitest'
import { describeSender, DISCORD_MESSAGE_LIMIT, splitForDiscord } from '../src/discord.ts'
import type { DiscordMessage } from '../src/discord.ts'
import { createSerialQueue, roomSessionId, startRoomSession } from '../src/session.ts'

/** A message with only the fields under test filled in. */
function message(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: 'm1',
    content: 'hello',
    channelId: 'c1',
    author: { id: 'u1', bot: false, username: 'alex', globalName: 'Alex Baker' },
    ...overrides,
  } as DiscordMessage
}

describe('describeSender', () => {
  it('prefers the display name a person chose', () => {
    expect(describeSender(message())).toBe('Alex Baker')
  })

  it('falls back to the username', () => {
    expect(describeSender(message({ author: { id: 'u1', bot: false, username: 'alex' } }))).toBe('alex')
  })

  it('falls back to the id when there is nothing else', () => {
    expect(describeSender(message({ author: { id: 'u9', bot: false } }))).toBe('u9')
  })
})

describe('splitForDiscord', () => {
  it('returns a short message unchanged, as one part', () => {
    expect(splitForDiscord('Parents evening is on Thursday.')).toEqual(['Parents evening is on Thursday.'])
  })

  it('never exceeds the limit', () => {
    const parts = splitForDiscord('word '.repeat(2000))
    expect(parts.every(part => part.length <= DISCORD_MESSAGE_LIMIT)).toBe(true)
    expect(parts.length).toBeGreaterThan(1)
  })

  it('loses nothing: every word survives the split', () => {
    const text = Array.from({ length: 600 }, (_value, index) => `line-${index}`).join('\n')
    expect(splitForDiscord(text).join('\n')).toContain('line-0')
    expect(splitForDiscord(text).join('\n')).toContain('line-599')
  })

  it('prefers to break at a paragraph boundary', () => {
    const paragraph = `${'a'.repeat(1500)}\n\n${'b'.repeat(1000)}`
    const parts = splitForDiscord(paragraph)
    expect(parts[0]).toBe('a'.repeat(1500))
    expect(parts[1]).toBe('b'.repeat(1000))
  })

  it('breaks at a line boundary when there is no paragraph break', () => {
    const lines = `${'a'.repeat(1500)}\n${'b'.repeat(1000)}`
    const parts = splitForDiscord(lines)
    expect(parts[0]).toBe('a'.repeat(1500))
  })

  it('breaks at a space rather than mid-word', () => {
    const text = `${'a'.repeat(1990)} ${'b'.repeat(500)}`
    const parts = splitForDiscord(text)
    expect(parts[0]?.endsWith('a')).toBe(true)
    expect(parts[1]?.startsWith('b')).toBe(true)
  })

  it('splits mid-word rather than emitting a nearly empty part', () => {
    // A single unbroken token longer than the limit has to be cut somewhere.
    const parts = splitForDiscord('x'.repeat(5000))
    expect(parts).toHaveLength(3)
    expect(parts[0]?.length).toBe(DISCORD_MESSAGE_LIMIT)
  })

  it('closes and reopens a code fence that a split would otherwise break', () => {
    const code = `Here is the list:\n\`\`\`\n${'const line = 1\n'.repeat(200)}\`\`\`\nThat is all.`
    const parts = splitForDiscord(code)
    expect(parts.length).toBeGreaterThan(1)
    // Every part must have a balanced number of fences, or Discord renders the
    // rest of the conversation as code.
    for (const part of parts) {
      expect((part.match(/```/g) ?? []).length % 2).toBe(0)
    }
  })

  it('honours a smaller limit when given one', () => {
    const parts = splitForDiscord('one two three four five six', 10)
    expect(parts.every(part => part.length <= 10)).toBe(true)
    expect(parts.join(' ')).toContain('six')
  })

  it('returns nothing for an empty message rather than an empty part', () => {
    expect(splitForDiscord('')).toEqual([])
    expect(splitForDiscord('   ')).toEqual([])
  })
})

describe('roomSessionId', () => {
  it('derives the id from the channel, so the whole room shares one thread', () => {
    expect(roomSessionId('butler', 'c1')).toBe('butler-c1')
  })

  it('gives different rooms different sessions', () => {
    expect(roomSessionId('butler', 'c1')).not.toBe(roomSessionId('butler', 'c2'))
  })

  it('defaults the prefix when no channel name is configured', () => {
    expect(roomSessionId(undefined, 'c1')).toBe('discord-c1')
  })

  // The point of the whole resume path: an id that varied per process could
  // never find yesterday's transcript, and the family would find the butler
  // had forgotten every conversation on every restart.
  it('is stable across calls, so a restart can find the same session', () => {
    const first = roomSessionId('butler', 'c1')
    const second = roomSessionId('butler', 'c1')
    expect(first).toBe(second)
  })
})

describe('startRoomSession', () => {
  it('resumes the room thread when there is one to resume', async () => {
    const create = vi.fn(async () => 'fresh')
    const started = await startRoomSession({ resume: async () => 'resumed', create })
    expect(started).toEqual({ handle: 'resumed', resumed: true })
    expect(create).not.toHaveBeenCalled()
  })

  it('begins a fresh session when there is nothing to resume', async () => {
    const started = await startRoomSession({
      resume: async () => { throw new Error('session not found') },
      create: async () => 'fresh',
    })
    expect(started.handle).toBe('fresh')
    expect(started.resumed).toBe(false)
  })

  // A room's first message and an unmounted persistence plugin look identical
  // from here, so the reason is what tells an operator which one it was.
  it('reports why resume was not possible', async () => {
    const started = await startRoomSession({
      resume: async () => { throw new Error('session persistence is not configured') },
      create: async () => 'fresh',
    })
    expect(started.reason).toBe('session persistence is not configured')
  })

  it('reports a non-Error rejection as a reason rather than losing it', async () => {
    const started = await startRoomSession({
      resume: async () => { throw 'nope' },
      create: async () => 'fresh',
    })
    expect(started.reason).toBe('nope')
  })

  it('carries no reason when the resume worked', async () => {
    const started = await startRoomSession({ resume: async () => 'resumed', create: async () => 'fresh' })
    expect(started.reason).toBeUndefined()
  })

  // Falling back covers a missing session, not a broken agent: if creating also
  // fails there is genuinely no way to answer, and swallowing it would leave
  // the family waiting on a reply that is never coming.
  it('propagates a create failure instead of swallowing it', async () => {
    await expect(startRoomSession({
      resume: async () => { throw new Error('no session') },
      create: async () => { throw new Error('provider unreachable') },
    })).rejects.toThrow('provider unreachable')
  })
})

describe('createSerialQueue', () => {
  /** A promise plus its resolver, so a test can hold work open deliberately. */
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }

  // The safety property behind prompt(): a scheduled turn must never land in the
  // middle of the butler answering somebody, because both would be writing to
  // one session at once.
  it('never overlaps two turns in the same room', async () => {
    const queue = createSerialQueue()
    const first = deferred<string>()
    const order: string[] = []

    const one = queue.run('room', async () => {
      order.push('one:start')
      const value = await first.promise
      order.push('one:end')
      return value
    })
    const two = queue.run('room', async () => {
      order.push('two:start')
      return 'two'
    })

    // The second turn must not have begun while the first is still open.
    await Promise.resolve()
    expect(order).toEqual(['one:start'])

    first.resolve('one')
    await Promise.all([one, two])
    expect(order).toEqual(['one:start', 'one:end', 'two:start'])
  })

  it('runs different rooms at the same time', async () => {
    const queue = createSerialQueue()
    const held = deferred<string>()
    const order: string[] = []

    const blocked = queue.run('room-a', async () => {
      order.push('a:start')
      return await held.promise
    })
    await queue.run('room-b', async () => {
      order.push('b:done')
      return 'b'
    })

    // Room B finished while room A was still waiting: one room cannot block another.
    expect(order).toEqual(['a:start', 'b:done'])
    held.resolve('a')
    await blocked
  })

  it('returns each turn its own result', async () => {
    const queue = createSerialQueue()
    await expect(queue.run('room', async () => 'reply')).resolves.toBe('reply')
  })

  it('reports a failure to the caller that queued it', async () => {
    const queue = createSerialQueue()
    await expect(queue.run('room', async () => { throw new Error('model down') }))
      .rejects.toThrow('model down')
  })

  // One bad turn must not silence a room until restart.
  it('still runs the next turn after one fails', async () => {
    const queue = createSerialQueue()
    const failed = queue.run('room', async () => { throw new Error('model down') })
    await expect(failed).rejects.toThrow('model down')
    await expect(queue.run('room', async () => 'still here')).resolves.toBe('still here')
  })

  it('keeps a failure in one room from affecting another', async () => {
    const queue = createSerialQueue()
    await expect(queue.run('room-a', async () => { throw new Error('nope') })).rejects.toThrow('nope')
    await expect(queue.run('room-b', async () => 'fine')).resolves.toBe('fine')
  })

  // A process that runs for months must not retain an entry for every channel it
  // has ever seen.
  it('forgets a room once its work is done', async () => {
    const queue = createSerialQueue()
    await queue.run('room', async () => 'done')
    expect(queue.size()).toBe(0)
  })

  it('forgets a room whose work failed', async () => {
    const queue = createSerialQueue()
    await expect(queue.run('room', async () => { throw new Error('nope') })).rejects.toThrow()
    expect(queue.size()).toBe(0)
  })

  it('holds one entry per busy room while work is in flight', async () => {
    const queue = createSerialQueue()
    const held = deferred<string>()
    const a = queue.run('room-a', async () => await held.promise)
    const b = queue.run('room-b', async () => await held.promise)
    expect(queue.size()).toBe(2)
    held.resolve('done')
    await Promise.all([a, b])
    expect(queue.size()).toBe(0)
  })
})
