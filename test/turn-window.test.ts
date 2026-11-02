import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../src/index.js'
import { applyWith } from '../src/plugin.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterStatus } from '../src/adapter-status.js'
import type { AdapterHandle, AdapterPorts, ChannelAdapter, InboundMessage, SendResult } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_window}}'

class WindowAdapter implements ChannelAdapter {
  readonly kind = 'x-w'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = { text: true, image: NO_MEDIA, file: NO_MEDIA, voice: NO_MEDIA, recall: false, history: false, mention: false, reply: true, stream: false }
  ports: AdapterPorts | undefined

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
      counters: { authFailures: 0, unknownPaths: 0, underruns: 0, protocolMismatches: 0, sendFailures: {}, lastFailure: null },
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
  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    this.ports = ports
    return { stop: () => Promise.resolve() }
  }
}

const adapter = new WindowAdapter()

function message(eventKey: string): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'group:1',
    replyTarget: 'room-1',
    requestId: eventKey,
    source: { kind: 'x-w', instance: 'inst-a', peer: 'inst-a', scope: 'group' },
    author: { senderId: 'u1', kind: 'person', personId: null },
    rawText: `text ${eventKey}`,
    body: { text: `text ${eventKey}`, media: [], replyTo: null },
    transport: { messageId: eventKey, timestamp: 1, mentioned: { self: true, others: false, all: false }, isReply: false, signature: null },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
    adapter: {},
    receivedAt: 1,
  }
}

async function harness(turn: { coalesceMs: number; maxBatch?: number; maxChars?: number }) {
  const ctx = new Context()
  const warnings: string[] = []
  ctx.logger.exporter({ levels: { default: 3 }, export(message: { args: unknown[] }) { warnings.push(message.args.map((arg) => String(arg)).join(' ')) } })
  let now = 0
  let prompts = 0
  const timers = new Set<() => void>()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', staticCredentials({ [REF]: 'shared-value' }))
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => {
          prompts += 1
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-w', create: () => adapter }))
  const fork = await ctx.plugin({
    name: 'dsbot-channel-under-test',
    apply: (scope: Context, config: unknown) =>
      applyWith(scope, config, {
        now: () => now,
        setTimer: (callback) => {
          timers.add(callback)
          return callback
        },
        clearTimer: (handle) => {
          timers.delete(handle as () => void)
        },
      }),
  }, {
    turn,
    adapters: [{ kind: 'x-w', channel: 'x:a', instance: 'inst-a', botName: 'bot-a', transport: {} }],
  })
  const deliver = async (eventKey: string): Promise<void> => {
    const verdict = await adapter.ports!.onMessage(message(eventKey))
    if (!verdict.ok) throw new Error(`refused: ${verdict.code} ${verdict.reason}`)
  }
  const fire = (): void => {
    now += turn.coalesceMs + 1
    const due = [...timers]
    timers.clear()
    for (const callback of due) callback()
  }
  return { ctx, fork, deliver, fire, timers, warnings, prompts: () => prompts }
}

describe('the window a batch waits in', () => {
  test('stopping clears the window, so nothing fires afterwards', async () => {
    const { fork, deliver, timers, prompts } = await harness({ coalesceMs: 100 })
    await deliver('evt-1')
    expect(timers.size).toBe(1)
    await fork.dispose()
    expect(timers.size).toBe(0)
    await deliver('evt-2').catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(prompts()).toBe(0)
  })
})

describe('the window clock is not a profile knob', () => {
  test('the entry does not export the injectable core', () => {
    expect('applyWith' in entry).toBe(false)
  })
})
