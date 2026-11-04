import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { buildEvent } from '../src/event-build.js'
import type { EventInput } from '../src/event-types.js'

const REF = '{{SECRET_identity_stamp}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let ports: AdapterPorts | undefined
let verdicts: InboundVerdict[] = []
let prompts: string[] = []

function message(options: { eventKey: string; personId?: string | null; mentioned?: boolean }): InboundMessage {
  return {
    eventKey: options.eventKey,
    chainId: options.eventKey,
    sessionKey: 'group:12345',
    replyTarget: '12345',
    requestId: options.eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: 'u1', kind: 'person', personId: options.personId === undefined ? 'evil' : options.personId },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: {
      messageId: options.eventKey,
      timestamp: 1,
      mentioned: { self: options.mentioned === true, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

class StubAdapter implements ChannelAdapter {
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
    void input
    return { ok: true as const, messageId: 'm-1', duplicate: false }
  }
  async start(inbound: AdapterPorts) {
    ports = inbound
    return { stop: () => Promise.resolve() }
  }
}

async function mount(options: { identity?: unknown; policy?: Record<string, unknown> } = {}): Promise<void> {
  verdicts = []
  prompts = []
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: (request: { content: readonly { text?: string }[] }) => {
          prompts.push(request.content.map((part) => part.text ?? '').join(''))
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-group', create: () => new StubAdapter() }))
  await ctx.plugin(entry, {
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    adapters: [
      {
        kind: 'x-group',
        channel: 'inst-a',
        botName: 'bot-a',
        policy: { ...(options.policy ?? {}) },
        transport: {},
      },
    ],
  })
}

async function deliver(one: InboundMessage): Promise<void> {
  verdicts.push(await ports!.onMessage(one))
}

const bound = {
  people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
}

describe('identity stamped at the gateway', () => {
  test('overwrites whatever the adapter put there', async () => {
    await mount({ identity: bound })
    const one = message({ eventKey: 'm-1', personId: 'evil' })
    await deliver(one)

    expect(one.author.personId).toBe('alice')
    expect(verdicts).toEqual([{ ok: true }])
  })

  test('leaves an unbound account null, even when the adapter claims an id', async () => {
    await mount({ identity: bound })
    const one = message({ eventKey: 'm-2', personId: 'evil' })
    one.author.senderId = 'u2'
    await deliver(one)

    expect(one.author.personId).toBeNull()
    expect(verdicts[0]).toEqual({ ok: true })
  })

  test('stamps a message the gate then refuses', async () => {
    await mount({ identity: bound, policy: { requireMention: true } })
    const one = message({ eventKey: 'm-3', personId: 'evil', mentioned: false })
    await deliver(one)

    expect(verdicts[0]).toMatchObject({ ok: false, code: 'rejected' })
    expect(one.author.personId).toBe('alice')
  })

  test('does not write through the author object the adapter still holds', async () => {
    await mount({ identity: bound })
    const one = message({ eventKey: 'm-6', personId: 'evil' })
    const adapterAuthor = one.author
    await deliver(one)

    expect(adapterAuthor.personId).toBe('evil')
    expect(one.author.personId).toBe('alice')
  })

  test('stamps even a message whose source.kind is malformed past repair', async () => {
    await mount({ identity: bound })
    const one = message({ eventKey: 'm-5', personId: 'evil' })
    one.source.kind = 'x'.repeat(200)
    await deliver(one)

    expect(verdicts[0]).toMatchObject({ ok: false, code: 'source_kind_invalid' })
    expect(one.author.personId).toBe('alice')
  })

  test('never touches the conversation key the adapter supplied', async () => {
    await mount({ identity: bound })
    const one = message({ eventKey: 'm-4' })
    const sessionKey = one.sessionKey
    await deliver(one)

    expect(one.sessionKey).toBe(sessionKey)
  })
})

describe('identity does not change what an event is', () => {
  const input = (personId: string | null): EventInput => ({
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: 'u1', kind: 'person', personId },
    body: { text: 'hello', media: [], replyTo: null },
    transport: {
      messageId: 'm-1',
      timestamp: 1,
      mentioned: { self: false, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '' },
  })

  test('eventKey and contentHash are byte-identical with and without a person', () => {
    const unbound = buildEvent(input(null))
    const named = buildEvent(input('alice'))

    expect(named.meta.derived.eventKey).toBe(unbound.meta.derived.eventKey)
    expect(named.meta.derived.contentHash).toBe(unbound.meta.derived.contentHash)
    expect(named.author.personId).toBe('alice')
  })
})
