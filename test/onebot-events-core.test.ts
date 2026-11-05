import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendInput } from '../src/contract.js'
import type { Mentioned } from '../src/event-types.js'

let ports: AdapterPorts | undefined
let verdicts: InboundVerdict[] = []
let prompted: string[] = []
let sent: SendInput[] = []

const mentioned: Mentioned = { self: false, others: false, all: false }

function envelope(options: { eventKey: string; text: string }): Omit<InboundMessage, 'kind' | 'event' | 'body'> {
  return {
    eventKey: options.eventKey,
    chainId: options.eventKey,
    sessionKey: 'group:12345',
    replyTarget: '12345',
    requestId: options.eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: '20002', kind: 'person', personId: null },
    rawText: options.text,
    transport: { messageId: options.eventKey, timestamp: 1, mentioned, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

function message(options: { eventKey: string; text: string }): InboundMessage {
  return { ...envelope(options), body: { text: options.text, media: [], replyTo: null } }
}

function notice(options: { eventKey: string; type: string; text: string }): InboundMessage {
  return {
    ...envelope(options),
    kind: 'notice',
    event: { postType: 'notice', type: options.type },
    body: { text: options.text, media: [], replyTo: null },
  }
}

function meta(options: { eventKey: string; text: string }): InboundMessage {
  return {
    ...envelope(options),
    kind: 'meta',
    event: { postType: 'meta_event', type: 'heartbeat' },
    body: { text: options.text, media: [], replyTo: null },
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
    sent.push(input)
    return { ok: true as const, messageId: 'm-1', duplicate: false }
  }
  async start(inbound: AdapterPorts) {
    ports = inbound
    return { stop: () => Promise.resolve() }
  }
}

async function mount(
  options: {
    turn?: Record<string, unknown>
    events?: { turn: string[] }
    judge?: () => Promise<{ score: number }>
    pipeline?: { global: { id: string; type: string }[] }
    policy?: Record<string, unknown>
  } = {},
): Promise<void> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', { resolve: () => Promise.resolve(undefined) })
      if (options.judge !== undefined) {
        scope.provide('dsbot-channel/judge')
        scope.set('dsbot-channel/judge', { judge: options.judge })
      }
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
    ...(options.pipeline === undefined ? {} : { pipeline: options.pipeline }),
    adapters: [
      {
        kind: 'x-group',
        channel: 'inst-a',
        botName: 'bot-a',
        policy: { ...(options.policy ?? {}) },
        ...(options.events === undefined ? {} : { events: options.events }),
        transport: {},
      },
    ],
  })
}

async function deliver(...messages: InboundMessage[]): Promise<void> {
  for (const one of messages) verdicts.push(await ports!.onMessage(one))
}

function drain(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the turn')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(() => {
  ports = undefined
  verdicts = []
  prompted = []
  sent = []
})

describe('an event that is not a message', () => {
  test('is recorded without a turn or an outbound call, and the next turn can read it', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(notice({ eventKey: 'evt-recall', type: 'group_recall', text: '[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345' }))

    expect(verdicts.at(-1)).toEqual({ ok: true })
    expect(prompted).toHaveLength(0)
    expect(sent).toHaveLength(0)

    await deliver(message({ eventKey: 'm-1', text: 'what happened' }))
    await waitFor(() => prompted.length === 1)

    expect(sent).toHaveLength(1)
    expect(prompted[0]).toContain('[context]')
    expect(prompted[0]).toContain('recalled message 30003')
  })

  test('a meta event is not recorded in the conversation at all', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver(meta({ eventKey: 'evt-heartbeat', text: '[onebot meta: heartbeat] account 10001' }))

    expect(prompted).toHaveLength(0)
    expect(sent).toHaveLength(0)

    await deliver(message({ eventKey: 'm-1', text: 'hello' }))
    await waitFor(() => prompted.length === 1)

    expect(prompted[0]).not.toContain('heartbeat')
  })

  test('starts a turn only when its class is named in the profile', async () => {
    await mount({ events: { turn: ['notice.group_recall'] } })
    await deliver(notice({ eventKey: 'evt-recall', type: 'group_recall', text: '[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345' }))

    await waitFor(() => prompted.length === 1)
    expect(prompted[0]).toContain('recalled message 30003')
  })

  test('a class that may never start a turn is refused at mount', async () => {
    await expect(mount({ events: { turn: ['meta.heartbeat'] } })).rejects.toThrow(/events\.turn names/)
    await expect(mount({ events: { turn: ['notice.sent'] } })).rejects.toThrow(/events\.turn names/)
    await expect(mount({ events: { turn: ['notice.not_a_class'] } })).rejects.toThrow(/events\.turn names/)
  })
})

describe('a self echo', () => {
  test('is never read into the conversation', async () => {
    await mount({ turn: { context: { messages: 10 } } })
    await deliver({
      ...envelope({ eventKey: 'evt-sent', text: '[onebot sent: group] message 50005 in 12345' }),
      kind: 'notice',
      event: { postType: 'message_sent', type: 'sent' },
      body: { text: '[onebot sent: group] message 50005 in 12345', media: [], replyTo: null },
    })

    expect(prompted).toHaveLength(0)
    expect(sent).toHaveLength(0)

    await deliver(message({ eventKey: 'm-1', text: 'hello' }))
    await waitFor(() => prompted.length === 1)
    expect(prompted[0]).not.toContain('message 50005')
  })
})

describe('the pipeline an event reaches', () => {
  test('a class that may not turn never starts a judge call', async () => {
    let calls = 0
    await mount({
      judge: () => {
        calls += 1
        return Promise.resolve({ score: 1 })
      },
      pipeline: { global: [{ id: 'j', type: 'judge' }] },
    })
    await deliver(notice({ eventKey: 'evt-recall', type: 'group_recall', text: '[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345' }))
    await drain()
    expect(calls).toBe(0)
    expect(prompted).toHaveLength(0)
  })

  test('a class named in the profile does reach the pipeline', async () => {
    let calls = 0
    await mount({
      events: { turn: ['notice.group_recall'] },
      judge: () => {
        calls += 1
        return Promise.resolve({ score: 1 })
      },
      pipeline: { global: [{ id: 'j', type: 'judge' }] },
    })
    await deliver(notice({ eventKey: 'evt-recall', type: 'group_recall', text: '[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345' }))
    await waitFor(() => calls === 1)
    expect(calls).toBe(1)
  })
})

describe('the mention rule', () => {
  test('does not turn away a class the profile named', async () => {
    await mount({ events: { turn: ['notice.group_recall'] }, policy: { requireMention: true } })
    await deliver(notice({ eventKey: 'evt-recall', type: 'group_recall', text: '[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345' }))
    await waitFor(() => prompted.length === 1)
    expect(prompted[0]).toContain('recalled message 30003')
  })

  test('still turns away a message that names nobody', async () => {
    await mount({ policy: { requireMention: true } })
    await deliver(message({ eventKey: 'm-1', text: 'hello' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(prompted).toHaveLength(0)
  })
})
