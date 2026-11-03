import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { ImpressionStore, botDirectoryName, subjectFileName } from '../src/impressions.js'

const REF = '{{SECRET_impressions_mount}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

let ports: AdapterPorts | undefined

function message(eventKey: string): InboundMessage {
  return {
    eventKey,
    chainId: eventKey,
    sessionKey: 'group:12345',
    replyTarget: '12345',
    requestId: eventKey,
    source: { kind: 'x-group', instance: 'inst-a', peer: null, scope: 'group' },
    author: { senderId: 'u1', kind: 'person', personId: 'evil' },
    rawText: 'hello',
    body: { text: 'hello', media: [], replyTo: null },
    transport: {
      messageId: eventKey,
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

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-impressions-mount-'))
  roots.push(dir)
  return dir
}

interface Toolbox {
  registered: string[]
  tools: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>
}

async function mount(
  options: { impressions?: unknown; withTools?: boolean; identity?: unknown; gate?: { started: () => void; done: Promise<void> } } = {},
): Promise<Toolbox> {
  const registered: string[] = []
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: async () => {
          options.gate?.started()
          if (options.gate !== undefined) await options.gate.done
          return { accepted: true }
        },
      })
      if (options.withTools !== false) {
        scope.provide('tools')
        scope.set('tools', {
          register: (definition: { name?: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
            if (typeof definition.name === 'string') {
              registered.push(definition.name)
              tools.set(definition.name, definition)
            }
            return () => undefined
          },
        })
      }
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-group', create: () => new StubAdapter() }))
  await ctx.plugin(entry, {
    ...(options.impressions === undefined ? {} : { impressions: options.impressions }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    adapters: [{ kind: 'x-group', channel: 'x:a', instance: 'inst-a', botName: 'bot-a', policy: {}, transport: {} }],
  })
  return { registered, tools }
}

describe('mounting the impression store', () => {
  test('registers no impression tool when no directory is configured', async () => {
    const mounted = await mount()
    expect(mounted.registered.filter((name) => name.startsWith('impression_'))).toEqual([])
  })

  test('registers the three tools when a directory is configured', async () => {
    const dir = await tempRoot()
    const mounted = await mount({ impressions: { dir } })
    expect(mounted.registered).toEqual(expect.arrayContaining(['impression_put', 'impression_get', 'impression_forget']))
  })

  test('refuses a relative directory', async () => {
    await expect(mount({ impressions: { dir: 'notes' } })).rejects.toThrow(/absolute/)
  })

  test('refuses a directory that holds a damaged file, naming it', async () => {
    const dir = await tempRoot()
    const file = join(dir, botDirectoryName('bot-a'), 'person', `${subjectFileName('alice')}.json`)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, '{not json', { mode: 0o600 })
    await expect(mount({ impressions: { dir } })).rejects.toThrow(file)
  })

  test('needs the tools service once impressions are on', async () => {
    const dir = await tempRoot()
    await expect(mount({ impressions: { dir }, withTools: false })).rejects.toThrow(/tools service/)
  })
})


describe('a real turn writing an impression', () => {
  const bound = {
    people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
  }

  test('stamps the note with the turn identity and the message it answered', async () => {
    const dir = await tempRoot()
    let start: () => void = () => undefined
    let release: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = await mount({
      impressions: { dir },
      identity: bound,
      gate: { started: start, done },
    })
    const turn = ports!.onMessage(message('m-1'))
    await started
    const raw = await mounted.tools.get('impression_put')!.execute(
      { text: 'alice ships on Fridays', kind: 'fact' },
      { agent: { id: 'session-1' } },
    )
    expect(JSON.parse(String(raw))).toEqual({ ok: true, id: expect.any(String), records: 1 })
    release()
    await Promise.resolve(turn)

    const store = new ImpressionStore({ dir, bot: 'bot-a' })
    await store.load()
    const read = await store.read('person', 'alice')
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect(read.records).toHaveLength(1)
    expect(read.records[0]!.evidence).toEqual([
      { eventKey: 'm-1', sessionKey: 'group:12345', channel: 'x:a', at: expect.any(Number) },
    ])
    expect(read.records[0]!.scope).toBe('group')
    expect(read.records[0]!.groupKey).toBe('x:a|group:12345')
  })
})
