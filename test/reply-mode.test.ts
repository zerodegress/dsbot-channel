import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registerAdapter } from '../src/adapter-registry.js'
import { buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type {
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundVerdict,
  SendInput,
  SendResult,
} from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_reply}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []
let outbound: SendInput[] = []

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
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
    adapter: {},
    receivedAt: 1,
  }
}

class DemoAdapter implements ChannelAdapter {
  readonly kind = 'x-demo'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: false,
    file: false,
    voice: false,
    recall: false,
    history: false,
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
  async send(input: SendInput): Promise<SendResult> {
    outbound.push(input)
    return { ok: true, messageId: 'm-1', duplicate: false }
  }
  async start(ports: AdapterPorts) {
    for (const one of queue) {
      verdicts.push(await ports.onMessage(one))
    }
    return { stop: () => Promise.resolve() }
  }
}

registerAdapter('x-demo', () => new DemoAdapter())

const prompted: string[] = []

async function mount(reply: unknown, options: { withTools?: boolean; answer?: string } = {}): Promise<Context> {
  const ctx = new Context()
  const answer = options.answer ?? 'a plain answer'
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: (request: { sessionId: string; content: readonly { type: string; text?: string }[] }) => {
          prompted.push(request.content.map((part) => part.text ?? '').join(''))
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: request.sessionId } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: answer }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
      if (options.withTools !== false) {
        scope.provide('tools')
        scope.set('tools', { register: () => () => undefined })
      }
    },
  })
  await ctx.plugin(entry, {
    reply,
    adapters: [
      {
        kind: 'x-demo',
        channel: 'x:a',
        instance: 'inst-a',
        botName: 'bot-a',
        policy: {},
        transport: {},
      },
    ],
  })
  return ctx
}

const wait = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('a session that must answer with a tool', () => {
  test('a plain text answer is dropped, counted and not sent', async () => {
    queue = [message('e1')]
    verdicts = []
    outbound = []
    const ctx = await mount({ default: 'tool' })

    expect(verdicts).toEqual([{ ok: true }])
    await wait()
    const turns = ctx.get('dsbot-channel.turns') as { snapshot(): { dropped: number; replied: number; empty: number } }
    expect(turns.snapshot()).toMatchObject({ dropped: 1, replied: 0, empty: 0 })
    expect(outbound).toHaveLength(0)
  })

  test('the same answer is sent when the mode is auto', async () => {
    queue = [message('e2')]
    verdicts = []
    outbound = []
    await mount({ default: 'auto' })

    await wait()
    expect(outbound).toHaveLength(1)
    expect(outbound[0]?.body).toBe('a plain answer')
  })

  test('a profile that can choose tool mode needs the tools service', async () => {
    await expect(mount({ default: 'tool' }, { withTools: false })).rejects.toThrow(/tools service is required/)
    await expect(mount({ byScope: { p2p: 'tool' } }, { withTools: false })).rejects.toThrow(/tools service is required/)
    await expect(mount({ rules: [{ when: {}, mode: 'tool' }] }, { withTools: false })).rejects.toThrow(
      /tools service is required/,
    )
  })
})

describe('what a tool-mode turn is told', () => {
  test('guidance and the mode block ride the first tool turn, and only the mode block is new later', async () => {
    queue = [message('e3', 'hello'), message('e4', 'hello')]
    verdicts = []
    prompted.length = 0
    await mount({ rules: [{ when: { body: { text: { words: ['hello'] } } }, mode: 'tool' }] })
    await wait()

    expect(verdicts).toEqual([{ ok: true }, { ok: true }])
    expect(prompted[0]).toMatch(/^\[x-demo\] peer guidance\n\[tool-mode\] .+\n\nhello$/)
    expect(prompted[1]).toBe('hello')
  })

  test('switching back to auto and into tool again repeats only the mode block', async () => {
    queue = [message('e5', 'plain'), message('e6', 'use-tool')]
    verdicts = []
    prompted.length = 0
    await mount({
      default: 'auto',
      rules: [{ when: { body: { text: { words: ['use-tool'] } } }, mode: 'tool' }],
    })
    await wait()

    expect(prompted[0]).toBe('[x-demo] peer guidance\n\nplain')
    expect(prompted[1]).toMatch(/^\[tool-mode\] .+\n\nuse-tool$/)
  })
})
