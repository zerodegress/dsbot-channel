import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'
import type {
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundVerdict,
  SendResult,
} from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_judge}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []

function message(eventKey: string, text = 'hello'): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'demo:chat-1',
    replyTarget: 'chat-1',
    requestId: eventKey,
    source: { kind: 'x-demo', instance: 'inst-a', peer: 'inst-a', scope: 'p2p' },
    author: { senderId: 'bot-a', kind: 'bot', personId: null },
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
      counters: {
        authFailures: 0,
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
  async send(): Promise<SendResult> {
    return { ok: true, messageId: 'm-1', duplicate: false }
  }
  async start(ports: AdapterPorts) {
    for (const one of queue) verdicts.push(await ports.onMessage(one))
    return { stop: () => Promise.resolve() }
  }
}

const demoAdapter = { kind: 'x-demo', create: () => new DemoAdapter() }

interface MountOptions {
  judge?: (event: unknown, context: unknown) => Promise<{ score: number; reason?: string }>
  pipeline?: Record<string, unknown>
  warnings?: string[]
}

async function mount(options: MountOptions = {}): Promise<Context> {
  const ctx = new Context()
  if (options.warnings !== undefined) {
    const lines = options.warnings
    ctx.logger.exporter({
      levels: { default: 3 },
      export(record: { args: unknown[] }) {
        lines.push(record.args.map((arg) => String(arg)).join(' '))
      },
    })
  }
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
      if (options.judge !== undefined) {
        scope.provide('dsbot-channel/judge')
        scope.set('dsbot-channel/judge', { judge: options.judge })
      }
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin(demoAdapter))
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    pipeline: { global: [{ id: 'j', type: 'judge' }], ...(options.pipeline ?? {}) },
    adapters: [
      {
        kind: 'x-demo',
        channel: 'inst-a',
        botName: 'bot-a',
        policy: { budget: { capacity: 100 } },
        transport: {},
      },
    ],
  })
  return ctx
}

const wait = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function usageOf(ctx: Context): number {
  const service = ctx.get('dsbot-channel.usage') as {
    snapshot(): { bots: { bot: string; sessions: { usage: { global: number } }[] }[] }
  }
  const bot = service.snapshot().bots.find((one) => one.bot === 'bot-a')
  return bot?.sessions.reduce((sum, session) => sum + session.usage.global, 0) ?? 0
}

function judgeFailuresOf(ctx: Context): number {
  const service = ctx.get('dsbot-channel.status') as { snapshot(): { judgeFailures?: number } }
  return service.snapshot().judgeFailures ?? 0
}

describe('a judge node binds the decision service', () => {
  test('a declared judge node without the service fails the mount, naming it', async () => {
    await expect(mount()).rejects.toThrow(/dsbot-channel\/judge/)
  })

  test('no judge node means the service is not needed', async () => {
    queue = []
    verdicts = []
    const ctx = new Context()
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', {
          create: () => Promise.resolve({ sessionId: 'session-1' }),
          prompt: () => Promise.resolve({ accepted: true }),
        })
        scope.provide('tools')
        scope.set('tools', { register: () => () => undefined })
      },
    })
    await ctx.plugin(registryPlugin)
    await ctx.plugin(defineAdapterPlugin(demoAdapter))
    await ctx.plugin(registryPlugin)
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry, {
      adapters: [{ kind: 'x-demo', channel: 'inst-a', botName: 'bot-a', policy: {}, transport: {} }],
    })
    await fork.dispose()
  })

  test('a verdict at the threshold allows the message', async () => {
    queue = [message('e-judge-threshold-ok')]
    verdicts = []
    const ctx = await mount({
      judge: () => Promise.resolve({ score: 0.9 }),
      pipeline: { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] },
    })

    expect(verdicts).toEqual([{ ok: true }])
    expect(usageOf(ctx)).toBe(1)
  })

  test('a verdict below the threshold is refused with the score', async () => {
    queue = [message('e-judge-threshold-no')]
    verdicts = []
    const ctx = await mount({
      judge: () => Promise.resolve({ score: 0.2 }),
      pipeline: { global: [{ id: 'j', type: 'judge', allowAtLeast: 0.5 }] },
    })

    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    expect(String((verdicts[0] as { reason?: string }).reason)).toMatch(/judge_below_threshold.*0\.2/)
    expect(usageOf(ctx)).toBe(1)
  })

  test('a returned verdict is charged once at the judge price', async () => {
    queue = [message('e-judge-1')]
    verdicts = []
    let calls = 0
    const ctx = await mount({
      judge: () => {
        calls += 1
        return Promise.resolve({ score: 1 })
      },
    })

    expect(verdicts).toEqual([{ ok: false, code: 'rejected', reason: expect.any(String) }])
    expect(calls).toBe(1)
    expect(usageOf(ctx)).toBe(1)
    expect(judgeFailuresOf(ctx)).toBe(0)
  })

  test('judgePoints sets what a verdict costs', async () => {
    queue = [message('e-judge-2')]
    verdicts = []
    const ctx = await mount({ judge: () => Promise.resolve({ score: 1 }), pipeline: { judgePoints: 5 } })

    expect(usageOf(ctx)).toBe(5)
  })

  test('a replay of the same event is charged once', async () => {
    queue = [message('e-judge-3'), message('e-judge-3')]
    verdicts = []
    const ctx = await mount({ judge: () => Promise.resolve({ score: 1 }) })

    expect(usageOf(ctx)).toBe(1)
  })

  test('a judge that throws is refused and counted, and costs nothing', async () => {
    queue = [message('e-judge-4')]
    verdicts = []
    const warnings: string[] = []
    const ctx = await mount({ judge: () => Promise.reject(new Error('boom')), warnings })
    await wait()

    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    expect(judgeFailuresOf(ctx)).toBe(1)
    expect(usageOf(ctx)).toBe(0)
    expect(warnings.some((line) => line.includes('inst-a') && line.includes('judge_failed'))).toBe(true)
    expect(warnings.some((line) => line.includes('judge_timeout'))).toBe(false)
    expect(String((verdicts[0] as { reason?: string }).reason)).toContain('judge_failed')
    expect(warnings.some((line) => line.includes('hello'))).toBe(false)
  })

  test('a judge that times out is refused as judge_timeout and counted', async () => {
    queue = [message('e-judge-5')]
    verdicts = []
    const warnings: string[] = []
    const ctx = await mount({
      judge: () => new Promise(() => {}),
      pipeline: { judgeTimeoutMs: 20 },
      warnings,
    })
    await wait(60)

    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    expect(judgeFailuresOf(ctx)).toBe(1)
    expect(usageOf(ctx)).toBe(0)
    expect(warnings.some((line) => line.includes('inst-a') && line.includes('judge_timeout'))).toBe(true)
    expect(warnings.some((line) => line.includes('judge_failed'))).toBe(false)
    expect(String((verdicts[0] as { reason?: string }).reason)).toContain('judge_timeout')
  })
})
