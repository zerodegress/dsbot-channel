import { describe, expect, test } from 'vitest'
import {
  CapabilityGate,
  UNSUPPORTED_CAPABILITY,
  createReadHistory,
  createSendFile,
  createSendImage,
} from '../src/capability-tools.js'
import { PushRouter } from '../src/push-tool.js'
import type { PushChannel, PushSource } from '../src/push-tool.js'
import type { CapabilitySet } from '../src/adapter-status.js'
import { NO_MEDIA } from '../src/adapter-status.js'
import type { HistoryInput, HistoryResult, SendResult } from '../src/contract.js'

const channels: PushChannel[] = [
  { channel: 'p2p:a', instance: 'a', botName: 'a' },
  { channel: 'onebot:main', instance: 'main', botName: 'main' },
]

const addresses: Record<string, string[]> = {
  'p2p:a': ['peer-a'],
  'onebot:main': ['group:1', 'peer:9'],
}

function caps(over: Partial<CapabilitySet> = {}): CapabilitySet {
  return {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: { group: false, private: false },
    mention: false,
    reply: true,
    stream: false,
    ...over,
  }
}

interface Harness {
  image: ReturnType<typeof createSendImage>
  file: ReturnType<typeof createSendFile>
  history: ReturnType<typeof createReadHistory>
  sends: unknown[]
}

function harness(
  capabilities: Record<string, CapabilitySet | undefined>,
  source?: PushSource,
  history?: (channel: string, input: HistoryInput) => Promise<HistoryResult>,
): Harness {
  const sends: unknown[] = []
  const router = new PushRouter({
    channels,
    source: () => source,
    checkTarget: (channel, target) =>
      (addresses[channel] ?? []).includes(target) ? undefined : `this adapter addresses no peer "${target}"`,
    describeTargets: (channel) => (addresses[channel] ?? []).join(', '),
    async send(delivery): Promise<SendResult> {
      sends.push(delivery)
      return { ok: true, messageId: 'sent-1', duplicate: false }
    },
  })
  const gate = new CapabilityGate({
    router,
    capabilities: (channel) => capabilities[channel],
    ...(history === undefined ? {} : { history }),
  })
  return {
    image: createSendImage(gate),
    file: createSendFile(gate),
    history: createReadHistory(gate),
    sends,
  }
}

async function call(tool: { execute: (args: never, exec: never) => Promise<unknown> }, args: object): Promise<Record<string, unknown>> {
  return JSON.parse((await tool.execute(args as never, {} as never)) as string) as Record<string, unknown>
}

const empty = { 'p2p:a': caps(), 'onebot:main': caps() }

describe('a tool whose capability the channel never declared', () => {
  test('send_image names the image bit and the channel', async () => {
    const { image } = harness(empty)
    const result = await call(image, { url: 'https://example.test/a.png', channel: 'p2p:a', target: 'peer-a' })
    expect(result).toMatchObject({ ok: false, code: UNSUPPORTED_CAPABILITY, retryable: false })
    expect(result.reason).toContain('capabilities.image.out is false')
    expect(result.reason).toContain('p2p:a')
  })

  test('send_file names the file bit and the channel', async () => {
    const { file } = harness(empty)
    const result = await call(file, {
      url: 'https://example.test/a.txt',
      name: 'a.txt',
      channel: 'onebot:main',
      target: 'group:1',
    })
    expect(result).toMatchObject({ ok: false, code: UNSUPPORTED_CAPABILITY })
    expect(result.reason).toContain('capabilities.file.out is false')
    expect(result.reason).toContain('onebot:main')
  })

  test('read_history names the history bit and the channel', async () => {
    const { history } = harness(empty)
    const result = await call(history, { channel: 'onebot:main', target: 'group:1', limit: 20 })
    expect(result).toMatchObject({ ok: false, code: UNSUPPORTED_CAPABILITY })
    expect(result.reason).toContain('capabilities.history.group and .private are both false')
    expect(result.reason).toContain('onebot:main')
  })

  test('a capability the adapter never declared is read as false, not as a promise', async () => {
    const partial = { 'p2p:a': { text: true, reply: true } as CapabilitySet }
    const { image } = harness(partial)
    const result = await call(image, { url: 'https://example.test/a.png', channel: 'p2p:a', target: 'peer-a' })
    expect(result).toMatchObject({ ok: false, code: UNSUPPORTED_CAPABILITY })
  })

  test('nothing is sent on a refused call', async () => {
    const gate = harness(empty)
    await call(gate.image, { url: 'https://example.test/a.png', channel: 'p2p:a', target: 'peer-a' })
    await call(gate.file, { url: 'https://example.test/a.txt', name: 'a.txt', channel: 'p2p:a', target: 'peer-a' })
    await call(gate.history, { channel: 'p2p:a', target: 'peer-a' })
    expect(gate.sends).toEqual([])
  })
})

