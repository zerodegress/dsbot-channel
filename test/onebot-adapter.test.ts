import { afterEach, describe, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js'
import type { OneBotAdapterConfig, OneBotEvent } from '../src/adapters/onebot/adapter.js'
import type { AdapterPorts, InboundMessage } from '../src/contract.js'

const REF = '{{SECRET_onebot}}'
const TOKEN = 's3cr3t-token'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

function config(overrides: Partial<OneBotAdapterConfig> = {}): OneBotAdapterConfig {
  return {
    channel: 'onebot:a',
    instance: 'inst-a',
    botName: 'bot-a',
    selfId: '10001',
    listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
    api: { url: 'http://127.0.0.1:1', timeoutMs: 1000 },
    sendTimeoutMs: 1000,
    bots: [],
    ...overrides,
  }
}

function event(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    message_id: '1',
    user_id: 20002,
    group_id: 12345,
    time: 1_700_000_000,
    message: [{ type: 'text', data: { text: 'hi' } }],
    sender: { nickname: 'n' },
    ...overrides,
  }
}

function post(port: number, path: string, body: unknown, authorization?: string): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          ...(authorization === undefined ? {} : { authorization }),
        },
      },
      (response) => {
        response.resume()
        response.on('end', () => resolve({ status: response.statusCode ?? 0 }))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.()
})

async function startAdapter(overrides: Partial<OneBotAdapterConfig> = {}, secret = TOKEN): Promise<{
  adapter: OneBotAdapter
  port: number
  seen: InboundMessage[]
  warns: string[]
}> {
  const port = await freePort()
  const seen: InboundMessage[] = []
  const warns: string[] = []
  const adapter = new OneBotAdapter(config({ ...overrides, listen: { host: '127.0.0.1', port, path: '/onebot/event' } }), {
    warn: (line) => warns.push(line),
  })
  adapter.checkConfig()
  const ports: AdapterPorts = {
    onMessage: async (message) => {
      seen.push(message)
      return { ok: true }
    },
    resolveSecret: async (reference) => (reference === REF ? secret : undefined),
  }
  const handle = await adapter.start(ports)
  stops.push(handle.stop)
  return { adapter, port, seen, warns }
}

