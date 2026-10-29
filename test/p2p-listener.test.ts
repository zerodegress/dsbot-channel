import { afterEach, describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { DedupeTable } from '../src/p2p-dedupe.js'
import { checkListenerConfig, startListener } from '../src/p2p-listener.js'
import { ChannelStats } from '../src/channel-stats.js'
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
  now: () => 1_700_000_000_000,
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

  test('records a refusal whose authentication still succeeded', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const payload = message({ to: 'somebody-else' })
    const signature = signBody(secret, { eventId: payload.eventId, sentAt: payload.sentAt, body: payload.body })
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })

    expect(reply.status).toBe(403)
    const snapshot = channel.snapshot()
    expect(snapshot.lastFailure?.reason).toBe('message is addressed to another bot')
    expect(snapshot.lastAuthenticatedAt).not.toBeNull()
  })

  test('records a body that is not json as a failure', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: listener.address().port,
          path: P2P_ROUTE,
          method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': 6 },
        },
        (response) => resolve(response.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end('{oops!')
    })
    expect(status).toBe(400)
    expect(channel.snapshot().lastFailure?.reason).toBe('body must be valid json')
  })

  test('records an oversized body as a failure', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const reply = await post(listener.address().port, message({ body: 'x'.repeat(70 * 1024) }), {
      authorization: `Bearer ${secret}`,
    })
    expect(reply.status).toBe(413)
    expect(channel.snapshot().lastFailure?.reason).toBe('body exceeds the size limit')
  })

  test('counts an unknown route without calling it a failure', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
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
    expect(channel.snapshot()).toMatchObject({ unknownPaths: 1, lastFailure: null })
  })

  test('an accepted delivery leaves no failure behind', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const payload = message()
    const signature = signBody(secret, { eventId: payload.eventId, sentAt: payload.sentAt, body: payload.body })
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })

    expect(reply.status).toBe(200)
    expect(channel.snapshot()).toMatchObject({ lastFailure: null, inFlight: 0, underruns: 0 })
  })

  test('the status route does not exist unless it was asked for', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: listener.address().port, path: '/p2p/v1/status', method: 'GET' },
        (response) => resolve(response.statusCode ?? 0),
      )
      req.on('error', reject)
      req.end()
    })
    expect(status).toBe(404)
    expect(channel.snapshot()).toMatchObject({ unknownPaths: 1, lastFailure: null })
  })

  test('an enabled status route answers with what it was given', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      stats: channel,
      status: { report: () => ({ allowed: true }) },
    })
    open.push(listener)
    const reply = await new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: listener.address().port, path: '/p2p/v1/status', method: 'GET' },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
            }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(reply).toEqual({ status: 200, body: { allowed: true } })
  })

  test('a status read that a forwarder rewrote is refused, even from loopback', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      stats: channel,
      status: { report: () => ({ allowed: true }) },
    })
    open.push(listener)
    const sent: number[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: { 'x-forwarded-for': '100.64.0.7', 'x-forwarded-host': 'orca-gw' },
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof listener.handle>[0]
    const fakeResponse = {
      writeHead: (status: number) => {
        sent.push(status)
      },
      end: () => undefined,
    } as unknown as Parameters<typeof listener.handle>[1]
    await listener.handle(fakeRequest, fakeResponse)
    expect(sent[0]).toBe(404)
    expect(channel.snapshot()).toMatchObject({ unknownPaths: 1, lastFailure: null })
  })

  test('an adapter that never asked for the route answers nothing at all', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const sent: number[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof listener.handle>[0]
    const fakeResponse = {
      writeHead: (status: number) => {
        sent.push(status)
      },
      end: () => undefined,
    } as unknown as Parameters<typeof listener.handle>[1]
    await listener.handle(fakeRequest, fakeResponse)
    expect(sent[0]).toBe(404)
    expect(channel.snapshot().unknownPaths).toBe(1)
  })

  test('a plain loopback read without forwarding headers still answers', async () => {
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      status: { report: () => ({ allowed: true }) },
    })
    open.push(listener)
    const sent: number[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as Parameters<typeof listener.handle>[0]
    const fakeResponse = {
      writeHead: (status: number) => {
        sent.push(status)
      },
      end: () => undefined,
    } as unknown as Parameters<typeof listener.handle>[1]
    await listener.handle(fakeRequest, fakeResponse)
    expect(sent[0]).toBe(200)
  })

  test('a status read from anywhere but loopback is refused', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      stats: channel,
      status: { report: () => ({ allowed: true }) },
    })
    open.push(listener)
    const sent: { status: number; body: unknown }[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: {},
      socket: { remoteAddress: '10.1.2.3' },
    } as unknown as Parameters<typeof listener.handle>[0]
    const fakeResponse = {
      writeHead: (status: number) => {
        sent.push({ status, body: undefined })
      },
      end: (body: string) => {
        sent[sent.length - 1] = { status: sent[sent.length - 1]!.status, body: JSON.parse(body) as unknown }
      },
    } as unknown as Parameters<typeof listener.handle>[1]
    await listener.handle(fakeRequest, fakeResponse)
    expect(sent[0]?.status).toBe(404)
    expect(channel.snapshot().unknownPaths).toBe(1)
  })

  test('reports the port the OS actually bound', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    expect(channel.snapshot()).toMatchObject({ state: 'listening', boundPort: listener.address().port })
  })

  test('reports a listener that closed', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    await listener.close()
    expect(channel.snapshot()).toMatchObject({ state: 'closed', boundPort: null })
  })

  test('reports a start that failed instead of failing silently', async () => {
    const first = await startListener({ config: baseConfig(), table: table() })
    open.push(first)
    const channel = new ChannelStats()
    await expect(
      startListener({
        config: { ...baseConfig(), listen: { host: '127.0.0.1', port: first.address().port } },
        table: table(),
        stats: channel,
      }),
    ).rejects.toThrow()
    expect(channel.snapshot()).toMatchObject({ state: 'failed', boundPort: null })
    expect(channel.snapshot().lastFailure?.reason.length).toBeGreaterThan(0)
  })

  test('refuses a signed request whose sentAt is outside the window', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const stale = message({ sentAt: 1_700_000_000_000 - 600_000 })
    const signature = signBody(secret, { eventId: stale.eventId, sentAt: stale.sentAt, body: stale.body })
    const reply = await post(listener.address().port, stale, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ code: 'stale_sent_at' })
  })

  test('a stale request does not take the dedupe slot of its event id', async () => {
    const table0 = table()
    const listener = await startListener({ config: baseConfig(), table: table0 })
    open.push(listener)
    const stale = message({ sentAt: 1_700_000_000_000 - 600_000 })
    const staleSignature = signBody(secret, { eventId: stale.eventId, sentAt: stale.sentAt, body: stale.body })
    expect((await post(listener.address().port, stale, { 'x-p2p-signature': staleSignature })).status).toBe(403)

    const fresh = message()
    const freshSignature = signBody(secret, { eventId: fresh.eventId, sentAt: fresh.sentAt, body: fresh.body })
    const reply = await post(listener.address().port, fresh, { 'x-p2p-signature': freshSignature })
    expect(reply).toMatchObject({ status: 200, body: { duplicate: false } })
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

describe('listener async hand off', () => {
  test('answers before a slow hand off finishes', async () => {
    let finished = false
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        finished = true
      },
    })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(200)
    expect(finished).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(finished).toBe(true)
  })

  test('reports a rejected hand off instead of letting it reach the process', async () => {
    const reported: unknown[] = []
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: async () => {
        throw new Error('turn failed')
      },
      onError: (error) => {
        reported.push(error)
      },
    })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ duplicate: false })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('turn failed')
  })

  test('keeps the event claimed when the hand off fails asynchronously', async () => {
    const seen: string[] = []
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: async (request) => {
        seen.push(request.eventId)
        throw new Error('turn failed')
      },
      onError: () => undefined,
    })
    open.push(listener)
    const port = listener.address().port
    await post(port, message(), { authorization: `Bearer ${secret}` })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await post(port, message(), { authorization: `Bearer ${secret}` })
    expect(second.body).toMatchObject({ duplicate: true })
    expect(seen).toEqual(['evt-1'])
  })
})

describe('listener error handler', () => {
  test('does not crash when the error handler itself throws', async () => {
    let reported = 0
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: async () => {
        throw new Error('turn failed')
      },
      onError: () => {
        reported += 1
        throw new Error('logger failed')
      },
    })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reported).toBe(1)
  })
})
