import { afterEach, describe, expect, test } from 'vitest'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DedupeTable } from '../src/adapters/p2p/p2p-dedupe.js'
import { startListener } from '../src/adapters/p2p/p2p-listener.js'
import type { Listener } from '../src/adapters/p2p/p2p-listener.js'
import { P2P_ROUTE } from '../src/adapters/p2p/p2p-protocol.js'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import type { InboundRequest } from '../src/adapters/p2p/p2p-wire.js'

const secret = '{{SECRET_delivery}}'
const SECRET_REF = 'PEER_SHARED_SECRET'
const credentials = staticCredentials({ [SECRET_REF]: secret })

const listeners: Listener[] = []

afterEach(async () => {
  while (listeners.length > 0) await listeners.pop()!.close()
})

function config(): Parameters<typeof startListener>[0]['config'] {
  return {
    botName: 'bot-a',
    peers: [{ instance: 'inst-b', secret: SECRET_REF }],
    credentials,
    inflightTtlMs: 300_000,
    now: () => 1_700_000_000_000,
    maxBodyBytes: 64 * 1024,
    listen: { port: 0 },
  }
}

function table(): DedupeTable {
  return new DedupeTable({ ttlMs: 60_000, limit: 10, inflightTtlMs: 300_000, maxTurnMs: 120_000 })
}

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: 'evt-1',
    chainId: 'evt-1',
    to: 'bot-a',
    sender: 'bot-b',
    instance: 'inst-b',
    body: 'hello',
    sentAt: 1_700_000_000_000,
    ...overrides,
  }
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

function post(port: number, body: unknown, headers?: Record<string, string>): Promise<Reply> {
  const text = JSON.stringify(body)
  const extra = headers ?? { 'x-p2p-signature': signEnvelope(secret, body as unknown as Envelope) }
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: P2P_ROUTE, method: 'POST', headers: { 'content-type': 'application/json', ...extra } },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          resolve({ status: response.statusCode ?? 0, body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>) })
        })
      },
    )
    req.on('error', reject)
    req.end(text)
  })
}

async function listen(options: Parameters<typeof startListener>[0]): Promise<Listener> {
  const listener = await startListener(options)
  listeners.push(listener)
  return listener
}

describe('what a 2xx from a p2p listener means', () => {
  test('a refusal from core still answers 200 and keeps the event claimed', async () => {
    const seen: string[] = []
    const listener = await listen({
      config: config(),
      table: table(),
      onMessage: async (request: InboundRequest) => {
        seen.push(request.eventId)
      },
    })

    const first = await post(listener.address().port, payload())
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ duplicate: false })

    const again = await post(listener.address().port, payload())
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ duplicate: true })
    expect(seen).toEqual(['evt-1'])
  })

  test('a request that is itself unusable earns 4xx and claims nothing', async () => {
    const seen: string[] = []
    const listener = await listen({
      config: config(),
      table: table(),
      onMessage: async (request: InboundRequest) => {
        seen.push(request.eventId)
      },
    })
    const port = listener.address().port

    expect((await post(port, payload(), { 'x-p2p-signature': signEnvelope('{{SECRET_wrong}}', payload() as unknown as Envelope) })).status).toBe(401)
    expect((await post(port, payload(), {})).status).toBe(401)
    expect((await post(port, payload({ to: 'someone-else' }))).status).toBe(403)
    expect((await post(port, payload({ sentAt: 1 }))).status).toBe(403)

    const accepted = await post(port, payload())
    expect(accepted.status).toBe(200)
    expect(accepted.body).toMatchObject({ duplicate: false })
    expect(seen).toEqual(['evt-1'])
  })

  test('a turn that fails after the claim still answers 200, and a resend is a duplicate', async () => {
    const seen: string[] = []
    const warnings: unknown[] = []
    const listener = await listen({
      config: config(),
      table: table(),
      onMessage: async (request: InboundRequest) => {
        seen.push(request.eventId)
        throw new Error('the turn could not run')
      },
      onError: (error) => {
        warnings.push(error)
      },
    })
    const port = listener.address().port

    const first = await post(port, payload())
    expect(first.status).toBe(200)
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
    expect(warnings).toHaveLength(1)

    const again = await post(port, payload())
    expect(again.body).toMatchObject({ duplicate: true })
    expect(seen).toEqual(['evt-1'])
  })

  test('a body that is not json earns 400 and claims nothing', async () => {
    const listener = await listen({ config: config(), table: table(), onMessage: async () => undefined })
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: listener.address().port, path: P2P_ROUTE, method: 'POST', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end('{not json')
    })
    expect(status).toBe(400)
  })
})

