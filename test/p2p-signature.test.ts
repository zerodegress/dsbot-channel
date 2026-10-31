import { describe, expect, test } from 'vitest'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import { DedupeTable } from '../src/adapters/p2p/p2p-dedupe.js'
import { handleMessage } from '../src/adapters/p2p/p2p-protocol.js'
import type { HandleInput, P2PConfig } from '../src/adapters/p2p/p2p-protocol.js'

const fakeCredentials = (values: Record<string, string>) => ({
  resolve: async (reference: string) => {
    const value = values[reference]
    if (!value) throw new Error('missing')
    return { value }
  },
})

const secret = 'peer-secret-1'

const config: P2PConfig = {
  botName: 'bot-a',
  peers: [{ instance: 'inst-b', secret: 'P2P_B_SECRET' }],
  credentials: fakeCredentials({ P2P_B_SECRET: secret }),
  inflightTtlMs: 300_000,
  now: () => 1_700_000_000_000,
  maxBodyBytes: 64 * 1024,
}

const payload = {
  eventId: 'evt-1',
  to: 'bot-a',
  sender: 'bot-b',
  instance: 'inst-b',
  body: 'hello',
  sentAt: 1_700_000_000_000,
}

function table(): DedupeTable {
  return new DedupeTable({ ttlMs: 1000, limit: 10, inflightTtlMs: 300_000, maxTurnMs: 120_000 })
}

describe('signature authentication through handleMessage', () => {
  test('accepts a request signed over eventId, sentAt and the body', async () => {
    const signature = signEnvelope(secret, payload as unknown as Envelope)
    const input: HandleInput = { config, table: table(), auth: { signature, claimedInstance: 'inst-b' }, payload }
    const result = await handleMessage(input)
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
  })

  test('still rejects a signature made over a different body', async () => {
    const signature = signEnvelope(secret, { ...payload, body: 'tampered' } as unknown as Envelope)
    const input: HandleInput = { config, table: table(), auth: { signature, claimedInstance: 'inst-b' }, payload }
    const result = await handleMessage(input)
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })
})

describe('signature encoding', () => {
  test('emits and accepts a base64 signature', async () => {
    const signature = signEnvelope(secret, payload as unknown as Envelope)
    expect(signature).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    expect(signature).not.toMatch(/^[0-9a-f]{64}$/)
    const input: HandleInput = { config, table: table(), auth: { signature, claimedInstance: 'inst-b' }, payload }
    const result = await handleMessage(input)
    expect(result.ok).toBe(true)
  })

  test('rejects a hex encoded signature', async () => {
    const hex = Buffer.from(signEnvelope(secret, payload as unknown as Envelope), 'base64').toString('hex')
    const input: HandleInput = { config, table: table(), auth: { signature: hex, claimedInstance: 'inst-b' }, payload }
    const result = await handleMessage(input)
    expect(result).toMatchObject({ ok: false, status: 401 })
  })
})
