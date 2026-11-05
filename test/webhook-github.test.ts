import { afterEach, describe, expect, test } from 'vitest'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const SECRET = 'hook-value'
const TOKEN = 'token-value'
const credentials = staticCredentials({ 'hook-ref': SECRET, 'token-ref': TOKEN })

const servers: Server[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function apiStub(): Promise<{ url: string; calls: { url: string; body: string; auth: string }[] }> {
  const calls: { url: string; body: string; auth: string }[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      calls.push({
        url: request.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
        auth: String(request.headers.authorization ?? ''),
      })
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end('{"id":1}')
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return { url: `http://127.0.0.1:${port}`, calls }
}

interface MountOptions {
  events?: Record<string, unknown>
  dialect?: string
  judge?: (event: unknown, context: unknown) => Promise<{ score: number; reason?: string }>
}

async function mount(api: string, options: MountOptions = {}): Promise<{ ctx: Context; port: number; judged: () => number }> {
  let judged = 0
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => {
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: 'session-1' } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answered' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
      scope.provide('tools')
      scope.set('tools', { register: () => () => undefined })
      scope.provide('dsbot-channel/judge')
      scope.set('dsbot-channel/judge', {
        judge: async (event: unknown, context: unknown) => {
          judged += 1
          return options.judge === undefined ? { score: 0.9 } : options.judge(event, context)
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    pipeline: { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] },
    adapters: [
      {
        kind: 'webhook',
        channel: 'gh:acme/api',
        botName: 'bot-a',
        policy: {},
        ...(options.events === undefined ? {} : { events: options.events }),
        transport: {
          listen: { host: '127.0.0.1', port: 0 },
          secret: 'hook-ref',
          token: 'token-ref',
          api,
          login: 'acme-bot',
          ...(options.dialect === undefined ? {} : { dialect: options.dialect }),
        },
      },
    ],
  })
  contexts.push(ctx)
  const handles = ctx.get('dsbot-channel.peers') as { address: () => { port: number } }[]
  return { ctx, port: handles[0]!.address().port, judged: () => judged }
}

function sign(raw: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(raw).digest('hex')}`
}

function statusOf(ctx: Context) {
  const service = ctx.get('dsbot-channel.status') as {
    snapshot(): {
      adapters: { counters: Record<string, unknown> }[]
      turns?: { started: number }
    }
  }
  return service.snapshot()
}

const repo = { name: 'api', owner: { login: 'acme' } }
const issue = { number: 12, title: 'Fix the parser', updated_at: '2026-01-02T03:04:05Z' }

const commentPayload = JSON.stringify({
  action: 'created',
  repository: repo,
  issue,
  comment: { id: 77, body: 'hello @acme-bot', user: { login: 'seal', type: 'User' } },
  sender: { login: 'seal', type: 'User' },
})

const actionPayload = JSON.stringify({ action: 'opened', repository: repo, issue, sender: { login: 'seal', type: 'User' } })

const post = async (
  port: number,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; text: string }> => {
  const response = await fetch(`http://127.0.0.1:${port}/github/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
  return { status: response.status, text: await response.text() }
}

const githubHeaders = (delivery: string, event = 'issue_comment') => ({
  'x-github-event': event,
  'x-github-delivery': delivery,
  'x-hub-signature-256': sign(commentPayload),
})

describe('a webhook request has to prove itself', () => {
  test('a bad signature is refused before core sees it', async () => {
    const api = await apiStub()
    const { ctx, port, judged } = await mount(api.url)
    const response = await post(port, commentPayload, {
      'x-github-event': 'issue_comment',
      'x-github-delivery': 'd-1',
      'x-hub-signature-256': 'sha256=deadbeef',
    })
    expect(response.status).toBe(401)
    expect(judged()).toBe(0)
    expect(statusOf(ctx).adapters[0]?.counters.authFailures).toBe(1)
  })

  test('a bad body size is refused', async () => {
    const api = await apiStub()
    const { port } = await mount(api.url)
    const big = 'x'.repeat(1024 * 1024 + 10)
    const response = await post(port, big, { 'x-hub-signature-256': sign(big) })
    expect(response.status).toBe(413)
  })
})

describe('an issue comment runs a turn and answers there', () => {
  test('the reply is posted as a comment on the same issue', async () => {
    const api = await apiStub()
    const { ctx, port, judged } = await mount(api.url)
    const response = await post(port, commentPayload, githubHeaders('d-1'))
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(judged()).toBe(1)
    expect(api.calls).toHaveLength(1)
    expect(api.calls[0]?.url).toBe('/repos/acme/api/issues/12/comments')
    expect(JSON.parse(api.calls[0]!.body)).toEqual({ body: 'answered' })
    expect(api.calls[0]?.auth).toBe(`Bearer ${TOKEN}`)
    expect(statusOf(ctx).adapters[0]?.counters.sendFailures).toEqual({})
  })

  test('a redelivery of the same delivery does not run twice', async () => {
    const api = await apiStub()
    const { port, judged } = await mount(api.url)
    expect((await post(port, commentPayload, githubHeaders('same-1'))).status).toBe(200)
    const again = await post(port, commentPayload, githubHeaders('same-1'))
    expect(again.status).toBe(200)
    expect(again.text).toBe('duplicate')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(judged()).toBe(1)
  })
})

describe('a webhook action starts no turn unless it is listed', () => {
  test('an unlisted action is recorded and counted only', async () => {
    const api = await apiStub()
    const { ctx, port, judged } = await mount(api.url)
    const response = await post(port, actionPayload, {
      'x-github-event': 'issues',
      'x-github-delivery': 'a-1',
      'x-hub-signature-256': sign(actionPayload),
    })
    expect(response.status).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(judged()).toBe(0)
    const counters = statusOf(ctx).adapters[0]!.counters as { events?: Record<string, number> }
    expect(counters.events?.['action.issues']).toBe(1)
  })

  test('a listed action runs the turn', async () => {
    const api = await apiStub()
    const { port, judged } = await mount(api.url, { events: { turn: ['action.issues'] } })
    await post(port, actionPayload, {
      'x-github-event': 'issues',
      'x-github-delivery': 'a-2',
      'x-hub-signature-256': sign(actionPayload),
    })
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(judged()).toBe(1)
  })

  test('a ping carries no event at all', async () => {
    const api = await apiStub()
    const { port, judged } = await mount(api.url)
    const body = JSON.stringify({ zen: 'keep it simple', repository: repo })
    const response = await post(port, body, {
      'x-github-event': 'ping',
      'x-github-delivery': 'p-1',
      'x-hub-signature-256': sign(body),
    })
    expect(response.status).toBe(200)
    expect(judged()).toBe(0)
  })
})

describe('the dialect a profile names is enforced', () => {
  test('a github profile refuses a forgejo header', async () => {
    const api = await apiStub()
    const { ctx, port } = await mount(api.url, { dialect: 'github' })
    const response = await post(port, commentPayload, {
      'x-forgejo-event': 'issues',
      'x-forgejo-delivery': 'f-1',
      'x-forgejo-signature': sign(commentPayload).replace('sha256=', ''),
    })
    expect(response.status).toBe(400)
    expect(statusOf(ctx).adapters[0]?.counters.protocolMismatches).toBe(1)
  })

  test('an auto profile accepts either dialect', async () => {
    const api = await apiStub()
    const { port } = await mount(api.url)
    const response = await post(port, commentPayload, {
      'x-forgejo-event': 'issue_comment',
      'x-forgejo-delivery': 'f-2',
      'x-forgejo-signature': sign(commentPayload).replace('sha256=', ''),
    })
    expect(response.status).toBe(200)
  })

  test('an unlabelled request counts as a dialect fallback', async () => {
    const api = await apiStub()
    const { ctx, port } = await mount(api.url)
    const response = await post(port, commentPayload, { 'x-hub-signature-256': sign(commentPayload) })
    expect(response.status).toBe(200)
    expect(statusOf(ctx).adapters[0]?.counters.dialectFallback).toBe(1)
  })
})
