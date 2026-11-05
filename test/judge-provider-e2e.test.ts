import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import entry from '../src/index.js'
import systemOne from '../src/system-one.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendResult } from '../src/contract.js'

const REF = '{{SECRET_e2e_judge}}'
const SECRET = 'judge-secret-value'

interface Hit {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
}

async function stub(score: number): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      hits.push({ body: JSON.parse(raw) as Record<string, unknown>, headers: request.headers })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ answers: { judge: { noul: score } } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []
let prompted = 0

function message(eventKey: string, text = 'hello'): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'demo:chat-1',
    replyTarget: 'chat-1',
    requestId: eventKey,
    source: { kind: 'x-demo', instance: 'inst-a', peer: 'inst-a', scope: 'p2p' },
    author: { senderId: '20002', kind: 'person', personId: null },
    rawText: text,
    body: { text, media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

class DemoAdapter implements ChannelAdapter {
  readonly kind = 'x-demo'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: { group: false, private: false },
    mention: false,
    reply: true,
    stream: false,
  }

  checkConfig(): void {}
  checkSessionKey(): string | undefined {
    return undefined
  }
  checkTarget(): string | undefined {
    return undefined
  }
  describeTargets(): string {
    return 'chat-1'
  }
  status() {
    return buildStatus({
      channel: 'x:a',
      account: 'inst-a',
      bot: 'bot-a',
      health: buildListenerHealth({ listenState: 'stopped', boundPort: null, lastAuthenticatedAt: null, queueDepth: 0 }),
      counters: { authFailures: 0, unknownInstance: 0, unknownPaths: 0, underruns: 0, protocolMismatches: 0, staleSentAt: {}, sendFailures: {}, lastFailure: null },
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: 1,
      queueDepth: 0,
    })
  }
  async send(): Promise<SendResult> {
    return { ok: true, messageId: 'm-1', duplicate: false }
  }
  async start(ports: AdapterPorts) {
    for (const one of queue) verdicts.push(await ports.onMessage(one))
    return { stop: () => Promise.resolve() }
  }
}

async function services(ctx: Context): Promise<void> {
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', {
        resolve: (reference: string) => Promise.resolve(reference === REF ? { value: SECRET } : undefined),
      })
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => {
          prompted += 1
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: 'session-1' } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
      scope.provide('tools')
      scope.set('tools', { register: () => () => undefined })
    },
  })
}

async function mountGateway(ctx: Context, pipeline?: Record<string, unknown>): Promise<void> {
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-demo', create: () => new DemoAdapter() }))
  await ctx.plugin(entry, {
    ...(pipeline === undefined ? {} : { pipeline }),
    adapters: [{ kind: 'x-demo', channel: 'inst-a', botName: 'bot-a', policy: {}, transport: {} }],
  })
}

const providerConfig = (url: string): Record<string, unknown> => ({
  credential: REF,
  baseUrl: url,
  model: 'test/model',
  question: { type: 'noul', instructions: 'Is this worth answering?', criteria: { true: 'yes', false: 'no' } },
})

async function settle(): Promise<void> {
  const started = Date.now()
  while (verdicts.length === 0 && Date.now() - started < 3000) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await new Promise((resolve) => setImmediate(() => setImmediate(resolve)))
}

afterEach(() => {
  queue = []
  verdicts = []
  prompted = 0
})

describe('a provider under the gateway', () => {
  test('a declared judge node calls the provider once and its score decides', async () => {
    const server = await stub(0.9)
    queue = [message('e1')]
    const ctx = new Context()
    await services(ctx)
    await ctx.plugin(systemOne as never, providerConfig(server.url) as never)
    await mountGateway(ctx, { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] })
    await settle()

    expect(server.hits).toHaveLength(1)
    expect(prompted).toBe(1)
    expect(verdicts[0]).toEqual({ ok: true })
    expect(server.hits[0]!.body.state).toMatchObject({ scope: 'p2p', author: '20002' })
    await server.close()
  })

  test('a score below the threshold keeps the turn from running', async () => {
    const server = await stub(0.1)
    queue = [message('e2')]
    const ctx = new Context()
    await services(ctx)
    await ctx.plugin(systemOne as never, providerConfig(server.url) as never)
    await mountGateway(ctx, { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] })
    await settle()

    expect(server.hits).toHaveLength(1)
    expect(prompted).toBe(0)
    expect(verdicts[0]).toMatchObject({ ok: false })
    await server.close()
  })

  test('a gateway without a judge node never calls the provider', async () => {
    const server = await stub(0.9)
    queue = [message('e3')]
    const ctx = new Context()
    await services(ctx)
    await ctx.plugin(systemOne as never, providerConfig(server.url) as never)
    await mountGateway(ctx)
    await settle()

    expect(server.hits).toHaveLength(0)
    expect(prompted).toBe(1)
    await server.close()
  })

  test('a gateway mounted before the provider fails at load', async () => {
    const server = await stub(0.9)
    const ctx = new Context()
    await services(ctx)
    await expect(mountGateway(ctx, { global: [{ id: 'j', type: 'judge' }] })).rejects.toThrow(/dsbot-channel\/judge/)
    await server.close()
  })
})