describe('the onebot listener', () => {
  test('accepts a message with 204 and hands it over', async () => {
    const { port, seen } = await startAdapter()
    expect(await post(port, '/onebot/event', event())).toEqual({ status: 204 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ sessionKey: 'group:12345', rawText: 'hi' })
  })

  test('answers a non-message event with 204 and never hands it over', async () => {
    const { port, seen } = await startAdapter()
    expect(await post(port, '/onebot/event', { post_type: 'notice' })).toEqual({ status: 204 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toHaveLength(0)
  })

  test('an event for another account is accepted with 204 and never handed over', async () => {
    const { port, seen, warns } = await startAdapter()
    expect(await post(port, '/onebot/event', event({ message_id: '9', self_id: 99999 }))).toEqual({ status: 204 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toHaveLength(0)
    expect(warns.some((line) => line.includes('answers for 10001'))).toBe(true)
  })

  test('a repeated message id is accepted but runs once', async () => {
    const { port, seen, warns } = await startAdapter()
    await post(port, '/onebot/event', event())
    await post(port, '/onebot/event', event())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toHaveLength(1)
    expect(warns.some((line) => line.includes('repeated onebot message'))).toBe(true)
  })

  test('an unknown path answers 404', async () => {
    const { port } = await startAdapter()
    expect(await post(port, '/elsewhere', event())).toEqual({ status: 404 })
  })
})

describe('the onebot token', () => {
  test('a configured token is required and compared exactly', async () => {
    const { port, adapter } = await startAdapter({ accessToken: REF })

    expect(await post(port, '/onebot/event', event({ message_id: '10' }))).toEqual({ status: 401 })
    expect(await post(port, '/onebot/event', event({ message_id: '11' }), 'Bearer wrong')).toEqual({ status: 401 })
    expect(await post(port, '/onebot/event', event({ message_id: '12' }), `Bearer ${TOKEN}`)).toEqual({ status: 204 })

    expect(adapter.snapshot.authFailures).toBe(2)
    expect(adapter.status()).toMatchObject({ channel: 'onebot:a' })
  })

  test('a profile without a token accepts an unauthenticated event', async () => {
    const { port, seen } = await startAdapter()
    expect(await post(port, '/onebot/event', event({ message_id: '20' }))).toEqual({ status: 204 })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(seen).toHaveLength(1)
  })
})

describe('the onebot sender', () => {
  test('a group reply calls send_group_msg with the token', async () => {
    const calls: { path: string; body: Record<string, unknown>; auth: string | undefined }[] = []
    const api = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        calls.push({
          path: request.url ?? '',
          body: JSON.parse(raw) as Record<string, unknown>,
          auth: request.headers.authorization,
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 77 } }))
      })
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const apiPort = (api.address() as AddressInfo).port
    stops.push(async () => {
      api.close()
    })

    const { adapter } = await startAdapter({ accessToken: REF, api: { url: `http://127.0.0.1:${apiPort}`, timeoutMs: 1000 } })
    const sent = await adapter.send({ target: 'group:12345', eventId: 'evt-1', chainId: 'evt-1', body: 'hello', sender: 'bot-a', instance: 'inst-a' })

    expect(sent).toEqual({ ok: true, messageId: '77', duplicate: false })
    expect(calls[0]).toMatchObject({
      path: '/send_group_msg',
      body: { group_id: '12345', message: 'hello' },
      auth: `Bearer ${TOKEN}`,
    })

    const priv = await adapter.send({ target: 'peer:20002', eventId: 'evt-2', body: 'hi', sender: 'bot-a', instance: 'inst-a' })
    expect(priv.ok).toBe(true)
    expect(calls[1]).toMatchObject({ path: '/send_private_msg', body: { user_id: '20002', message: 'hi' } })
  })

  test('a refused credential and a server error map to distinct codes', async () => {
    const api = createServer((request, response) => {
      request.resume()
      const denied = (request.headers.authorization ?? '') !== `Bearer ${TOKEN}`
      response.writeHead(denied ? 401 : 500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'failed', retcode: denied ? 1403 : 1 }))
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const apiPort = (api.address() as AddressInfo).port
    stops.push(async () => {
      api.close()
    })

    const { adapter } = await startAdapter({ accessToken: REF, api: { url: `http://127.0.0.1:${apiPort}`, timeoutMs: 1000 } })
    const failed = await adapter.send({ target: 'group:1', eventId: 'e', body: 'x', sender: 'b', instance: 'i' })
    expect(failed).toMatchObject({ ok: false, code: 'unreachable', retryable: true })
  })

  test('the api refusing the token maps to unauthorized', async () => {
    const api = createServer((request, response) => {
      request.resume()
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'failed', retcode: 1403, message: 'bad token' }))
    })
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
    const apiPort = (api.address() as AddressInfo).port
    stops.push(async () => {
      api.close()
    })

    const { adapter } = await startAdapter({ accessToken: REF, api: { url: `http://127.0.0.1:${apiPort}`, timeoutMs: 1000 } })
    const sent = await adapter.send({ target: 'group:1', eventId: 'e', body: 'x', sender: 'b', instance: 'i' })
    expect(sent).toMatchObject({ ok: false, code: 'unauthorized', retryable: false })
  })

  test('an unaddressable target is refused before any call', async () => {
    const { adapter } = await startAdapter()
    expect(adapter.checkTarget('group:1')).toBeUndefined()
    expect(adapter.checkTarget('12345')).toMatch(/group:<id> or peer:<id>/)
    expect(adapter.checkSessionKey('group:1')).toBeUndefined()
    expect(adapter.checkSessionKey('p2p:inst-b')).toMatch(/group:<id> or peer:<id>/)
    const sent = await adapter.send({ target: 'nowhere', eventId: 'e', body: 'x', sender: 'b', instance: 'i' })
    expect(sent).toMatchObject({ ok: false, code: 'no_url' })
  })
})

describe('the onebot status', () => {
  test('reports the listener and the capabilities it really has', async () => {
    const { adapter } = await startAdapter()
    const status = adapter.status()
    expect(status).toMatchObject({ channel: 'onebot:a', account: 'inst-a', bot: 'bot-a' })
    expect(status.health).toMatchObject({ kind: 'listener', listenState: 'listening' })
    expect(status.capabilities).toMatchObject({ text: true, mention: true, reply: true, image: false })
    expect(adapter.capabilities).toEqual(status.capabilities)
    expect('refuse' in adapter).toBe(false)
  })
})
