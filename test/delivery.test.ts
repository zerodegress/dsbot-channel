import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, InboundVerdict, SendInput, SendResult } from '../src/contract.js'
import { compileDelivery, DEFAULT_DELIVERY } from '../src/delivery.js'
import { ConfigError } from '../src/config.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_delivery}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

describe('the delivery block', () => {
  /** Joins the parts with the text between them; the scope plus nothing is what comes back. */
  function rebuilt(scope: string, parts: readonly string[]): string {
    let cursor = 0
    let out = ''
    for (const part of parts) {
      const at = scope.indexOf(part, cursor)
      if (at < 0) throw new Error(`part out of order: ${JSON.stringify(part)}`)
      out += scope.slice(cursor, at) + part
      cursor = at + part.length
    }
    return out + scope.slice(cursor)
  }

  const compile = (raw: unknown) => compileDelivery(raw, (key) => ['delivery', key])

  test('no block turns splitting off', () => {
    expect(compile(undefined)).toBeUndefined()
    expect(compile({})).toBeUndefined()
  })

  test('an empty block takes the defaults', () => {
    const delivery = compile({ split: {} })
    expect(delivery?.settings).toEqual(DEFAULT_DELIVERY)
  })

  test('blank lines split, and the parts over the cap merge into the last', () => {
    const delivery = compile({ split: { byBlankLine: true, maxParts: 2 } })!
    expect(delivery.parts('one\n\ntwo\n\nthree')).toEqual(['one', 'two\n\nthree'])
  })

  test('maxChars cuts by code points and never splits a surrogate pair or a CRLF', () => {
    const delivery = compile({ split: { byBlankLine: false, maxChars: 3 } })!
    const parts = delivery.parts('ab\r\ncd🎉ef')
    expect(parts).toEqual(['ab', '\r\nc', 'd🎉e', 'f'])
    expect(parts.join('')).toBe('ab\r\ncd🎉ef')
  })

  test('merging keeps a paragraph boundary even when every piece was hard cut', () => {
    const delivery = compile({ split: { byBlankLine: true, maxChars: 2, maxParts: 2 } })!
    const scope = 'aaa\n\nbbb'
    const parts = delivery.parts(scope)
    expect(parts).toEqual(['aa', 'a\n\nbbb'])
    expect(rebuilt(scope, parts)).toBe(scope)
  })

  test('a CRLF blank line survives the merge', () => {
    const delivery = compile({ split: { byBlankLine: true, maxChars: 2, maxParts: 2 } })!
    const scope = 'aaa\r\n\r\nbbb'
    const parts = delivery.parts(scope)
    expect(rebuilt(scope, parts)).toBe(scope)
    expect(parts[1]).toContain('\r\n\r\n')
  })

  test('a blank line holding spaces survives the merge', () => {
    const delivery = compile({ split: { byBlankLine: true, maxChars: 2, maxParts: 2 } })!
    const scope = 'aaa\n  \nbbb'
    const parts = delivery.parts(scope)
    expect(rebuilt(scope, parts)).toBe(scope)
    expect(parts[1]).toContain('\n  \n')
  })

  test('parts joined with their own gaps give back the text, split or merged', () => {
    const split = compile({ split: { byBlankLine: true, maxChars: 0, maxParts: 4 } })!
    const scope = 'one\n\ntwo\n\nthree'
    expect(rebuilt(scope, split.parts(scope))).toBe(scope)
    const merged = compile({ split: { byBlankLine: true, maxChars: 0, maxParts: 2 } })!
    expect(rebuilt(scope, merged.parts(scope))).toBe(scope)
  })

  test('leading and trailing blank lines are dropped', () => {
    const delivery = compile({ split: { byBlankLine: true, maxChars: 0, maxParts: 4 } })!
    expect(delivery.parts('\r\n\r\nabc\r\n\r\n')).toEqual(['abc'])
    expect(delivery.parts('\n\n')).toEqual([])
  })

  test('the gap comes from the next part and stays inside minMs..maxMs', () => {
    const delivery = compile({ pacing: { charsPerSecond: 10, minMs: 100, maxMs: 500 } })!
    expect(delivery.gapMs('x'.repeat(1))).toBe(100)
    expect(delivery.gapMs('x'.repeat(20))).toBe(500)
    expect(delivery.gapMs('x'.repeat(5))).toBe(500)
    const slow = compile({ pacing: { charsPerSecond: 100, minMs: 0, maxMs: 10_000 } })!
    expect(slow.gapMs('x'.repeat(300))).toBe(3_000)
  })

  test('an invalid value is refused with its own path', () => {
    expect(() => compile({ split: { maxParts: 0 } })).toThrow(ConfigError)
    expect(() => compile({ split: { maxChars: -1 } })).toThrow(/maxChars/)
    expect(() => compile({ pacing: { charsPerSecond: 0 } })).toThrow(/charsPerSecond/)
    expect(() => compile({ pacing: { minMs: 10, maxMs: 5 } })).toThrow(/maxMs must be at least minMs/)
  })
})

