import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterStatus, CapabilitySet } from '../src/adapter-status.js'
import type { AdapterHandle, AdapterPorts, ChannelAdapter, InboundMessage, SendResult } from '../src/contract.js'
import type { PrepareInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_prepare}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

const warnings: string[] = []
const forks: { dispose: () => Promise<void> }[] = []

afterEach(async () => {
  while (forks.length > 0) await forks.pop()?.dispose()
  warnings.length = 0
})

interface Queued {
  eventKey: string
  sessionKey: string
  text: string
}

function inbound(one: Queued, kind: string): InboundMessage {
  return {
    eventKey: one.eventKey,
    chainId: one.eventKey,
    sessionKey: one.sessionKey,
    replyTarget: 'room-1',
    requestId: one.eventKey,
    source: { kind, instance: 'inst-a', peer: 'inst-a', scope: 'group' },
    author: { senderId: 'bot-a', kind: 'bot', personId: null },
    rawText: one.text,
    body: { text: one.text, media: [], replyTo: null },
    transport: {
      messageId: one.eventKey,
      timestamp: 1,
      mentioned: { self: true, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

const capabilities: CapabilitySet = {
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

class PlainStub implements ChannelAdapter {
  readonly kind: string
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = capabilities
  readonly seen: PrepareInput[] = []
  readonly queue: Queued[]
  readonly explode: boolean
  readonly prompted: number[]

  constructor(kind: string, queue: Queued[], prompted: number[], explode = false) {
    this.kind = kind
    this.queue = queue
    this.prompted = prompted
    this.explode = explode
  }

  checkConfig(): void {}

  checkSessionKey(): string | undefined {
    return undefined
  }

  checkTarget(): string | undefined {
    return undefined
  }

  describeTargets(): string {
    return 'room-1'
  }

  status(): AdapterStatus {
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

  #ports: AdapterPorts | undefined

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    this.#ports = ports
    for (const one of this.queue) await ports.onMessage(inbound(one, this.kind))
    return { stop: () => Promise.resolve() }
  }

  async deliver(one: Queued): Promise<void> {
    await this.#ports?.onMessage(inbound(one, this.kind))
  }
}

class PreparingStub extends PlainStub {
  prepare(input: PrepareInput): void {
    this.seen.push(input)
    if (this.explode) throw new Error('prepare exploded')
  }
}

let nextQueue: Queued[] = []
let nextExplodes = false
const created: PlainStub[] = []

const stubs = {
  'x-prepare': defineAdapterPlugin({
    kind: 'x-prepare',
    create: () => {
      const stub = new PreparingStub('x-prepare', nextQueue, [], nextExplodes)
      created.push(stub)
      return stub
    },
  }),
  'x-noprepare': defineAdapterPlugin({
    kind: 'x-noprepare',
    create: () => {
      const stub = new PlainStub('x-noprepare', nextQueue, [])
      created.push(stub)
      return stub
    },
  }),
}

interface MountOptions {
  queue?: Queued[]
  explode?: boolean
  pipeline?: { global: { id: string; type: string }[] }
  extraAdapter?: boolean
  denied?: boolean
  allow?: boolean
}

async function mount(options: MountOptions = {}): Promise<Context> {
  nextQueue = options.queue ?? []
  nextExplodes = options.explode === true
  created.length = 0
  const ctx = new Context()
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message: { args: unknown[] }) {
      warnings.push(message.args.map((arg) => String(arg)).join(' '))
    },
  })
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: `session-${created.length}` }),
        prompt: () => Promise.resolve({ accepted: true }),
      })
    },
  })
  const adapters = [
    {
      kind: 'x-prepare',
      channel: 'x:a',
      instance: 'inst-a',
      botName: 'bot-a',
      policy: {
        groupBots: 'answer',
        ...(options.denied === true
          ? { deny: { words: ['spam'] }, allow: { peers: ['inst-a'] } }
          : options.allow === true
            ? { allow: { peers: ['inst-a'] } }
            : {}),
      },
      transport: {},
    },
    ...(options.extraAdapter === true
      ? [{ kind: 'x-noprepare', channel: 'x:b', instance: 'inst-b', botName: 'bot-a', transport: {} }]
      : []),
  ]
  await ctx.plugin(registryPlugin)
  await ctx.plugin(stubs['x-prepare'])
  if (options.extraAdapter === true) await ctx.plugin(stubs['x-noprepare'])
  const fork = await ctx.plugin(entry, {
    adapters,
    ...(options.pipeline === undefined ? {} : { pipeline: options.pipeline }),
  })
  forks.push(fork as unknown as { dispose: () => Promise<void> })
  return ctx
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the hook')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const prepareNode = { id: 'prep', type: 'prepare' }

