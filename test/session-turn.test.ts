import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { registryPlugin } from '../src/registry-plugin.js'
import { boundPort } from './ports.js'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { sendToPeer } from '../src/adapters/p2p/p2p-send.js'

const REF = '{{SECRET_9m2xr7qd}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

const forks: { dispose(): Promise<void> }[] = []
const warnings: string[] = []

beforeEach(() => {
  warnings.length = 0
})

afterEach(async () => {
  while (forks.length > 0) await forks.pop()?.dispose()
})

class StubSessions {
  readonly prompted: string[] = []
  readonly #ctx: Context

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  create(): Promise<{ sessionId: string }> {
    return Promise.resolve({ sessionId: `session-${this.prompted.length + 1}` })
  }

  prompt(
    request: { requestId: string; sessionId: string; content: readonly { type: 'text'; text: string }[] },
  ): Promise<{ accepted: boolean }> {
    this.prompted.push(request.requestId)
    const emit = (event: unknown): void => {
      this.#ctx.emit('session/event', { id: request.sessionId } as never, event as never)
    }
    emit({ type: 'turn/start' })
    emit({ type: 'assistant/message', data: { message: { content: [] } } })
    emit({ type: 'turn/end' })
    return Promise.resolve({ accepted: true })
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the peer turn')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

interface Mounted {
  port: number
  prompts: StubSessions
  api: {
    forSession: (botName: string, key: string, layer: Record<string, unknown>) => void
    forgetSession: (botName: string, key: string) => void
  }
}

async function mountReceiver(): Promise<Mounted> {
  const ctx = new Context()
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message: { args: unknown[] }) {
      warnings.push(message.args.map((arg) => String(arg)).join(' '))
    },
  })
  const prompts = new StubSessions(ctx)
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', prompts)
    },
  })
  await ctx.plugin(registryPlugin)
  const fork = await ctx.plugin(entry, {
    adapters: [
      {
channel: 'p2p:b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF }],
  listen: { host: '127.0.0.1', port: 0 }
},
policy: { deny: { words: ['spam'] }, allow: { peers: ['inst-a'] } }
},
    ],
  })
  forks.push(fork)
  return {
    port: boundPort(ctx, 'p2p:b'),
    prompts,
    api: ctx.get('dsbot-channel.pipeline') as Mounted['api'],
  }
}

function deliver(port: number, eventId: string, body = 'hello'): Promise<{ ok: boolean }> {
  return sendToPeer({
    peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
    credentials,
    to: 'bot-b',
    body,
    eventId,
    sender: 'bot-a',
    instance: 'inst-a',
  }) as Promise<{ ok: boolean }>
}

describe('a session layer decides what its own turn runs', () => {
  test('removing the allow node stops the next turn of that peer only', async () => {
    const mounted = await mountReceiver()

    expect((await deliver(mounted.port, 'evt-1')).ok).toBe(true)
    await waitFor(() => mounted.prompts.prompted.includes('evt-1'))

    mounted.api.forSession('bot-b', 'p2p:inst-a', { remove: ['allow'] })
    expect((await deliver(mounted.port, 'evt-2')).ok).toBe(true)
    await waitFor(() => warnings.some((line) => line.includes('kept evt-2')))
    expect(mounted.prompts.prompted).not.toContain('evt-2')
    expect(warnings.some((line) => line.includes('pipeline-deny'))).toBe(true)

    mounted.api.forgetSession('bot-b', 'p2p:inst-a')
    expect((await deliver(mounted.port, 'evt-3')).ok).toBe(true)
    await waitFor(() => mounted.prompts.prompted.includes('evt-3'))
  })
})