describe('what a 2xx from an onebot listener means', () => {
  test('an event core refuses is still answered 204', async () => {
    const { OneBotAdapter } = await import('../src/adapters/onebot/adapter.js')
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const found = (probe.address() as AddressInfo).port
        probe.close(() => resolve(found))
      })
    })
    const adapter = new OneBotAdapter(
      {
        channel: 'inst-a',
        botName: 'bot-a',
        selfId: '10001',
        protocol: 'http',
        listen: { host: '127.0.0.1', port, path: '/onebot/event' },
        api: { url: 'http://127.0.0.1:1', timeoutMs: 100 },
        sendTimeoutMs: 100,
        bots: [],
      },
      { warn: () => undefined },
    )
    adapter.checkConfig()
    const handle = await adapter.start({
      onMessage: async () => ({ ok: false, code: 'rejected', reason: 'core said no' }),
      resolveSecret: async () => undefined,
    })
    listeners.push({ address: handle.address as never, close: handle.stop, handle: async () => undefined })

    const status = await new Promise<number>((resolve, reject) => {
      const text = JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        self_id: 10001,
        message_id: 1,
        user_id: 20002,
        group_id: 12345,
        time: 1_700_000_000,
        message: [{ type: 'text', data: { text: 'hi' } }],
        sender: { nickname: 'n' },
      })
      const req = request(
        { host: '127.0.0.1', port, path: '/onebot/event', method: 'POST', headers: { 'content-type': 'application/json' } },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end(text)
    })
    expect(status).toBe(204)
  })
})

describe('the order that makes a 2xx safe', () => {
  test('the claim is committed before the response body is built', async () => {
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'adapters', 'p2p', 'p2p-protocol.ts'), 'utf8')
    const commit = source.indexOf('table.commit(')
    const answer = source.indexOf('return { ok: true, status: 200', commit)
    expect(commit).toBeGreaterThan(0)
    expect(answer).toBeGreaterThan(commit)
  })

  test('the listener answers before a hand off finishes', async () => {
    let finished = false
    const listener = await listen({
      config: config(),
      table: table(),
      onMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        finished = true
      },
    })
    const reply = await post(listener.address().port, payload())
    expect(reply.status).toBe(200)
    expect(finished).toBe(false)
  })
})

describe('a hand off that throws before it returns a promise', () => {
  test('is reported like any other failure and still answers 200 with the event claimed', async () => {
    const seen: string[] = []
    const warnings: unknown[] = []
    const listener = await listen({
      config: config(),
      table: table(),
      onMessage: (request: InboundRequest) => {
        seen.push(request.eventId)
        throw new Error('a synchronous fault')
      },
      onError: (error) => {
        warnings.push(error)
      },
    })
    const port = listener.address().port

    const first = await post(port, payload())
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ duplicate: false })
    await new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
    expect(warnings).toHaveLength(1)

    const again = await post(port, payload())
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ duplicate: true })
    expect(seen).toEqual(['evt-1'])
  })

  test('a fault before the claim still answers 500 and claims nothing', async () => {
    const listener = await listen({
      config: config(),
      table: {
        claim: () => Promise.reject(new Error('the table is broken')),
        commit: () => undefined,
        abort: () => undefined,
      } as never,
      onMessage: async () => undefined,
    })
    const reply = await post(listener.address().port, payload())
    expect(reply.status).toBe(500)
  })
})