describe('the prepare hook an adapter may carry', () => {
  test('runs once per turn, with the event and the adapter session key', async () => {
    await mount({
      queue: [
        { eventKey: 'evt-1', sessionKey: 'group:1', text: 'first' },
        { eventKey: 'evt-2', sessionKey: 'group:1', text: 'second' },
      ],
      pipeline: { global: [prepareNode] },
    })

    await waitFor(() => created[0] !== undefined && created[0].seen.length === 2)
    const seen = created[0]!.seen
    expect(seen.map((one) => one.event.eventKey)).toEqual(['evt-1', 'evt-2'])
    expect(seen.map((one) => one.sessionKey)).toEqual(['group:1', 'group:1'])
    expect(seen[0]!.event).toMatchObject({ scope: 'group', text: 'first', peer: 'inst-a' })
  })

  test('two sessions each get their own call and never share a key', async () => {
    await mount({
      queue: [
        { eventKey: 'evt-1', sessionKey: 'group:1', text: 'one' },
        { eventKey: 'evt-2', sessionKey: 'group:2', text: 'two' },
      ],
      pipeline: { global: [prepareNode] },
    })

    await waitFor(() => created[0] !== undefined && created[0].seen.length === 2)
    expect(created[0]!.seen.map((one) => one.sessionKey)).toEqual(['group:1', 'group:2'])
  })

  test('a hook that throws is reported and the message still runs its turn', async () => {
    await mount({
      queue: [{ eventKey: 'evt-1', sessionKey: 'group:1', text: 'hello' }],
      pipeline: { global: [prepareNode] },
      explode: true,
    })

    await waitFor(() => warnings.some((line) => line.includes('prepare')))
    const said = warnings.find((line) => line.includes('prepare'))!
    expect(said).toContain('evt-1')
    expect(said).toContain('x-prepare')
    await waitFor(() => created[0] !== undefined)
  })

  test('a message a deny node stops never reaches the hook', async () => {
    await mount({
      queue: [
        { eventKey: 'evt-1', sessionKey: 'group:1', text: 'spam here' },
        { eventKey: 'evt-2', sessionKey: 'group:1', text: 'hello' },
      ],
      denied: true,
      pipeline: { global: [{ id: 'deny', type: 'deny' }, prepareNode] },
    })

    await waitFor(() => created[0] !== undefined && created[0].seen.length === 1)
    expect(created[0]!.seen.map((one) => one.event.eventKey)).toEqual(['evt-2'])
  })
})

describe('a prepare node a session layer introduces', () => {
  test('is refused at declaration when the adapters carry no hook', async () => {
    nextQueue = []
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
      },
    })
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
          channel: 'p2p:self',
          instance: 'inst-a',
          botName: 'bot-a',
          policy: { allow: { peers: ['inst-b'] } },
          transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
        },
      ],
      pipeline: { global: [{ id: 'allow', type: 'allow' }] },
    })
    forks.push(fork as unknown as { dispose: () => Promise<void> })
    const pipeline = ctx.get('dsbot-channel.pipeline') as {
      forSession(bot: string, key: string, layer: unknown): void
    }
    expect(() =>
      pipeline.forSession('bot-a', 'p2p:inst-b', { insert: [{ id: 'late', type: 'prepare', after: 'allow' }] }),
    ).toThrow(/node "late".*prepare/)
  })

  test('runs once per turn when every adapter carries the hook', async () => {
    const ctx = await mount({ denied: true, pipeline: { global: [{ id: 'deny', type: 'deny' }] } })
    const pipeline = ctx.get('dsbot-channel.pipeline') as {
      forSession(bot: string, key: string, layer: unknown): void
    }
    pipeline.forSession('bot-a', 'group:1', { insert: [{ id: 'late', type: 'prepare', after: 'deny' }] })

    await created[0]!.deliver({ eventKey: 'evt-9', sessionKey: 'group:1', text: 'late hook' })
    await waitFor(() => created[0]!.seen.length === 1)
    expect(created[0]!.seen[0]!.event.eventKey).toBe('evt-9')
    expect(created[0]!.seen[0]!.sessionKey).toBe('group:1')
  })
})

describe('a prepare node the adapters cannot supply', () => {
  test('is refused at mount, naming the node and the adapter', async () => {
    nextQueue = []
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
      },
    })
    await ctx.plugin(registryPlugin)
    await expect(
      ctx.plugin(entry, {
        adapters: [
          {
            channel: 'p2p:self',
            instance: 'inst-a',
            botName: 'bot-a',
            transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
          },
        ],
        pipeline: { global: [prepareNode] },
      }),
    ).rejects.toThrow(/node "prep".*p2p:self/)
  })

  test('is refused when only one of a bot’s adapters carries the hook', async () => {
    await expect(mount({ pipeline: { global: [prepareNode] }, extraAdapter: true })).rejects.toThrow(
      /node "prep".*x-noprepare/,
    )
  })

  test('mounts when every adapter carries it', async () => {
    const ctx = await mount({ pipeline: { global: [prepareNode] } })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })
})
