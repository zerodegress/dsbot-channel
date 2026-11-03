import { afterEach, describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { NO_MEDIA } from '../src/adapter-status.js'
import { DedupeTable } from '../src/adapters/p2p/p2p-dedupe.js'
import { checkListenerConfig, startListener } from '../src/adapters/p2p/p2p-listener.js'
import { ChannelStats } from '../src/channel-stats.js'
import type { Listener, ListenerConfig } from '../src/adapters/p2p/p2p-listener.js'
import { P2P_ROUTE } from '../src/adapters/p2p/p2p-protocol.js'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import type { InboundRequest } from '../src/adapters/p2p/p2p-wire.js'

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


/** Polls until the condition holds, so a slow machine does not fail a correct run. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the listener')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

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

function post(port: number, body: unknown, headers?: Record<string, string>): Promise<Reply> {
  const extra = headers ?? { 'x-p2p-signature': signEnvelope(secret, body as unknown as Envelope) }
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: P2P_ROUTE,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...extra },
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

const statusFixture = () => ({
  channel: 'p2p:self',
  account: 'self',
  bot: 'self-bot',
  health: { kind: 'listener' as const, listenState: 'listening' as const, boundPort: 7123, lastAuthenticatedAt: null, lastSkewMs: null, lastFailure: null, queueDepth: 0 },
  counters: {
    authFailures: 0,
    unknownPaths: 0,
    underruns: 0,
    protocolMismatches: 0,
    staleSentAt: {},
    sendFailures: {},
    lastFailure: null,
  },
  capabilities: { text: true, image: NO_MEDIA, file: NO_MEDIA, voice: NO_MEDIA, recall: false, history: { group: false, private: false }, mention: false, reply: true, stream: false },
  attributes: { stableMessageId: true },
  quota: { softLimit: 0, hardLimit: 0 },
  sampledAt: 1,
  queueDepth: 0,
})

const message = (overrides: Record<string, unknown> = {}) => ({
  eventId: 'evt-1',  chainId: 'evt-1',
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
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ duplicate: false, messageId: 'p2p-evt-1', eventId: 'evt-1' })
  })

  test('echoes the first message id on a repeated delivery', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const port = listener.address().port
    await post(port, message())
    const second = await post(port, message())
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ duplicate: true, messageId: 'p2p-evt-1' })
  })

  test('a bearer token in place of a signature is refused', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message(), { authorization: `Bearer ${secret}` })
    expect(reply.status).toBe(401)
  })

  test('rejects a request with no signature at all', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message(), {})
    expect(reply.status).toBe(401)
  })

  test('rejects a message addressed to another bot', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message({ to: 'bot-z' }))
    expect(reply.status).toBe(403)
  })

  test('rejects an oversized body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const reply = await post(listener.address().port, message({ body: 'x'.repeat(70 * 1024) }))
    expect(reply.status).toBe(413)
  })

  test('accepts a request signed over the raw body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const payload = message()
    const signature = signEnvelope(secret, payload as unknown as Envelope)
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ duplicate: false, messageId: 'p2p-evt-1' })
  })

  test('rejects a signature that does not match the body', async () => {
    const listener = await startListener({ config: baseConfig(), table: table() })
    open.push(listener)
    const payload = message()
    const signature = signEnvelope(secret, { ...payload, body: 'other' } as unknown as Envelope)
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(401)
  })

  test('records a refusal whose authentication still succeeded', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const payload = message({ to: 'somebody-else' })
    const signature = signEnvelope(secret, payload as unknown as Envelope)
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
    const reply = await post(listener.address().port, message({ body: 'x'.repeat(70 * 1024) }))
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
    const signature = signEnvelope(secret, payload as unknown as Envelope)
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
      status: { report: () => statusFixture() },
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
    expect(reply).toEqual({ status: 200, body: statusFixture() })
  })

  test('a status read that a forwarder rewrote is refused, even from loopback', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      stats: channel,
      status: { report: () => statusFixture() },
    })
    open.push(listener)
    const sent: number[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: { 'x-forwarded-for': '192.0.2.7', 'x-forwarded-host': 'proxy.example' },
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
      status: { report: () => statusFixture() },
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
      status: { report: () => statusFixture() },
    })
    open.push(listener)
    const sent: { status: number; body: unknown }[] = []
    const fakeRequest = {
      method: 'GET',
      url: '/p2p/v1/status',
      headers: {},
      socket: { remoteAddress: '203.0.113.9' },
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
    const signature = signEnvelope(secret, stale as unknown as Envelope)
    const reply = await post(listener.address().port, stale, { 'x-p2p-signature': signature })
    expect(reply.status).toBe(403)
    expect(reply.body).toMatchObject({ code: 'stale_sent_at' })
  })

  test('a stale request does not take the dedupe slot of its event id', async () => {
    const table0 = table()
    const listener = await startListener({ config: baseConfig(), table: table0 })
    open.push(listener)
    const stale = message({ sentAt: 1_700_000_000_000 - 600_000 })
    const staleSignature = signEnvelope(secret, stale as unknown as Envelope)
    expect((await post(listener.address().port, stale, { 'x-p2p-signature': staleSignature })).status).toBe(403)

    const fresh = message()
    const freshSignature = signEnvelope(secret, fresh as unknown as Envelope)
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
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(200)
    expect(seen).toEqual([{ ...message(), media: [] }])
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
    await post(port, message())
    await post(port, message())
    await post(port, message({ eventId: 'evt-2' }), {})
    expect(seen.map((request) => request.eventId)).toEqual(['evt-1'])
  })

  test('keeps a hand off that throws retryable as a duplicate, not a second turn', async () => {
    let attempts = 0
    const listener = await startListener({
      config: baseConfig(),
      table: table(),
      onMessage: () => {
        attempts += 1
        throw new Error('hand off failed')
      },
    })
    open.push(listener)
    const port = listener.address().port
    const first = await post(port, message())
    expect(first.status).toBe(200)
    const second = await post(port, message())
    expect(second.status).toBe(200)
    expect(second.body).toMatchObject({ duplicate: true })
    expect(attempts).toBe(1)
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
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(200)
    expect(finished).toBe(false)
    await waitFor(() => finished)
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
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ duplicate: false })
    await waitFor(() => reported.length > 0)
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
    await post(port, message())
    await waitFor(() => seen.length > 0)
    const second = await post(port, message())
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
    const reply = await post(listener.address().port, message())
    expect(reply.status).toBe(200)
    await waitFor(() => reported === 1)
  })
})

describe('the status route a profile can turn off', () => {
  test('a route that is not registered answers 404 and counts the path', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const reply = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: listener.address().port, path: '/p2p/v1/status', method: 'GET' },
        (response) => {
          response.resume()
          response.on('end', () => resolve(response.statusCode ?? 0))
        },
      )
      req.on('error', reject)
      req.end()
    })
    expect(reply).toBe(404)
    expect(channel.snapshot().unknownPaths).toBe(1)
  })
})

describe('the auth failure counter', () => {
  test('a signature that does not verify counts as an auth failure', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const payload = message()
    const signature = signEnvelope('{{SECRET_wrongkey}}', payload as unknown as Envelope)
    const reply = await post(listener.address().port, payload, { 'x-p2p-signature': signature })

    expect(reply.status).toBe(401)
    expect(channel.snapshot().authFailures).toBe(1)
    expect(channel.snapshot().lastFailure?.reason).toBe('bad signature')
  })

  test('a request with no signature at all counts as an auth failure', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const reply = await post(listener.address().port, message(), {})

    expect(reply.status).toBe(401)
    expect(channel.snapshot().authFailures).toBe(1)
  })

  test('an accepted delivery leaves the counter alone', async () => {
    const channel = new ChannelStats()
    const listener = await startListener({ config: baseConfig(), table: table(), stats: channel })
    open.push(listener)
    const payload = message()
    const signature = signEnvelope(secret, payload as unknown as Envelope)
    expect((await post(listener.address().port, payload, { 'x-p2p-signature': signature })).status).toBe(200)
    expect(channel.snapshot().authFailures).toBe(0)
  })
})
