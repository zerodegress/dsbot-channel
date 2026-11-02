import { describe, expect, test } from 'vitest'
import { PUSH_WINDOW_MS, PushRouter, createSendText } from '../src/push-tool.js'
import type { PushChannel, PushDelivery, PushSource } from '../src/push-tool.js'
import type { SendResult } from '../src/contract.js'

const channels: PushChannel[] = [
  { channel: 'p2p:orca', instance: 'orca', botName: 'orca' },
  { channel: 'p2p:relay', instance: 'relay', botName: 'relay' },
]

const addresses: Record<string, string[]> = {
  'p2p:orca': ['seal', 'probe'],
  'p2p:relay': ['hive'],
}

function checkTarget(channel: string, target: string): string | undefined {
  const known = addresses[channel] ?? []
  return known.includes(target) ? undefined : `this adapter addresses no peer "${target}"`
}

function describeTargets(channel: string): string {
  return (addresses[channel] ?? []).join(', ')
}

function harness(options: { source?: PushSource | undefined; results?: SendResult[]; now?: () => number } = {}) {
  const deliveries: PushDelivery[] = []
  let count = 0
  const queued = [...(options.results ?? [])]
  const router = new PushRouter({
    channels,
    source: () => options.source,
    checkTarget,
    describeTargets,
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
  test('nothing given answers the address that last messaged this session', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal', sender: 'seal' } })

    const result = await router.push({ text: 'hi' }, 'session-1')

    expect(result).toEqual({ ok: true, messageId: 'm-1', channel: 'p2p:orca', target: 'seal' })
    expect(deliveries).toEqual([
      { channel: 'p2p:orca', target: 'seal', to: 'seal', text: 'hi', eventId: 'push:id-1' },
    ])
  })

  test('a target alone stays inside the channel of the current source', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })

    const result = await router.push({ text: 'hi', target: 'probe' }, 'session-1')

    expect(result).toMatchObject({ ok: true, channel: 'p2p:orca', target: 'probe' })
    expect(deliveries[0]?.target).toBe('probe')
  })

  test('a named channel sends to its own address', async () => {
    const { router, deliveries } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:relay', target: 'hive' })

    expect(result).toMatchObject({ ok: true, channel: 'p2p:relay', target: 'hive' })
    expect(deliveries[0]).toMatchObject({ channel: 'p2p:relay', target: 'hive' })
  })

  test('an unknown channel names the ones this bot has', async () => {
    const { router } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:gone', target: 'seal' })

    expect(result).toMatchObject({ ok: false, code: 'unknown_channel', retryable: false })
  })

  test('no channel and no source at all is refused', async () => {
    const { router } = harness()

    const result = await router.push({ text: 'hi' }, 'session-without-traffic')

    expect(result).toMatchObject({ ok: false, code: 'no_source', retryable: false })
  })

  test('an address the adapter cannot reach is refused with its reason', async () => {
    const { router } = harness()

    const result = await router.push({ text: 'hi', channel: 'p2p:orca', target: 'nobody' })

    expect(result).toMatchObject({ ok: false, code: 'unknown_target', retryable: false })
    if (!result.ok) expect(result.reason).toMatch(/addresses no peer "nobody"/)
  })

  test.each(['p2p', 'c2c', 'group', 'nonsense'])('a scope argument is refused as gone: %s', async (scope) => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })

    const result = await router.push({ text: 'hi', scope } as never, 'session-1')

    expect(result).toMatchObject({ ok: false, code: 'unsupported_argument', retryable: false })
    if (!result.ok) expect(result.reason).toMatch(/the scope argument is gone/)
    expect(deliveries).toHaveLength(0)
  })
})

describe('pushing twice with one key', () => {
  test('a delivered push holds the key and replays its message id', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })

    const first = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    const second = await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')

    expect(second).toEqual(first)
    expect(deliveries).toHaveLength(1)
  })

  test('a failed push leaves the key free, so the retry really sends', async () => {
    const { router, deliveries } = harness({
      source: { channel: 'p2p:orca', replyTarget: 'seal' },
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
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' }, now: () => now })

    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    now += PUSH_WINDOW_MS
    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')

    expect(deliveries).toHaveLength(2)
  })

  test('the wire id is its own counter, not the idempotency key', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })

    await router.push({ text: 'hi', idempotencyKey: 'k1' }, 'session-1')
    await router.push({ text: 'hi', idempotencyKey: 'k2' }, 'session-1')

    expect(deliveries.map((delivery) => delivery.eventId)).toEqual(['push:id-1', 'push:id-2'])
  })
})

describe('media on a push', () => {
  test('rides the delivery in order, with no owner invented', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })
    const media = [{ type: 'image' as const, url: 'https://example.test/a.png', handle: null }]
    await router.push({ text: 'look', media }, 'session-1')

    expect(deliveries[0]?.media).toEqual(media)
    expect(deliveries[0]?.text).toBe('look')
  })

  test('a push with no media carries no field at all', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })
    await router.push({ text: 'plain' }, 'session-1')
    expect('media' in (deliveries[0] ?? {})).toBe(false)
  })
})

describe('what this channel can do', () => {
  test('the text router builds the text tool alone', () => {
    const { router } = harness()

    expect(createSendText(router).name).toBe('send_text')
    expect(['send_file', 'send_image', 'read_history']).not.toContain(createSendText(router).name)
  })

  test('the tool layer refuses a call without text before anything is sent', async () => {
    const { router, deliveries } = harness({ source: { channel: 'p2p:orca', replyTarget: 'seal' } })

    await expect(createSendText(router).execute({} as never, {} as never)).rejects.toThrow()
    expect(deliveries).toHaveLength(0)
  })

  test('the description lists the channels and the addresses the adapter reports', () => {
    const { router } = harness()

    expect(router.describe()).toBe('Channels: p2p:orca (addresses: seal, probe); p2p:relay (addresses: hive).')
  })

  test('a router with no channel says nothing can be sent', () => {
    const router = new PushRouter({
      channels: [],
      source: () => undefined,
      checkTarget: () => undefined,
      describeTargets: () => '',
      async send() {
        throw new Error('must not send')
      },
    })

    expect(router.describe()).toBe('No channel is configured, so this bot cannot send.')
  })
})
