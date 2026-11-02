import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type {
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundVerdict,
  SendInput,
} from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import type { AuthorKind, Mentioned, Scope } from '../src/event-types.js'

const REF = '{{SECRET_groupbots}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let ports: AdapterPorts | undefined
let verdicts: InboundVerdict[] = []
let prompts: number[] = []
let created: number[] = []
let warnings: string[] = []

function message(options: {
  eventKey: string
  kind?: AuthorKind
  scope?: Scope
  mentioned?: Mentioned
}): InboundMessage {
  const scope = options.scope ?? 'group'
  const mentioned = options.mentioned ?? { self: false, others: false, all: false }
  return {
    eventKey: options.eventKey,
    chainId: options.eventKey,
    sessionKey: scope === 'group' ? 'group:12345' : 'u1',
    replyTarget: scope === 'group' ? '12345' : 'u1',
    requestId: options.eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope },
    author: { senderId: 'u1', kind: options.kind ?? 'person', personId: null },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: { messageId: options.eventKey, timestamp: 1, mentioned, isReply: false, signature: null },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
    adapter: {},
    receivedAt: 1,
  }
}

class GroupAdapter implements ChannelAdapter {
  readonly kind = 'x-group'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities

  constructor(mention: boolean) {
    this.capabilities = {
      text: true,
      image: NO_MEDIA,
      file: NO_MEDIA,
      voice: NO_MEDIA,
      recall: false,
      history: false,
      mention,
      reply: true,
      stream: false,
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
    return '12345'
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
  async start(inbound: AdapterPorts) {
    ports = inbound
    return { stop: () => Promise.resolve() }
  }
}

async function mount(
  policy: Record<string, unknown>,
  options: { mention?: boolean; kind?: string; transport?: Record<string, unknown> } = {},
): Promise<void> {
  const kind = options.kind ?? 'x-group'
  const ctx = new Context()
  warnings = []
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
        create: () => {
          created.push(1)
          return Promise.resolve({ sessionId: 'session-1' })
        },
        prompt: () => {
          prompts.push(1)
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  if (kind === 'x-group') {
    await ctx.plugin(defineAdapterPlugin({ kind: 'x-group', create: () => new GroupAdapter(options.mention ?? true) }))
  }
  await ctx.plugin(entry, {
    adapters: [
      {
        kind,
        channel: 'x:a',
        instance: 'inst-a',
        botName: 'bot-a',
        policy: { ...policy },
        transport: options.transport ?? {},
      },
    ],
  })
}

async function deliver(...messages: InboundMessage[]): Promise<void> {
  for (const one of messages) verdicts.push(await ports!.onMessage(one))
}

const quiet: Mentioned = { self: false, others: false, all: false }
const namedSelf: Mentioned = { self: true, others: false, all: false }

afterEach(() => {
  ports = undefined
  verdicts = []
  prompts = []
  created = []
  warnings = []
})

describe('a bot speaking in a group', () => {
  test('is refused by default when it names nobody', async () => {
    await mount({})
    await deliver(message({ eventKey: 'b-1', kind: 'bot', mentioned: quiet }))

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    const verdict = verdicts[0]!
    if (!verdict.ok) expect(verdict.reason).toContain('bot-speaker')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(0)
    expect(created).toEqual([])
  })

  test('gets through by default when it names this bot', async () => {
    await mount({})
    await deliver(message({ eventKey: 'b-2', kind: 'bot', mentioned: namedSelf }))

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })

  test('is refused under silent even when it names this bot', async () => {
    await mount({ groupBots: 'silent' })
    await deliver(message({ eventKey: 'b-3', kind: 'bot', mentioned: namedSelf }))

    const verdict = verdicts[0]!
    expect(verdict).toMatchObject({ ok: false, code: 'rejected' })
    if (!verdict.ok) expect(verdict.reason).toContain('bot-speaker')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(0)
  })

  test('gets through under answer without naming anybody', async () => {
    await mount({ groupBots: 'answer' })
    await deliver(message({ eventKey: 'b-4', kind: 'bot', mentioned: quiet }))

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })
})

describe('anyone else', () => {
  test('a person in a group keeps getting through by default', async () => {
    await mount({})
    await deliver(message({ eventKey: 'p-1', kind: 'person', mentioned: quiet }))

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })

  test('a bot outside a group is not held to the group rule', async () => {
    await mount({})
    await deliver(message({ eventKey: 'b-5', kind: 'bot', scope: 'c2c', mentioned: quiet }))

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })
})

describe('the policy value', () => {
  test('is refused at mount when it is not one of the three modes', async () => {
    await expect(mount({ groupBots: 'loud' })).rejects.toThrow(/policy\.groupBots must be one of/)
  })
})

describe('a transport that cannot tell mentions apart', () => {
  test('warns at mount when whenMentioned is written out', async () => {
    await mount({ groupBots: 'whenMentioned' }, { mention: false })
    expect(warnings.some((line) => line.includes('whenMentioned') && line.includes('x:a'))).toBe(true)
  })

  test('stays quiet at mount under the default, then warns once', async () => {
    await mount({}, { mention: false })
    expect(warnings).toHaveLength(0)

    await deliver(message({ eventKey: 'b-6', kind: 'bot', mentioned: quiet }))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('x:a')
    expect(warnings[0]).toContain('x-group')

    await deliver(message({ eventKey: 'b-7', kind: 'bot', mentioned: quiet }))
    expect(warnings).toHaveLength(1)
  })

  test('says nothing when a p2p transport mounts under the default', async () => {
    await mount({}, { kind: 'p2p', transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { port: 0 } } })
    expect(warnings).toHaveLength(0)
  })
})

describe('when both rules refuse', () => {
  test('the bot check answers first, not requireMention', async () => {
    await mount({ requireMention: true })
    await deliver(message({ eventKey: 'b-8', kind: 'bot', mentioned: quiet }))

    const verdict = verdicts[0]!
    expect(verdict).toMatchObject({ ok: false, code: 'rejected' })
    if (!verdict.ok) {
      expect(verdict.reason).toContain('bot-speaker')
      expect(verdict.reason).not.toContain('not_addressed')
    }
  })

  test('answer falls through to requireMention', async () => {
    await mount({ requireMention: true, groupBots: 'answer' })
    await deliver(message({ eventKey: 'b-9', kind: 'bot', mentioned: quiet }))

    const verdict = verdicts[0]!
    expect(verdict).toMatchObject({ ok: false, code: 'rejected' })
    if (!verdict.ok) expect(verdict.reason).toContain('not_addressed')
  })
})
