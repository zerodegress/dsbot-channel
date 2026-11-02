import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registerAdapter } from '../src/adapter-registry.js'
import type { AdapterMount } from '../src/adapter-registry.js'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'
import type {
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundVerdict,
  SendInput,
} from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_kind}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

const verdicts: InboundVerdict[] = []
const messages: InboundMessage[] = []

function groupMessage(): InboundMessage {
  return {
    ...message('x-group'),
    sessionKey: 'group:12345',
    replyTarget: '12345',
    source: { kind: 'x-group', instance: 'inst-a', peer: 'inst-a', scope: 'group' },
  }
}

function mediaMessage(): InboundMessage {
  return {
    ...message('x-media'),
    eventKey: 'inst-a:media-1',
    chainId: 'inst-a:media-1',
    body: {
      text: 'look',
      media: [{ type: 'image', url: 'https://example.test/a.png', handle: null, owner: { kind: 'x-media', instance: 'inst-a' } }],
      replyTo: null,
    },
    rawText: 'look',
  }
}

function strictMessage(): InboundMessage {
  return { ...message('x-strict'), sessionKey: 'bad key' }
}

function message(kind: string): InboundMessage {
  return {
    eventKey: 'inst-a:msg-1',
    chainId: 'inst-a:msg-1',
    sessionKey: 'demo:chat-1',
    replyTarget: 'chat-1',
    requestId: 'msg-1',
    source: { kind, instance: 'inst-a', peer: 'inst-a', scope: 'p2p' },
    author: { senderId: 'bot-a', kind: 'bot', personId: null },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: { messageId: 'msg-1', timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
    adapter: {},
    receivedAt: 1,
  }
}

class StubAdapter implements ChannelAdapter {
  readonly kind: string
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: false,
    mention: false,
    reply: true,
    stream: false,
  }
  readonly #outbound: InboundMessage[]

  readonly #acceptKey: (key: string) => string | undefined

  constructor(outbound: InboundMessage[], kind = 'x-demo', acceptKey: (key: string) => string | undefined = () => undefined) {
    this.#outbound = outbound
    this.kind = kind
    this.#acceptKey = acceptKey
  }

  checkConfig(): void {}

  checkSessionKey(key: string): string | undefined {
    return this.#acceptKey(key)
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
    for (const one of this.#outbound) {
      messages.push(one)
      verdicts.push(await ports.onMessage(one))
    }
    return { stop: () => Promise.resolve() }
  }
}

registerAdapter('x-demo', (mount: AdapterMount) => new StubAdapter([message(mount.transport.sourceKind as string ?? 'x-demo')]))
registerAdapter('x-liar', (mount: AdapterMount) => new StubAdapter([message('p2p')], mount.transport.reportedKind as string))
registerAdapter('x-group', () => new StubAdapter([groupMessage()], 'x-group'))
registerAdapter('x-media', () => new StubAdapter([mediaMessage()], 'x-media'))
registerAdapter('x-strict', () => new StubAdapter([strictMessage()], 'x-strict', (key) => (key === 'x-ok' ? undefined : `this adapter does not address "${key}"`)))

async function mountWith(kind: string, adapterKind = 'x-demo'): Promise<Context> {
  return mountPrompted(kind, adapterKind).then((one) => one.ctx)
}

async function mountPrompted(kind: string, adapterKind = 'x-demo'): Promise<{ ctx: Context; prompts: number[] }> {
  const prompts: number[] = []
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
          prompts.push(1)
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(entry, {
    adapters: [
      {
        kind: adapterKind,
        channel: 'x:a',
        instance: 'inst-a',
        botName: 'bot-a',
        policy: { allow: { peers: ['inst-a'] } },
        transport: { sourceKind: kind, reportedKind: 'p2p' },
      },
    ],
  })
  return { ctx, prompts }
}

describe('the kind a transport answers to', () => {
  test('a factory that reports another kind than the profile mounted is refused at load', async () => {
    await expect(mountWith('x-liar', 'x-liar')).rejects.toThrow(/mounted as kind "x-liar" reports kind "p2p"/)
  })
})

describe('the session key an adapter supplies', () => {
  test('a group key reaches a turn and is billed there, not under a peer pool', async () => {
    verdicts.length = 0
    const { prompts } = await mountPrompted('x-demo', 'x-group')

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
  })

  test('a key the adapter refuses never starts a turn', async () => {
    verdicts.length = 0
    const { prompts } = await mountPrompted('x-strict', 'x-strict')

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'session_key_invalid' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(0)
  })
})

describe('a media reference a third-party adapter carries', () => {
  test('a reference with a url reaches a turn untouched', async () => {
    verdicts.length = 0
    const { prompts } = await mountPrompted('x-media', 'x-media')

    expect(verdicts).toEqual([{ ok: true }])
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(prompts).toHaveLength(1)
    expect(messages.at(-1)?.body.media[0]).toEqual({
      type: 'image',
      url: 'https://example.test/a.png',
      handle: null,
      owner: { kind: 'x-media', instance: 'inst-a' },
    })
  })
})

describe('the source kind an adapter reports', () => {
  test('a message that claims another transport is refused before any session exists', async () => {
    verdicts.length = 0
    await mountWith('p2p')

    expect(verdicts).toHaveLength(1)
    const verdict = verdicts[0]!
    expect(verdict).toMatchObject({ ok: false, code: 'source_kind_invalid' })
    if (!verdict.ok) expect(verdict.reason).toMatch(/claims source.kind "p2p".*this adapter is "x-demo"/)
  })

  test.each([
    ['an empty kind', ''],
    ['a kind with a space', 'two words'],
    ['a kind with a line break', 'a\nb'],
    ['a kind with a tab', 'a\tb'],
    ['a kind longer than the shape bound', 'x'.repeat(65)],
  ])('a kind that is not one bounded line is refused: %s', async (_label, kind) => {
    verdicts.length = 0
    await mountWith(kind)

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'source_kind_invalid' })
  })

  test('the adapter own kind is accepted', async () => {
    verdicts.length = 0
    await mountWith('x-demo')

    expect(verdicts).toHaveLength(1)
    expect(verdicts[0]).toEqual({ ok: true })
  })
})
