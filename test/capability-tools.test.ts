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
import type { SendResult } from '../src/contract.js'

const channels: PushChannel[] = [
  { channel: 'p2p:a', instance: 'a', botName: 'a' },
  { channel: 'onebot:main', instance: 'main', botName: 'main' },
]

const addresses: Record<string, string[]> = {
  'p2p:a': ['peer-a'],
  'onebot:main': ['group:1'],
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

function harness(capabilities: Record<string, CapabilitySet | undefined>, source?: PushSource): Harness {
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
  const gate = new CapabilityGate({ router, capabilities: (channel) => capabilities[channel] })
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
    const result = await call(file, { url: 'https://example.test/a.txt', channel: 'onebot:main', target: 'group:1' })
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
    await call(gate.file, { url: 'https://example.test/a.txt', channel: 'p2p:a', target: 'peer-a' })
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
