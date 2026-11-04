import { describe, expect, test } from 'vitest'
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
import type { Mentioned } from '../src/event-types.js'

const REF = '{{SECRET_mention}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []

function message(mentioned: Mentioned, eventKey: string): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'group:12345',
    replyTarget: '12345',
    requestId: eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: 'u1', kind: 'person', personId: null },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

class GroupAdapter implements ChannelAdapter {
  readonly kind = 'x-group'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: { group: false, private: false },
    mention: true,
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
    for (const one of queue) {
      verdicts.push(await ports.onMessage(one))
    }
    return { stop: () => Promise.resolve() }
  }
}

const groupAdapter = { kind: 'x-group', create: () => new GroupAdapter() }

async function mount(policy: Record<string, unknown>, adapter = 'x-group'): Promise<{ prompts: number[]; created: number[] }> {
  const prompts: number[] = []
  const created: number[] = []
  const ctx = new Context()
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
  await ctx.plugin(defineAdapterPlugin(groupAdapter))
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    adapters: [
      {
        kind: adapter,
        channel: 'inst-a',
        botName: 'bot-a',
        policy: { ...policy },
        transport: {},
      },
    ],
  })
  return { prompts, created }
}

describe('a group message that names nobody', () => {
  test('is refused as not_addressed when the profile requires a mention', async () => {
    queue = [message({ self: false, others: true, all: false }, 'g-1')]
    verdicts = []
    const { prompts, created } = await mount({ requireMention: true })

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    const verdict = verdicts[0]!
    if (!verdict.ok) expect(verdict.reason).toContain('not_addressed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(0)
    expect(created).toEqual([])
  })

  test('gets through when it names everyone', async () => {
    queue = [message({ self: false, others: true, all: true }, 'g-2')]
    verdicts = []
    const { prompts } = await mount({ requireMention: true })

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })

  test('gets through when nobody is named and the switch is off', async () => {
    queue = [message({ self: false, others: true, all: false }, 'g-3')]
    verdicts = []
    const { prompts } = await mount({})

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })
})
