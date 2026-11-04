import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_obs}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let queue: InboundMessage[] = []

function message(eventKey: string, text = 'hello'): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'p2p:inst-b',
    replyTarget: 'p2p:inst-b',
    requestId: eventKey,
    source: { kind: 'x-obs', instance: 'inst-a', peer: 'inst-b', scope: 'p2p' },
    author: { senderId: 'bot-b', kind: 'bot', personId: null },
    rawText: text,
    body: { text, media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

class ObsAdapter implements ChannelAdapter {
  readonly kind = 'x-obs'
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
    return 'p2p:inst-b'
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
  async send(input: SendInput) {
    void input
    return { ok: true as const, messageId: 'm-1', duplicate: false }
  }
  async start(ports: AdapterPorts) {
    const verdicts: InboundVerdict[] = []
    for (const one of queue) {
      verdicts.push(await ports.onMessage(one))
      if (queue.length > 1) await new Promise((resolve) => setTimeout(resolve, 120))
    }
    return { stop: () => Promise.resolve() }
  }
}

const obsAdapter = { kind: 'x-obs', create: () => new ObsAdapter() }

async function mount(options: { budget?: Record<string, unknown> } = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: (request: { sessionId: string; content: readonly { text?: string }[] }) => {
          void request
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: request.sessionId } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'reply' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin(obsAdapter))
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    adapters: [
      {
        kind: 'x-obs',
        channel: 'x:a',
        botName: 'bot-a',
        policy: options.budget === undefined ? {} : { budget: options.budget },
        transport: {},
      },
    ],
  })
  return ctx
}

const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface UsageService {
  snapshot(): {
    sampledAt: number
    bots: { bot: string; limits: { capacity: number; hardLimit: number } | null; sessions: { sessionKey: string; usage: Record<string, number>; level: string; triggeredBy: string[] }[] }[]
  }
}

describe('what a host may read about a running channel', () => {
  test('a budgeted bot reports its limits and the session it spent in', async () => {
    queue = [message('e1')]
    const ctx = await mount({ budget: { capacity: 40 } })
    await wait()

    const usage = ctx.get('dsbot-channel.usage') as UsageService
    const view = usage.snapshot()
    const bot = view.bots.find((one) => one.bot === 'bot-a')!
    expect(bot.limits).toEqual({ capacity: 40, hardLimit: 1 })
    expect(bot.sessions.map((one) => one.sessionKey)).toEqual(['p2p:inst-b'])
    expect(bot.sessions[0]?.usage['p2p:inst-b']).toBe(20)
  })

  test('a bot without a budget is still listed', async () => {
    queue = []
    const ctx = await mount()
    const usage = ctx.get('dsbot-channel.usage') as UsageService
    expect(usage.snapshot().bots).toEqual([{ bot: 'bot-a', limits: null, sessions: [] }])
  })

  test('a finished turn is readable, and the body is not in it', async () => {
    queue = [message('e2', 'a secret sentence')]
    const ctx = await mount()
    await wait()

    const turns = ctx.get('dsbot-channel.turns') as { snapshot(): { recent: Record<string, unknown>[] } }
    const record = turns.snapshot().recent.find((one) => one.eventKey === 'e2')!
    expect(record).toMatchObject({ bot: 'bot-a', channel: 'x:a', sessionKey: 'p2p:inst-b', outcome: 'replied' })
    expect(JSON.stringify(record)).not.toContain('a secret sentence')
    expect(typeof record.durationMs).toBe('number')
  })

  test('a message the gate refuses is recorded as rejected, with no turn run', async () => {
    queue = [message('e3'), message('e4')]
    const ctx = await mount({ budget: { capacity: 1 } })
    await wait(60)

    const turns = ctx.get('dsbot-channel.turns') as {
      snapshot(): { recent: { outcome: string; code?: string }[]; started: number }
    }
    const view = turns.snapshot()
    expect(view.recent.map((one) => one.outcome)).toEqual(['replied', 'rejected'])
    expect(view.recent[1]?.code).toBe('budget-hard')
    expect(view.started).toBe(1)
  })
})

describe('the observation surface is read-only', () => {
  test('reading it changes neither the counters nor the quota', async () => {
    queue = [message('e5')]
    const ctx = await mount({ budget: { capacity: 40 } })
    await wait()

    const turns = ctx.get('dsbot-channel.turns') as { snapshot(): unknown }
    const usage = ctx.get('dsbot-channel.usage') as UsageService
    const withoutStamp = (value: { sampledAt: number }): string =>
      JSON.stringify({ ...value, sampledAt: 0 })
    const firstTurns = withoutStamp(turns.snapshot() as { sampledAt: number })
    const firstUsage = withoutStamp(usage.snapshot())

    expect(withoutStamp(turns.snapshot() as { sampledAt: number })).toBe(firstTurns)
    expect(withoutStamp(usage.snapshot())).toBe(firstUsage)
  })

  test('a mount that is never read behaves exactly like one that is', async () => {
    queue = [message('e6')]
    const read = await mount()
    await wait()
    const turns = read.get('dsbot-channel.turns') as { snapshot(): { started: number; replied: number } }
    const observed = turns.snapshot()

    queue = [message('e7')]
    const quiet = await mount()
    await wait()
    const quietTurns = quiet.get('dsbot-channel.turns') as { snapshot(): { started: number; replied: number } }
    const unobserved = quietTurns.snapshot()

    expect(observed).toMatchObject({ started: 1, replied: 1 })
    expect(unobserved).toMatchObject({ started: 1, replied: 1 })
  })
})
