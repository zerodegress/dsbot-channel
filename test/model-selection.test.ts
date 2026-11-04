import { describe, expect, test } from 'vitest'
import { request } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { registryPlugin } from '../src/registry-plugin.js'
import * as entry from '../src/index.js'
import { P2P_ROUTE } from '../src/adapters/p2p/p2p-protocol.js'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Listener } from '../src/adapters/p2p/p2p-listener.js'

const secret = '{{SECRET_qp8mzt4c}}'
const secretRef = 'PEER_SHARED_SECRET'
const route = 'deepseek/deepseek-chat'

interface StatusEntry {
  channel: string
  modelSelection?: { requested: string; state: string }
}

function credentialsProvider() {
  return {
    name: 'test-credentials',
    apply(ctx: Context) {
      ctx.provide('credentials')
      ctx.set('credentials', {
        resolve: async (reference: string) => (reference === secretRef ? { value: secret, source: 'test' } : undefined),
      })
    },
  }
}

async function mount(
  controller: Record<string, unknown>,
  options: { model?: string } = {},
): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(credentialsProvider())
  await ctx.plugin({
    name: 'stub-sessions',
    apply(scope: Context) {
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => new Promise<never>(() => undefined),
        ...controller,
      })
    },
  })
  await ctx.plugin(registryPlugin)
  const fork = await ctx.plugin(entry.default, {
    adapters: [
      {
        channel: 'inst-a',
        botName: 'bot-a',
        ...(options.model === undefined ? {} : { model: options.model }),
        transport: {
          peers: [{ instance: 'inst-b', secret: secretRef }],
          listen: { host: '127.0.0.1', port: 0 },
        },
      },
    ],
  })
  return { ctx, dispose: () => fork.dispose() }
}

function statusOf(ctx: Context): StatusEntry {
  const service = ctx.get('dsbot-channel.status') as { snapshot(): { adapters: StatusEntry[] } }
  const entry = service.snapshot().adapters[0]
  if (entry === undefined) throw new Error('the adapter reports no status')
  return entry
}

function post(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: P2P_ROUTE,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-p2p-signature': signEnvelope(secret, body as unknown as Envelope),
        },
      },
      (response) => resolve(response.statusCode ?? 0),
    )
    req.on('error', reject)
    req.end(text)
  })
}

function deliver(ctx: Context): Promise<number> {
  const port = (ctx.get('dsbot-channel.peers') as Listener[])[0]!.address().port
  return post(port, {
    eventId: 'evt-1',
    chainId: 'evt-1',
    to: 'bot-a',
    sender: 'bot-b',
    instance: 'inst-b',
    body: 'hello',
    sentAt: Date.now(),
  })
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the model selection')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('the model selection an adapter reports', () => {
  test('names nothing when the profile names no model', async () => {
    const mounted = await mount({})
    expect(statusOf(mounted.ctx).modelSelection).toBeUndefined()
    await mounted.dispose()
  })

  test('a host without a selector is reported as unsupported', async () => {
    const mounted = await mount({}, { model: route })
    expect(statusOf(mounted.ctx).modelSelection).toEqual({ requested: route, state: 'unsupported' })
    await mounted.dispose()
  })

  test('a selection the host takes is reported as applied', async () => {
    const selected: unknown[] = []
    const mounted = await mount(
      {
        selectModel: (request: unknown) => {
          selected.push(request)
          return Promise.resolve({})
        },
      },
      { model: route },
    )
    expect(statusOf(mounted.ctx).modelSelection).toBeUndefined()

    expect(await deliver(mounted.ctx)).toBe(200)
    await waitFor(() => selected.length > 0)

    expect(selected[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' })
    expect(statusOf(mounted.ctx).modelSelection).toEqual({ requested: route, state: 'applied' })
    await mounted.dispose()
  })

  test('a refused selection is reported as rejected while the turn still starts', async () => {
    const prompts: string[] = []
    const mounted = await mount(
      {
        selectModel: () => Promise.reject(new Error('no such model')),
        prompt: (request: { requestId: string }) => {
          prompts.push(request.requestId)
          return new Promise<never>(() => undefined)
        },
      },
      { model: route },
    )

    expect(await deliver(mounted.ctx)).toBe(200)
    await waitFor(() => prompts.length > 0)

    expect(statusOf(mounted.ctx).modelSelection).toEqual({ requested: route, state: 'rejected' })
    await mounted.dispose()
  })
})
