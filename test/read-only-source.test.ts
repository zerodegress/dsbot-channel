import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendResult } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = 'read-only-ref'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []
let sent: { target: string; body: string }[] = []

function message(eventKey: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  const text = overrides.body?.text ?? 'hello'
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'x-demo:chat-1',
    replyTarget: 'repo:acme/api',
    requestId: eventKey,
    source: { kind: 'x-demo', instance: 'inst-a', peer: null, scope: 'p2p' },
    author: { senderId: 'seal', kind: 'person', personId: null },
    rawText: text,
    body: { text, media: [], replyTo: null },
    transport: {
      messageId: eventKey,
      timestamp: 1,
      mentioned: { self: false, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
    ...overrides,
  }
}

class DemoAdapter implements ChannelAdapter {
  readonly kind = 'x-demo'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities

  constructor(readonly outbound: boolean) {
    this.capabilities = {
      text: true,
      image: NO_MEDIA,
      file: NO_MEDIA,
      voice: NO_MEDIA,
      recall: false,
      history: { group: false, private: false },
      mention: false,
      reply: false,
      stream: false,
      outbound,
    }
  }

  checkConfig(): void {}
  checkSessionKey(): string | undefined {
    return undefined
  }
  checkTarget(): string | undefined {
    return undefined
  }
  describeTargets(): string {
    return 'repo:acme/api'
  }
  status() {
    return buildStatus({
      channel: 'x:a',
      account: 'inst-a',
      bot: 'bot-a',
      health: buildListenerHealth({ listenState: 'stopped', boundPort: null, lastAuthenticatedAt: null, queueDepth: 0 }),
      counters: {
        authFailures: 0,
        unknownInstance: 0,
        unknownPaths: 0,
        underruns: 0,
        protocolMismatches: 0,
        staleSentAt: {},
        sendFailures: {},
        lastFailure: null,
      },
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: 1,
      queueDepth: 0,
    })
  }
  async send(input: { target: string; body: string }): Promise<SendResult> {
    sent.push({ target: input.target, body: input.body })
    return { ok: true, messageId: 'm-1', duplicate: false }
  }
  async start(ports: AdapterPorts) {
    for (const one of queue) verdicts.push(await ports.onMessage(one))
    return { stop: () => Promise.resolve() }
  }
}

interface MountOptions {
  outbound?: boolean
  events?: Record<string, unknown>
  reply?: Record<string, unknown>
  pipeline?: Record<string, unknown>
  judge?: (event: unknown, context: unknown) => Promise<{ score: number; reason?: string }>
}

async function mount(options: MountOptions = {}): Promise<Context> {
  const outbound = options.outbound ?? true
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
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ok' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
      scope.provide('tools')
      scope.set('tools', { register: () => () => undefined })
      scope.provide('dsbot-channel/judge')
      scope.set('dsbot-channel/judge', {
        judge: options.judge ?? (() => Promise.resolve({ score: 0.9 })),
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-demo', create: () => new DemoAdapter(outbound) }))
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    pipeline: { global: [{ id: 'j', type: 'judge' }], ...(options.pipeline ?? {}) },
    adapters: [
      {
        kind: 'x-demo',
        channel: 'x:a',
        botName: 'bot-a',
        policy: {},
        ...(options.events === undefined ? {} : { events: options.events }),
        ...(options.reply === undefined ? {} : { reply: options.reply }),
        transport: {},
      },
    ],
  })
  return ctx
}

const turnsOf = (ctx: Context) =>
  (ctx.get('dsbot-channel.turns') as { snapshot(): { started: number; recent: unknown[] } }).snapshot()
const usageOf = (ctx: Context): number => {
  const service = ctx.get('dsbot-channel.usage') as {
    snapshot(): { bots: { bot: string; sessions: { usage: { global: number } }[] }[] }
  }
  return service.snapshot().bots.reduce((sum, bot) => sum + bot.sessions.reduce((one, session) => one + session.usage.global, 0), 0)
}

const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const actionEvent = (key: string) =>
  message(key, {
    kind: 'action',
    event: { postType: 'action', type: 'push' },
    body: { text: 'push to acme/api by seal: 3 commits', media: [], replyTo: null },
    rawText: 'push to acme/api by seal: 3 commits',
  })

describe('an adapter that never writes back', () => {
  test('outbound:false with turnable events needs tool replies', async () => {
    await expect(mount({ outbound: false, events: { turn: ['action.push'] } })).rejects.toThrow(/reply/)
  })

  test('outbound:false with tool replies and turnable events mounts', async () => {
    const ctx = await mount({
      outbound: false,
      events: { turn: ['action.push'] },
      reply: { default: 'tool' },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('outbound:false without turnable events mounts on auto replies', async () => {
    const ctx = await mount({ outbound: false })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('an action class may start a turn', async () => {
    const ctx = await mount({ events: { turn: ['action.push'] } })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('an action class still has to name a kind and a type', async () => {
    await expect(mount({ events: { turn: ['push'] } })).rejects.toThrow(/event class/)
    await expect(mount({ events: { turn: ['action.'] } })).rejects.toThrow(/event class/)
  })
})

describe('an action event that starts no turn', () => {
  test('it is accepted, records no turn and charges nothing', async () => {
    queue = [actionEvent('evt-1')]
    verdicts = []
    sent = []
    const ctx = await mount({})
    expect(verdicts).toEqual([{ ok: true }])
    expect(turnsOf(ctx).started).toBe(0)
    expect(usageOf(ctx)).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test('a listed action class runs the turn but never sends to the adapter', async () => {
    queue = [actionEvent('evt-2')]
    verdicts = []
    sent = []
    let judged = 0
    const ctx = await mount({
      outbound: false,
      events: { turn: ['action.push'] },
      reply: { default: 'tool' },
      pipeline: { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] },
      judge: async () => {
        judged += 1
        return { score: 0.9 }
      },
    })
    expect(verdicts).toEqual([{ ok: true }])
    expect(judged).toBe(1)
    await wait()
    expect(turnsOf(ctx).started).toBe(1)
    expect(sent).toHaveLength(0)
  })
})
