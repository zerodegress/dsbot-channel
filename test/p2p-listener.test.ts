import { afterEach, describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { DedupeTable } from '../src/p2p-dedupe.js'
import { checkListenerConfig, startListener } from '../src/p2p-listener.js'
import type { Listener, ListenerConfig } from '../src/p2p-listener.js'
import { P2P_ROUTE } from '../src/p2p-protocol.js'
import { signBody } from '../src/p2p-auth.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import type { InboundRequest } from '../src/p2p-inbound.js'

const secret = 'peer-secret-1'
const secretRef = 'PEER_SHARED_SECRET'

const baseConfig = (): ListenerConfig => ({
  botName: 'bot-a',
  peers: [{ instance: 'inst-b', secret: secretRef }],
  credentials: staticCredentials({ [secretRef]: secret }),
  inflightTtlMs: 300_000,
  maxBodyBytes: 64 * 1024,
  listen: { port: 0 },
})

const open: Listener[] = []

afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

function table(): DedupeTable {
  return new DedupeTable({ ttlMs: 1000, limit: 10, inflightTtlMs: 300_000, maxTurnMs: 120_000 })
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: P2P_ROUTE,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...headers },
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {} })
        })
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}

const message = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'evt-1',
  to: 'bot-a',
  sender: 'bot-b',
  instance: 'inst-b',
  body: 'hello',
  sentAt: 1_700_000_000_000,
  ...overrides,
})

describe('listener config', () => {
  test('defaults to loopback and refuses wildcard addresses before binding', () => {
    expect(checkListenerConfig({ ...baseConfig(), listen: {} })).toBe('127.0.0.1')
    expect(() => checkListenerConfig({ ...baseConfig(), listen: { host: '0.0.0.0' } })).toThrow(/wildcard/)
    expect(() => checkListenerConfig({ ...baseConfig(), listen: { host: '::' } })).toThrow(/wildcard/)
  })

  test('refuses to start without a peer secret', () => {
    expect(() => checkListenerConfig({ ...baseConfig(), peers: [] })).toThrow(/peer secret/)
  })
})

describe('listener', () => {
  test('accepts a bearer request and returns a message id', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ duplicate: false, messageId: 'p2p-evt-1', eventId: 'evt-1' })
  })

  test('echoes the first message id on a repeated delivery', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const port = listener.address().port
    await post(port, message(), { authorization: `Bearer ${secret}` })
    const second = await post(port, message(), { authorization: `Bearer ${secret}` })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ duplicate: true, messageId: 'p2p-evt-1' })
  })

  test('rejects a missing credential', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(401)
  })

  test('rejects a message addressed to another bot', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message({ to: 'bot-z' }), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(403)
  })

  test('rejects an oversized body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message({ body: 'x'.repeat(70 * 1024) }), {
      authorization: `Bearer ${secret}`,
    })
    expect(reply.status).toBe(413)
  })

  test('accepts a request signed over the raw body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const payload = message()
    const signature = signBody(secret, { eventId: payload.eventId, sentAt: payload.sentAt, body: payload.body })
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ duplicate: false, messageId: 'p2p-evt-1' })
  })

  test('rejects a signature that does not match the body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const payload = message()
    const signature = signBody(secret, { eventId: payload.eventId, sentAt: payload.sentAt, body: 'other' })
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(401)
  })

  test('answers unknown routes with 404', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: listener.address().port, path: '/nope', method: 'POST' },
        (response) => resolve(response.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end('{}')
    })
    expect(reply).toBe(404)
  })
})

describe('listener hand off', () => {
  test('hands a fresh message to the inbound hook with every field intact', async () => {
    const seen: InboundRequest[] = []
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: (request) => {
        seen.push(request)
      },
    })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(200)
    expect(seen).toEqual([message()])
  })

  test('never hands over a duplicate or an unauthenticated delivery', async () => {
    const seen: InboundRequest[] = []
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: (request) => {
        seen.push(request)
      },
    })
    open.push(listener)
    const port = listener.address().port
    await post(port, message(), { authorization: `Bearer ${secret}` })
    await post(port, message(), { authorization: `Bearer ${secret}` })
    await post(port, message({ eventId: 'evt-2' }))
    expect(seen.map((request) => request.eventId)).toEqual(['evt-1'])
  })

  test('keeps a failed hand off retryable instead of losing the message', async () => {
    let attempts = 0
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: () => {
        attempts += 1
        if (attempts === 1) throw new Error('hand off failed')
      },
    })
    open.push(listener)
    const port = listener.address().port
    const first = await post(port, message(), { authorization: `Bearer ${secret}` })
    expect(first.status).toBe(500)
    const second = await post(port, message(), { authorization: `Bearer ${secret}` })
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ duplicate: false })
    expect(attempts).toBe(2)
  })
})
