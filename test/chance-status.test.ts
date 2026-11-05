import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, SendResult } from '../src/contract.js'

const ports: AdapterPorts[] = []

class ChanceAdapter implements ChannelAdapter {
  readonly kind = 'x-chance'
  readonly #channel: string
  constructor(channel: string) {
    this.#channel = channel
  }
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
    return 'chat'
  }
  status() {
    return buildStatus({
      channel: this.#channel,
      account: this.#channel,
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
  async start(inbound: AdapterPorts) {
    ports.push(inbound)
    return { stop: () => Promise.resolve() }
  }
}

function message(channel: string, eventKey: string): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: `peer:${channel}`,
    replyTarget: channel,
    requestId: eventKey,
    source: { kind: 'x-chance', instance: channel, peer: null, scope: 'p2p' },
    author: { senderId: '20002', kind: 'person', personId: null },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

async function mount(pipeline?: Record<string, unknown>): Promise<Context> {
  ports.length = 0
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', { resolve: () => Promise.resolve(undefined) })
      scope.provide('sessionController')
      scope.set('sessionController', { create: () => Promise.resolve({ sessionId: 's' }), prompt: () => Promise.resolve({ accepted: true }) })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-chance', create: (mount) => new ChanceAdapter(mount.channel) }))
  await ctx.plugin(entry, {
    ...(pipeline === undefined ? {} : { pipeline }),
    adapters: [
      { kind: 'x-chance', channel: 'one', botName: 'bot-a', transport: {} },
      { kind: 'x-chance', channel: 'two', botName: 'bot-a', transport: {} },
    ],
  })
  return ctx
}

function statusOf(ctx: Context): { channel: string; counters: { chance?: Record<string, { hit: number; miss: number }> } }[] {
  const service = ctx.get('dsbot-channel.status') as { snapshot(): { adapters: never[] } }
  return service.snapshot().adapters
}

afterEach(() => {
  ports.length = 0
})

describe('the chance counters an adapter reports', () => {
  test('each adapter counts only the messages it carried', async () => {
    const ctx = await mount({ global: [{ id: 'c', type: 'chance', probability: 1, outcome: 'allow' }] })
    await ports[0]!.onMessage(message('one', 'evt-one'))
    await ports[1]!.onMessage(message('two', 'evt-two'))

    const adapters = statusOf(ctx)
    const one = adapters.find((adapter) => adapter.channel === 'one')!
    const two = adapters.find((adapter) => adapter.channel === 'two')!
    expect(one.counters.chance).toEqual({ c: { hit: 1, miss: 0 } })
    expect(two.counters.chance).toEqual({ c: { hit: 1, miss: 0 } })
  })

  test('a miss is counted too', async () => {
    const ctx = await mount({ global: [{ id: 'c', type: 'chance', probability: 0, outcome: 'deny' }] })
    await ports[0]!.onMessage(message('one', 'evt-miss'))
    expect(statusOf(ctx).find((adapter) => adapter.channel === 'one')!.counters.chance).toEqual({
      c: { hit: 0, miss: 1 },
    })
  })

  test('a profile without a chance node reports no chance key', async () => {
    const ctx = await mount()
    await ports[0]!.onMessage(message('one', 'evt-plain'))
    expect(statusOf(ctx).find((adapter) => adapter.channel === 'one')!.counters).not.toHaveProperty('chance')
  })
})