let queue: InboundMessage[] = []
let verdicts: InboundVerdict[] = []
let reply = ''
const sentInputs: SendInput[] = []
let failOnSend = 0

function message(eventKey: string): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'demo:chat-1',
    replyTarget: 'chat-1',
    requestId: eventKey,
    source: { kind: 'x-demo', instance: 'inst-a', peer: 'inst-a', scope: 'p2p' },
    author: { senderId: 'bot-a', kind: 'bot', personId: null },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '' },
    adapter: {},
    receivedAt: 1,
  }
}

class DemoAdapter implements ChannelAdapter {
  readonly kind = 'x-demo'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true, image: NO_MEDIA, file: NO_MEDIA, voice: NO_MEDIA, recall: false,
    history: { group: false, private: false }, mention: false, reply: true, stream: false,
  }
  checkConfig(): void {}
  checkSessionKey(): string | undefined { return undefined }
  checkTarget(): string | undefined { return undefined }
  describeTargets(): string { return 'chat-1' }
  status() {
    return buildStatus({
      channel: 'x:a', account: 'inst-a', bot: 'bot-a',
      health: buildListenerHealth({ listenState: 'stopped', boundPort: null, lastAuthenticatedAt: null, queueDepth: 0 }),
      counters: { authFailures: 0, unknownPaths: 0, underruns: 0, protocolMismatches: 0, staleSentAt: {}, sendFailures: {}, lastFailure: null },
      capabilities: this.capabilities, attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 }, sampledAt: 1, queueDepth: 0,
    })
  }
  async send(input: SendInput): Promise<SendResult> {
    sentInputs.push(input)
    if (failOnSend > 0 && sentInputs.length === failOnSend) {
      return { ok: false, code: 'rejected', retryable: false, reason: 'the peer said no' }
    }
    return { ok: true, messageId: `m-${sentInputs.length}`, duplicate: false }
  }
  async start(ports: AdapterPorts) {
    for (const one of queue) verdicts.push(await ports.onMessage(one))
    return { stop: () => Promise.resolve() }
  }
}

const demoAdapter = { kind: 'x-demo', create: () => new DemoAdapter() }
const toolDefs: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []

async function mount(delivery: unknown, adapterDelivery?: unknown): Promise<Context> {
  toolDefs.length = 0
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
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: 'session-1' } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: reply }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
      scope.provide('tools')
      scope.set('tools', {
        register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
          toolDefs.push(definition)
          return () => undefined
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin(demoAdapter))
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    ...(delivery === undefined ? {} : { delivery }),
    adapters: [
      {
        kind: 'x-demo',
        channel: 'inst-a',
        botName: 'bot-a',
        policy: {},
        transport: {},
        ...(adapterDelivery === undefined ? {} : { delivery: adapterDelivery }),
      },
    ],
  })
  return ctx
}

