import { describe, expect, test } from 'vitest'
import { PUSH_WINDOW_MS, PushRouter, createSendText, describeChannels } from '../src/push-tool.js'
import type { PushChannel, PushDelivery, PushSource } from '../src/push-tool.js'
import type { SendResult } from '../src/p2p-send.js'

const channels: PushChannel[] = [
  {
    channel: 'p2p:orca',
    instance: 'orca',
    botName: 'orca',
    peers: [{ instance: 'seal', botName: 'seal' }, { instance: 'probe', botName: 'probe' }],
  },
  {
    channel: 'p2p:relay',
    instance: 'relay',
    botName: 'relay',
    peers: [{ instance: 'hive', botName: 'hive' }],
  },
]

function harness(options: { source?: PushSource | undefined; results?: SendResult[]; now?: () => number } = {}) {
  const deliveries: PushDelivery[] = []
  let count = 0
  const queued = [...(options.results ?? [])]
  const router = new PushRouter({
    channels,
    source: () => options.source,
    now: options.now,
    newId: () => {
      count += 1
      return `id-${count}`
    },
    async send(delivery) {
      deliveries.push(delivery)
      return queued.shift() ?? { ok: true, messageId: `m-${deliveries.length}`, duplicate: false }
    },
  })
  return { router, deliveries }
}

describe('addressing a push', () => {
  test('nothing given answers the peer that last messaged this session', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    const result = await router.push({ text: 'hi' }, 'session-1')

    expect(result).toEqual({ ok: true, messageId: 'm-1', channel: 'p2p:orca', scope: 'p2p', target: 'seal' })
    expect(deliveries).toEqual([
      { channel: 'p2p:orca', peer: 'seal', to: 'seal', text: 'hi', eventId: 'push:id-1' },
    ])
  })

  test('a target alone stays inside the channel of the current source', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    const result = await router.push({ text: 'hi', target: 'probe' }, 'session-1')

    expect(result).toMatchObject({ ok: true, channel: 'p2p:orca', target: 'probe' })
    expect(deliveries[0]?.to).toBe('probe')
  })

  test('a channel pushes across channels without a source', async () => {
    const { router, deliveries } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:relay', target: 'hive' })

    expect(result).toMatchObject({ ok: true, channel: 'p2p:relay', target: 'hive' })
    expect(deliveries[0]).toMatchObject({ channel: 'p2p:relay', peer: 'hive', to: 'hive' })
  })

  test('a channel this bot does not own is refused before anything is sent', async () => {
    const { router, deliveries } = harness()

    const result = await router.push({ text: 'hi', channel: 'qqbot:1905', target: 'x' })

    expect(result).toEqual({
      ok: false,
      code: 'unknown_channel',
      retryable: false,
      reason: 'channel "qqbot:1905" is not this bot\'s; known: p2p:orca, p2p:relay',
    })
    expect(deliveries).toHaveLength(0)
  })

  test('an unknown target is refused before anything is sent', async () => {
    const { router, deliveries } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:orca', target: 'nobody' })

    expect(result).toMatchObject({ ok: false, code: 'unknown_target', retryable: false })
    expect(deliveries).toHaveLength(0)
  })

  test('a channel with no target and no source to inherit is refused', async () => {
    const { router } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:orca' })

    expect(result).toMatchObject({ ok: false, code: 'no_target', retryable: false })
  })

  test('no channel and no source at all is refused', async () => {
    const { router } = harness()

    const result = await router.push({ text: 'hi' }, 'session-without-traffic')

    expect(result).toMatchObject({ ok: false, code: 'no_source', retryable: false })
  })

  test('a peer with no botName cannot be addressed', async () => {
    const bare: PushChannel[] = [
      { channel: 'p2p:orca', instance: 'orca', botName: 'orca', peers: [{ instance: 'seal' }] },
    ]
    const router = new PushRouter({
      channels: bare,
      source: () => undefined,
      async send() {
        throw new Error('must not send')
      },
    })

    const result = await router.push({ text: 'hi', channel: 'p2p:orca', target: 'seal' })

    expect(result).toMatchObject({ ok: false, code: 'unknown_target', retryable: false })
  })

  test('the scope a peer link carries is accepted', async () => {
    const { router } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    const result = await router.push({ text: 'hi', scope: 'p2p' }, 'session-1')

    expect(result).toMatchObject({ ok: true, scope: 'p2p' })
  })

  test.each(['c2c', 'group', 'nonsense'])('a scope the link does not carry is refused: %s', async (scope) => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    const result = await router.push({ text: 'hi', scope }, 'session-1')

    expect(result).toMatchObject({ ok: false, code: 'unsupported_scope', retryable: false })
    expect(deliveries).toHaveLength(0)
  })
})

describe('pushing twice with one key', () => {
  test('a delivered push holds the key and replays its message id', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    const first = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    const second = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')

    expect(second).toEqual(first)
    expect(deliveries).toHaveLength(1)
  })

  test('a failed push leaves the key free, so the retry really sends', async () => {
    const { router, deliveries } = harness({
      source: { channel: 'p2p:orca', peer: 'seal' },
      results: [{ ok: false, code: 'unreachable', retryable: true, reason: 'connect ECONNREFUSED' }],
    })

    const failed = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    const retried = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')

    expect(failed).toMatchObject({ ok: false, code: 'unreachable', retryable: true })
    expect(retried).toMatchObject({ ok: true })
    expect(deliveries).toHaveLength(2)
  })

  test('the key expires after the window and the push goes out again', async () => {
    let now = 1_000
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' }, now: () => now })

    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    now += PUSH_WINDOW_MS
    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')

    expect(deliveries).toHaveLength(2)
  })

  test('the wire id is its own counter, not the idempotency key', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', peer: 'seal' } })

    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    await router.push({ text: 'hi', idempotencyKey: 'k2' }, 'session-1')

    expect(deliveries.map((delivery) => delivery.eventId)).toEqual(['push:id-1', 'push:id-2'])
  })
})

describe('what this channel can do', () => {
  test('only send_text exists, because a peer link carries text alone', () => {
    const { router } = harness()

    expect(createSendText(router).name).toBe('send_text')
    expect(['send_file', 'send_image', 'read_history']).not.toContain(createSendText(router).name)
  })

  test('the description lists the channels and their peers', () => {
    expect(describeChannels(channels)).toBe('Channels: p2p:orca (peers: seal, probe); p2p:relay (peers: hive).')
    expect(describeChannels([])).toBe('No channel is configured, so this bot cannot send.')
  })
})