describe('the gate is read at call time, on the channel the call names', () => {
  test('two channels answer differently in the same build', async () => {
    const { image } = harness({ 'p2p:a': caps(), 'onebot:main': caps({ image: { ...NO_MEDIA, out: true, fromUrl: true } }) })
    const refused = await call(image, { url: 'https://example.test/a.png', channel: 'p2p:a', target: 'peer-a' })
    const declared = await call(image, { url: 'https://example.test/a.png', channel: 'onebot:main', target: 'group:1' })
    expect(refused.reason).toContain('capabilities.image.out is false')
    expect(declared.code).toBe(UNSUPPORTED_CAPABILITY)
    expect(declared.reason).toContain('no sender')
  })

  test('a transport that can send images only from a handle says which source is missing', async () => {
    const { image } = harness({ 'p2p:a': caps(), 'onebot:main': caps({ image: { ...NO_MEDIA, out: true } }) })
    const result = await call(image, { url: 'https://example.test/a.png', channel: 'onebot:main', target: 'group:1' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(result.reason).toContain('capabilities.image.fromUrl is false')
  })

  test('without a channel the session source is used, exactly as send_text does', async () => {
    const { image, history } = harness(empty, { channel: 'p2p:a', replyTarget: 'peer-a' })
    const result = await call(image, { url: 'https://example.test/a.png' })
    expect(result).toMatchObject({ code: UNSUPPORTED_CAPABILITY })
    expect(result.reason).toContain('p2p:a')
    const read = await call(history, {})
    expect(read.reason).toContain('p2p:a')
  })
})

describe('an argument that cannot become a request', () => {
  test('a local path is not a url', async () => {
    const { image, file } = harness(empty)
    const path = await call(image, { url: '/tmp/a.png', channel: 'p2p:a', target: 'peer-a' })
    expect(path).toMatchObject({ ok: false, code: 'unsupported_argument' })
    expect(path.reason).toContain('local path')
    const relative = await call(file, { url: './a.txt', channel: 'p2p:a', target: 'peer-a' })
    expect(relative).toMatchObject({ code: 'unsupported_argument' })
  })

  test('a limit that is not a whole number of at least one', async () => {
    const { history } = harness(empty)
    for (const limit of [0, -3, 1.5]) {
      const result = await call(history, { channel: 'p2p:a', target: 'peer-a', limit })
      expect(result).toMatchObject({ ok: false, code: 'unsupported_argument' })
    }
  })

  test('a channel this bot does not run, and a session with no source', async () => {
    const { image } = harness(empty)
    const unknown = await call(image, { url: 'https://example.test/a.png', channel: 'nope', target: 'x' })
    expect(unknown).toMatchObject({ ok: false, code: 'unknown_channel' })
    const orphan = await call(image, { url: 'https://example.test/a.png' })
    expect(orphan).toMatchObject({ ok: false, code: 'no_source' })
  })

})

describe('reading history asks the adapter, never the address', () => {
  const calls: { channel: string; input: HistoryInput }[] = []
  const reader = (channel: string, input: HistoryInput): Promise<HistoryResult> => {
    calls.push({ channel, input })
    return Promise.resolve({ ok: true, records: [] })
  }

  test('a transport with one segment open is asked for any address it accepts', async () => {
    calls.length = 0
    const groupOnly = harness(
      { 'onebot:main': caps({ history: { group: true, private: false } }) },
      undefined,
      reader,
    )

    const peer = await call(groupOnly.history, { channel: 'onebot:main', target: 'peer:9', limit: 5 })
    expect(peer).toEqual({ ok: true, records: [] })
    expect(calls).toEqual([{ channel: 'onebot:main', input: { target: 'peer:9', limit: 5 } }])
  })

  test('both segments closed refuses before the adapter is asked', async () => {
    calls.length = 0
    const closed = harness({ 'onebot:main': caps() }, undefined, reader)

    const refused = await call(closed.history, { channel: 'onebot:main', target: 'group:1', limit: 5 })
    expect(refused).toMatchObject({ ok: false, code: UNSUPPORTED_CAPABILITY })
    expect(refused.reason).toContain('capabilities.history.group and .private are both false')
    expect(calls).toEqual([])
  })

  test('the limit is bounded rather than truncated', async () => {
    calls.length = 0
    const ready = harness(
      { 'onebot:main': caps({ history: { group: true, private: true } }) },
      undefined,
      reader,
    )

    for (const limit of [0, 2.5, 201]) {
      const refused = await call(ready.history, { channel: 'onebot:main', target: 'group:1', limit })
      expect(refused).toMatchObject({ ok: false, code: 'unsupported_argument' })
    }
    expect(calls).toEqual([])

    await call(ready.history, { channel: 'onebot:main', target: 'group:1' })
    await call(ready.history, { channel: 'onebot:main', target: 'group:1', limit: 200, before: 's9' })
    expect(calls).toEqual([
      { channel: 'onebot:main', input: { target: 'group:1', limit: 50 } },
      { channel: 'onebot:main', input: { target: 'group:1', limit: 200, before: 's9' } },
    ])
  })

})

describe('a file argument is answered before the capability', () => {
  test('a missing name is refused on a channel that could send it', async () => {
    const gate = harness({ 'onebot:main': caps({ file: { in: true, out: true, fromUrl: true, fromHandle: true } }) })
    const result = await call(gate.file, { url: 'https://example.test/a.txt', channel: 'onebot:main', target: 'group:1' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported_argument' })
    expect(result.reason).toContain('name')
    expect(gate.sends).toEqual([])
  })

  test('a missing name is still the first answer on a channel that cannot', async () => {
    const gate = harness(empty)
    const result = await call(gate.file, { url: 'https://example.test/a.txt', channel: 'p2p:a', target: 'peer-a' })
    expect(result).toMatchObject({ ok: false, code: 'unsupported_argument' })
    expect(result.reason).toContain('name')
    expect(gate.sends).toEqual([])
  })
})
