import { describe, expect, test } from 'vitest'
import { DedupeTable } from '../src/p2p-dedupe.js'
import { ChannelStats } from '../src/channel-stats.js'
import { P2P_ROUTE, handleMessage, parseRequest } from '../src/p2p-protocol.js'
import { signBody } from '../src/p2p-auth.js'

const fakeCredentials = (values: Record<string, string>) => ({
  resolve: async (reference: string) => {
    const value = values[reference]
    if (!value) throw new Error('missing')
    return { value }
  },
})

const NOW = 1_700_000_000_000

const config = {
  botName: 'self-bot',
  peers: [{ instance: 'peer-a', secret: 'P2P_SECRET_A' }],
  credentials: fakeCredentials({ P2P_SECRET_A: 'secret-a' }),
  inflightTtlMs: 300_000,
  maxBodyBytes: 64 * 1024,
}

const request = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'e1',
  to: 'self-bot',
  sender: 'bot-a',
  instance: 'peer-a',
  body: 'hello',
  sentAt: NOW,
  ...overrides,
})

const auth = { authorization: 'Bearer secret-a', claimedInstance: 'peer-a' }

describe('the channel reports what happened to it', () => {
  test('an accepted delivery records the authentication time', async () => {
    const channel = new ChannelStats(() => NOW)
    const result = await handleMessage({
      config,
      table: new DedupeTable({ ttlMs: 60_000, limit: 100 }),
      auth: { authorization: 'Bearer secret-a', claimedInstance: 'peer-a' },
      payload: request(),
      stats: channel,
    })
    expect(result.ok).toBe(true)
    expect(channel.snapshot().lastAuthenticatedAt).toBe(NOW)
  })

  test('a refused delivery records why, and does not record an authentication', async () => {
    const channel = new ChannelStats(() => NOW)
    await handleMessage({
      config,
      table: new DedupeTable({ ttlMs: 60_000, limit: 100 }),
      auth: { authorization: 'Bearer wrong', claimedInstance: 'peer-a' },
      payload: request(),
      stats: channel,
    })
    const snapshot = channel.snapshot()
    expect(snapshot.lastAuthenticatedAt).toBeNull()
    expect(snapshot.lastFailure?.reason).toMatch(/bearer|credential|secret/)
  })

  test('a delivery still being processed is counted, and the count comes back down', async () => {
    const channel = new ChannelStats(() => NOW)
    let during = -1
    await handleMessage({
      config,
      table: new DedupeTable({ ttlMs: 60_000, limit: 100 }),
      auth: { authorization: 'Bearer secret-a', claimedInstance: 'peer-a' },
      payload: request(),
      stats: channel,
      process: () => {
        during = channel.snapshot().inFlight
        return Promise.resolve(true)
      },
    })
    expect(during).toBe(1)
    expect(channel.snapshot().inFlight).toBe(0)
  })

  test('a process that throws still brings the count back down', async () => {
    const channel = new ChannelStats(() => NOW)
    await expect(
      handleMessage({
        config,
        table: new DedupeTable({ ttlMs: 60_000, limit: 100 }),
        auth: { authorization: 'Bearer secret-a', claimedInstance: 'peer-a' },
        payload: request(),
        stats: channel,
        process: () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toThrow('boom')
    expect(channel.snapshot().inFlight).toBe(0)
  })

  test('without a collector nothing breaks', async () => {
    const result = await handleMessage({
      config,
      table: new DedupeTable({ ttlMs: 60_000, limit: 100 }),
      auth: { authorization: 'Bearer secret-a', claimedInstance: 'peer-a' },
      payload: request(),
    })
    expect(result.ok).toBe(true)
  })
})

describe('route', () => {
  test('is the v1 message endpoint', () => {
    expect(P2P_ROUTE).toBe('/p2p/v1/message')
  })
})

describe('parseRequest', () => {
  test('accepts a well formed body', () => {
    const parsed = parseRequest(request())
    expect(parsed.ok).toBe(true)
  })

  test('rejects a body over 64 KiB with 413', () => {
    const parsed = parseRequest(request({ body: 'x'.repeat(64 * 1024 + 1) }))
    expect(parsed).toMatchObject({ ok: false, status: 413 })
  })

  test('rejects a missing eventId', () => {
    expect(parseRequest(request({ eventId: undefined }))).toMatchObject({ ok: false, status: 400 })
  })

  test('rejects a non numeric sentAt', () => {
    expect(parseRequest(request({ sentAt: 'yesterday' }))).toMatchObject({ ok: false, status: 400 })
  })
})

describe('handleMessage', () => {
  const ok = (overrides: Record<string, unknown> = {}) => ({ ...request(), ...overrides })

  test('returns a messageId derived from the eventId', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const result = await handleMessage({ config, table, auth, payload: ok() })
    expect(result).toMatchObject({ ok: true, body: { messageId: 'p2p-e1', duplicate: false } })
  })

  test('a repeated event echoes the first messageId', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    await handleMessage({ config, table, auth, payload: ok() })
    const again = await handleMessage({ config, table, auth, payload: ok() })
    expect(again).toMatchObject({ ok: true, body: { duplicate: true, messageId: 'p2p-e1', eventId: 'e1' } })
  })

  test('rejects a message addressed to another bot with 403', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const result = await handleMessage({ config, table, auth, payload: ok({ to: 'other-bot' }) })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('rejects a body that claims another instance', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const result = await handleMessage({ config, table, auth, payload: ok({ instance: 'peer-b' }) })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('rejects an unauthenticated call', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const result = await handleMessage({ config, table, auth: { authorization: null, claimedInstance: 'peer-a' }, payload: ok() })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('a concurrent duplicate waits for the first instead of processing twice', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    let release: (value: boolean) => void = () => {}
    let processed = 0
    const fast = { ...config, waitMs: 2000 }
    const first = handleMessage({
      config: fast,
      table,
      auth,
      payload: ok(),
      process: () => { processed += 1; return new Promise<boolean>((resolve) => { release = resolve }) },
    })
    await new Promise((resolve) => setImmediate(resolve))
    const second = handleMessage({ config: fast, table, auth, payload: ok() })
    await new Promise((resolve) => setImmediate(resolve))
    release(true)
    const [a, b] = await Promise.all([first, second])
    expect(processed).toBe(1)
    expect(a).toMatchObject({ ok: true, body: { duplicate: false, messageId: 'p2p-e1' } })
    expect(b).toMatchObject({ ok: true, body: { duplicate: true, messageId: 'p2p-e1' } })
  })

  test('a signed request with a valid signature is accepted', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const signed = { ...request(), body: 'hello', sentAt: 1_700_000_000_000 }
    const signature = signBody('secret-a', { eventId: signed.eventId, sentAt: signed.sentAt, body: signed.body })
    const result = await handleMessage({ config, table, auth: { signature, claimedInstance: 'peer-a' }, payload: signed })
    expect(result).toMatchObject({ ok: true, status: 200, body: { messageId: 'p2p-e1' } })
  })

  test('a signature over a different body is rejected', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const signed = { ...request(), body: 'hello', sentAt: 1_700_000_000_000 }
    const signature = signBody('secret-a', { eventId: signed.eventId, sentAt: signed.sentAt, body: 'tampered' })
    const result = await handleMessage({ config, table, auth: { signature, claimedInstance: 'peer-a' }, payload: signed })
    expect(result).toMatchObject({ ok: false, status: 401 })
  })

  test('the waiter receives 503 when the first call outlives the wait', async () => {
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
    const first = handleMessage({
      config: { ...config, waitMs: 10 },
      table,
      auth,
      payload: ok(),
      process: () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 60)),
    })
    const second = await handleMessage({ config: { ...config, waitMs: 10 }, table, auth, payload: ok() })
    await first
    expect(second).toMatchObject({ ok: false, status: 503 })
  })
})

