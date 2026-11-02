import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import type { AuthorKind, MediaType, Mentioned } from '../src/event-types.js'

const REF = '{{SECRET_context}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let ports: AdapterPorts | undefined
let verdicts: InboundVerdict[] = []
let prompted: string[] = []

function message(options: {
  eventKey: string
  text?: string
  /** The transport's own rendering, with its header; defaults to the text alone. */
  bodyText?: string
  kind?: AuthorKind
  senderId?: string
  nickname?: string
  media?: readonly MediaType[]
  mentioned?: Mentioned
}): InboundMessage {
  const mentioned = options.mentioned ?? { self: false, others: false, all: false }
  const text = options.text ?? ''
  const bodyText = options.bodyText ?? text
  return {
    eventKey: options.eventKey,
    chainId: options.eventKey,
    sessionKey: 'group:12345',
    replyTarget: '12345',
    requestId: options.eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: options.senderId ?? 'u1', kind: options.kind ?? 'person', personId: null },
    rawText: text,
    body: {
      text: bodyText,
      media: (options.media ?? []).map((type) => ({
        type,
        url: 'https://example.test/a.png',
        handle: null,
        owner: { kind: 'x-group', instance: 'inst-a' },
      })),
      replyTo: null,
    },
    transport: { messageId: options.eventKey, timestamp: 1, mentioned, isReply: false, signature: null },
    declared: { nickname: options.nickname ?? '', avatar: '', claimedIdentity: null },
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

async function mount(options: { policy?: Record<string, unknown>; turn?: Record<string, unknown> } = {}): Promise<void> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: (request: { sessionId: string; requestId: string; content: readonly { type: string; text?: string }[] }) => {
          prompted.push(request.content.map((part) => part.text ?? '').join(''))
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: request.sessionId } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ack' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-group', create: () => new GroupAdapter() }))
  await ctx.plugin(entry, {
    ...(options.turn === undefined ? {} : { turn: options.turn }),
    adapters: [
      {
        kind: 'x-group',
        channel: 'x:a',
        instance: 'inst-a',
        botName: 'bot-a',
        policy: { ...(options.policy ?? {}) },
        transport: {},
      },
    ],
  })
}

async function deliver(...messages: InboundMessage[]): Promise<void> {
  for (const one of messages) verdicts.push(await ports!.onMessage(one))
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the turn')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The part of a prompt before its blank line: the blocks, without the message body. */
function blocksOf(text: string): string {
  return text.split('\n\n')[0] ?? ''
}

afterEach(() => {
  ports = undefined
  verdicts = []
  prompted = []
})

describe('the messages a turn did not answer', () => {
  test('are not read at all unless the profile asks for them', async () => {
    await mount()
    await deliver(message({ eventKey: 'm-1', text: 'first' }))
    await waitFor(() => prompted.length === 1)
    await deliver(message({ eventKey: 'm-2', text: 'second' }))
    await waitFor(() => prompted.length === 2)

    expect(prompted[1]).not.toContain('[context]')
  })

  test('are read once the buffer is on, without the one asking', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(message({ eventKey: 'm-1', text: 'first', senderId: '10001', nickname: '阿明' }))
    await waitFor(() => prompted.length === 1)
    expect(prompted[0]).not.toContain('[context]')

    await deliver(message({ eventKey: 'm-2', text: 'second' }))
    await waitFor(() => prompted.length === 2)

    const blocks = blocksOf(prompted[1]!)
    expect(blocks).toContain('[context] messages this bot did not answer')
    expect(blocks).toContain('10001 (阿明): first')
    expect(blocks).not.toContain('second')
  })

  test('a message of media alone carries its placeholder', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(message({ eventKey: 'm-1', text: '', senderId: '20002', media: ['image'] }))
    await waitFor(() => prompted.length === 1)
    await deliver(message({ eventKey: 'm-2', text: 'what is that' }))
    await waitFor(() => prompted.length === 2)

    expect(blocksOf(prompted[1]!)).toContain('20002: [image]')
  })

  test('a message the policy refused still shows up on the next turn', async () => {
    await mount({ policy: { requireMention: true }, turn: { context: { messages: 10 } } })
    await deliver(message({ eventKey: 'b-1', text: 'someone else said hi', senderId: 'bot-a' }))
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })

    await deliver(message({ eventKey: 'm-1', text: 'hello', mentioned: { self: true, others: false, all: false } }))
    await waitFor(() => prompted.length === 1)

    expect(blocksOf(prompted[0]!)).toContain('bot-a: someone else said hi')
  })

  test('a batch leaves out every message it already carries', async () => {
    await mount({ turn: { context: { messages: 10 }, coalesceMs: 50 } })
    await deliver(message({ eventKey: 'm-1', text: 'first' }))
    await deliver(message({ eventKey: 'm-2', text: 'second' }))
    await waitFor(() => prompted.length === 1)
    await waitFor(() => prompted[0]!.includes('second'))

    expect(prompted[0]).not.toContain('[context]')
  })

  test('reads what the sender said, not the header the adapter put on it', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(
      message({
        eventKey: 'm-1',
        text: 'first',
        bodyText: '[onebot from 阿明 · 10001 · 7] first',
        senderId: '10001',
        nickname: '阿明',
      }),
    )
    await waitFor(() => prompted.length === 1)
    await deliver(message({ eventKey: 'm-2', text: 'second' }))
    await waitFor(() => prompted.length === 2)

    const blocks = blocksOf(prompted[1]!)
    expect(blocks).toContain('10001 (阿明): first')
    expect(blocks).not.toContain('[onebot from')
  })

  test('a bot refused by the group rule still shows up on the next turn', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(message({ eventKey: 'b-1', text: 'bot a says hi', kind: 'bot', senderId: 'bot-a' }))
    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    if (!verdicts[0]!.ok) expect(verdicts[0]!.reason).toContain('bot-speaker')

    await deliver(message({ eventKey: 'm-1', text: 'hello' }))
    await waitFor(() => prompted.length === 1)

    expect(blocksOf(prompted[0]!)).toContain('bot-a: bot a says hi')
  })
})