const wait = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('a reply that is sent in parts', () => {
  test('splits on blank lines, merges the tail and only the first part answers the message', async () => {
    queue = [message('e-part-1')]
    verdicts = []
    sentInputs.length = 0
    failOnSend = 0
    reply = 'one\n\ntwo\n\nthree'
    await mount({ split: { byBlankLine: true, maxParts: 2 }, pacing: { charsPerSecond: 100, minMs: 0, maxMs: 0 } })
    await wait(40)

    expect(sentInputs.map((input) => input.body)).toEqual(['one', 'two\n\nthree'])
    expect(sentInputs[0]?.inReplyTo).toBe('e-part-1')
    expect(sentInputs[1]?.inReplyTo).toBeUndefined()
    expect(sentInputs[0]?.eventId).not.toBe(sentInputs[1]?.eventId)
    expect(verdicts).toEqual([{ ok: true }])
  })

  test('a failed part stops the rest and is reported with the parts already out', async () => {
    queue = [message('e-part-2')]
    verdicts = []
    sentInputs.length = 0
    failOnSend = 2
    reply = 'one\n\ntwo\n\nthree'
    const warnings: string[] = []
    const ctx = await mount({ split: { byBlankLine: true, maxParts: 3 }, pacing: { charsPerSecond: 100, minMs: 0, maxMs: 0 } })
    ctx.logger.exporter({
      levels: { default: 3 },
      export(record: { args: unknown[] }) {
        warnings.push(record.args.map((arg) => String(arg)).join(' '))
      },
    })
    await wait(40)

    expect(sentInputs).toHaveLength(2)
    expect(warnings.some((line) => line.includes('rejected') && line.includes('after 1 part(s)'))).toBe(true)
    const turns = ctx.get('dsbot-channel.turns') as { snapshot(): { sendFailures: Record<string, number> } }
    expect(turns.snapshot().sendFailures).toMatchObject({ rejected: 1 })
  })

  test('hard cut pieces merged past maxParts gain no blank line', () => {
    const delivery = compileDelivery({ split: { byBlankLine: false, maxChars: 2, maxParts: 2 } }, (key) => [
      'delivery',
      key,
    ])!
    expect(delivery.parts('abcdef')).toEqual(['ab', 'cdef'])
  })

  test('send_text is not split', async () => {
    queue = []
    sentInputs.length = 0
    failOnSend = 0
    reply = ''
    await mount({ split: { byBlankLine: true, maxParts: 2 }, pacing: { charsPerSecond: 100, minMs: 0, maxMs: 0 } })
    const sendText = toolDefs.find((definition) => definition.name === 'send_text')!
    await sendText.execute({ text: 'one\n\ntwo', channel: 'inst-a', target: 'chat-1' }, {})

    expect(sentInputs).toHaveLength(1)
    expect(sentInputs[0]?.body).toBe('one\n\ntwo')
  })

  test('an empty adapter block keeps the top-level splitting', async () => {
    queue = [message('e-part-4')]
    verdicts = []
    sentInputs.length = 0
    failOnSend = 0
    reply = 'one\n\ntwo'
    await mount(
      { split: { byBlankLine: true, maxParts: 2 }, pacing: { charsPerSecond: 100, minMs: 0, maxMs: 0 } },
      {},
    )
    await wait(40)

    expect(sentInputs.map((input) => input.body)).toEqual(['one', 'two'])
  })

  test('no delivery block keeps one send', async () => {
    queue = [message('e-part-3')]
    verdicts = []
    sentInputs.length = 0
    failOnSend = 0
    reply = 'one\n\ntwo'
    await mount(undefined)
    await wait(40)

    expect(sentInputs).toHaveLength(1)
    expect(sentInputs[0]?.body).toBe('one\n\ntwo')
  })
})