describe('inflight expiry', () => {
  test('a reservation from a crashed handler is retried instead of returning 503 forever', async () => {
    let now = 1_000
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000, inflightTtlMs: 300_000, maxTurnMs: 120_000, now: () => now })
    const stuck = await table.claim('peer-a|self-bot|e1', 10)
    expect(stuck.done).toBe(false)
    expect(table.inflightSize()).toBe(1)
    now += 300_001
    const retry = await table.claim('peer-a|self-bot|e1', 10)
    expect(retry.done).toBe(false)
    expect(table.inflightSize()).toBe(1)
  })

  test('a fresh reservation still makes the duplicate wait', async () => {
    let now = 1_000
    const table = new DedupeTable({ ttlMs: 604_800_000, limit: 100_000, inflightTtlMs: 300_000, maxTurnMs: 120_000, now: () => now })
    await table.claim('k', 10)
    now += 1_000
    const second = await table.claim('k', 20)
    expect(second).toEqual({ done: true, entry: null })
  })
})

describe('inflight TTL', () => {
  test('must exceed maxTurnMs at load time', () => {
    expect(() => new DedupeTable({ ttlMs: 1000, limit: 10, inflightTtlMs: 60_000, maxTurnMs: 120_000 })).toThrow(/maxTurnMs/)
  })

  test('the default 5 minutes clears a 120 second turn', () => {
    expect(() => new DedupeTable({ ttlMs: 1000, limit: 10, inflightTtlMs: 300_000, maxTurnMs: 120_000 })).not.toThrow()
  })
})
