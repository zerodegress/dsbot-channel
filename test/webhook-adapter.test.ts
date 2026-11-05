import { afterEach, describe, expect, test } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebhookAdapter } from '../src/adapters/webhook/adapter.js'
import type { WebhookConfig } from '../src/adapters/webhook/adapter.js'
import type { AdapterPorts, InboundMessage, InboundVerdict, SendInput } from '../src/contract.js'

const SECRET = 'hook-value'
const servers: Server[] = []
const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

const config = (over: Partial<WebhookConfig> = {}): WebhookConfig => ({
  channel: 'gh:acme/api',
  botName: 'bot-a',
  status: true,
  listen: { host: '127.0.0.1', port: 0, path: '/hook' },
  secret: 'hook-ref',
  token: 'token-ref',
  dialect: 'auto',
  api: 'http://127.0.0.1:1',
  login: 'acme-bot',
  bots: [],
  repos: [],
  ...over,
})

const ports = (verdicts: InboundVerdict[], calls: InboundMessage[] = []): AdapterPorts => ({
  async onMessage(message) {
    calls.push(message)
    return verdicts.shift() ?? { ok: true }
  },
  async resolveSecret(reference) {
    return reference === 'hook-ref' ? SECRET : 'token-value'
  },
})

const payload = JSON.stringify({
  action: 'created',
  repository: { name: 'api', owner: { login: 'acme' } },
  issue: { number: 12, title: 'Fix', updated_at: '2026-01-02T03:04:05Z' },
  comment: { id: 77, body: 'hello', user: { login: 'seal', type: 'User' } },
  sender: { login: 'seal', type: 'User' },
})

const send = async (port: number, body: string, delivery: string): Promise<{ status: number; text: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}/hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': 'issue_comment',
      'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    body,
  })
  return { status: response.status, text: await response.text() }
}

describe('a busy answer may be retried', () => {
  test('the delivery is not claimed until core stops saying busy', async () => {
    const calls: InboundMessage[] = []
    const adapter = new WebhookAdapter(config())
    const handle = await adapter.start(ports([{ ok: false, code: 'busy', reason: 'core is full' }, { ok: true }], calls))
    stops.push(() => handle.stop())
    const port = handle.address!().port

    expect((await send(port, payload, 'd-1')).status).toBe(503)
    expect((await send(port, payload, 'd-1')).status).toBe(200)
    expect((await send(port, payload, 'd-1')).status).toBe(200)
    expect(calls).toHaveLength(2)
  })
})

describe('the repo allow list guards the way back', () => {
  test('a target outside transport.repos is refused', () => {
    const adapter = new WebhookAdapter(config({ repos: ['acme/api'] }))
    expect(adapter.checkTarget('gh:acme/api#3')).toBeUndefined()
    expect(adapter.checkTarget('gh:other/repo#3')).toMatch(/repos/)
  })
})

describe('a slow api does not hang the queue', () => {
  test('a comment past the timeout reports busy', async () => {
    let received = 0
    const server = createServer((request, response) => {
      received += 1
      request.resume()
      setTimeout(() => {
        response.writeHead(201)
        response.end('{"id":1}')
      }, 300)
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as AddressInfo).port
    const adapter = new WebhookAdapter(config({ api: `http://127.0.0.1:${port}` }))
    const handle = await adapter.start(ports([]))
    stops.push(() => handle.stop())
    const input: SendInput = {
      target: 'gh:acme/api#12',
      body: 'hi',
      eventId: 'e-1',
      chainId: 'gh:acme/api#12',
      sender: 'bot-a',
      instance: 'gh:acme/api',
      timeoutMs: 60,
    }
    const result = await adapter.send(input)
    expect(result).toMatchObject({ ok: false, code: 'busy' })
    expect(received).toBe(1)
  })
})
