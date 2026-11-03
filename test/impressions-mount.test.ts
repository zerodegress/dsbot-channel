import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { applyWith } from '../src/plugin.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, InboundMessage, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { ImpressionStore, botDirectoryName, impressionId, subjectFileName } from '../src/impressions.js'
import type { Impression } from '../src/impressions.js'

const REF = '{{SECRET_impressions_mount}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })
const AT = 1_700_000_000_000
const GROUP = 'x:a|group:12345'

function note(overrides: Partial<Impression> = {}): Impression {
  const base: Omit<Impression, 'id'> = {
    subject: 'alice',
    subjectKind: 'person',
    scope: 'group',
    groupKey: GROUP,
    text: 'alice likes tea',
    kind: 'fact',
    confidence: 0.6,
    share: 'local',
    evidence: [{ eventKey: 'seed:1', sessionKey: 'group:12345', channel: 'x:a', at: AT }],
    bot: 'bot-a',
    createdAt: AT,
    updatedAt: AT,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, id: impressionId(merged) }
}

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
  /** A third-party transport that cannot name the scope of its session keys. */
  sessionScope?: (key: string) => 'group' | 'c2c' | 'p2p' | undefined

  constructor(scopeless = false) {
    if (!scopeless) {
      this.sessionScope = (key) => {
        if (key.startsWith('group:')) return 'group'
        if (key.startsWith('peer:')) return 'c2c'
        if (key.startsWith('p2p:')) return 'p2p'
        return undefined
      }
    }
  }
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
  prompts: string[]
  warnings: string[]
}

async function mount(
  options: {
    impressions?: unknown
    withTools?: boolean
    identity?: unknown
    turn?: unknown
    scopelessAdapter?: boolean
    gate?: { started: () => void; done: Promise<void> }
  } = {},
): Promise<Toolbox> {
  const registered: string[] = []
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const prompts: string[] = []
  const warnings: string[] = []
  const ctx = new Context()
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
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: async (request: { sessionId: string; content: readonly { text?: string }[] }) => {
          prompts.push(request.content.map((part) => part.text ?? '').join(''))
          options.gate?.started()
          if (options.gate !== undefined) await options.gate.done
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: request.sessionId } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [] } } })
          emit({ type: 'turn/end' })
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
  await ctx.plugin(
    defineAdapterPlugin({ kind: 'x-group', create: () => new StubAdapter(options.scopelessAdapter === true) }),
  )
  const probe = {
    name: 'probe-entry',
    apply: (scope: Context, config: unknown) => applyWith(scope, config, { now: () => AT }),
  }
  await ctx.plugin(probe, {
    ...(options.impressions === undefined ? {} : { impressions: options.impressions }),
    ...(options.identity === undefined ? {} : { identity: options.identity }),
    ...(options.turn === undefined ? {} : { turn: options.turn }),
    adapters: [{ kind: 'x-group', channel: 'x:a', instance: 'inst-a', botName: 'bot-a', policy: {}, transport: {} }],
  })
  return { registered, tools, prompts, warnings }
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


describe('the import subject and the turn budget at mount', () => {
  const bound = {
    people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
  }
  const bots = {
    bots: [{ id: 'bot-x', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u9' }] }],
  }
  const importOf = (as: unknown) => ({ path: '/srv/notes/MEMORY.md', as })

  test('accepts a declared person and a session this profile can carry', async () => {
    const dir = await tempRoot()
    await expect(
      mount({ impressions: { dir, import: importOf({ personId: 'alice' }) }, identity: bound }),
    ).resolves.toBeDefined()
    const groupDir = await tempRoot()
    await expect(
      mount({ impressions: { dir: groupDir, import: importOf({ groupKey: 'x:a|group:12345' }) } }),
    ).resolves.toBeDefined()
  })

  test('refuses an import that names an undeclared person or a bot node', async () => {
    const dir = await tempRoot()
    await expect(mount({ impressions: { dir, import: importOf({ personId: 'alice' }) } })).rejects.toThrow(
      /undeclared person/,
    )
    const botDir = await tempRoot()
    await expect(
      mount({ impressions: { dir: botDir, import: importOf({ personId: 'bot-x' }) }, identity: bots }),
    ).rejects.toThrow(/bot node, not a person/)
  })

  test('refuses a group key that names no mounted channel or no acceptable session', async () => {
    const dir = await tempRoot()
    await expect(
      mount({ impressions: { dir, import: importOf({ groupKey: 'x:b|group:1' }) } }),
    ).rejects.toThrow(/unmounted channel/)
    const malformed = await tempRoot()
    await expect(
      mount({ impressions: { dir: malformed, import: importOf({ groupKey: 'group:1' }) } }),
    ).rejects.toThrow(/<channel>\|<sessionKey>/)
  })

  test('refuses a turn budget outside 0..2000', async () => {
    const dir = await tempRoot()
    await expect(mount({ impressions: { dir }, turn: { impressions: { chars: 2001 } } })).rejects.toThrow(
      /between 0 and 2000/,
    )
  })
})


describe('the impressions block in a real turn', () => {
  const bound = {
    people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
  }

  async function seed(dir: string, records: { person?: Impression[]; group?: Impression[] }): Promise<void> {
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    if (records.person !== undefined) {
      await store.transact('person', 'alice', (kept) => [...kept, ...records.person!])
    }
    if (records.group !== undefined) {
      await store.transact('group', GROUP, (kept) => [...kept, ...records.group!])
    }
  }

  function gate(): { started: Promise<void>; done: Promise<void>; start: () => void; release: () => void } {
    let start: () => void = () => undefined
    let release: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    return { started, done, start, release }
  }

  test('places the block after guidance and before the message', async () => {
    const dir = await tempRoot()
    await seed(dir, {
      person: [note({ text: 'alice likes tea', scope: 'group', groupKey: GROUP })],
      group: [note({ subject: GROUP, subjectKind: 'group', scope: 'group', groupKey: GROUP, kind: 'topic', text: 'release day is Friday' })],
    })
    const held = gate()
    const mounted = await mount({ impressions: { dir }, identity: bound, gate: { started: held.start, done: held.done } })
    const turn = ports!.onMessage(message('m-1'))
    await held.started
    const text = mounted.prompts[0]!
    expect(text).toContain('alice likes tea')
    expect(text).toContain('- [group] release day is Friday')
    expect(text.indexOf('[x-group]')).toBeLessThan(text.indexOf('[impressions]'))
    expect(text.indexOf('[impressions]')).toBeLessThan(text.indexOf('hello'))
    held.release()
    await turn
  })

  test('turns the block off at zero while the tools stay registered', async () => {
    const dir = await tempRoot()
    await seed(dir, { person: [note({ scope: 'group', groupKey: GROUP })] })
    const held = gate()
    const mounted = await mount({
      impressions: { dir },
      identity: bound,
      turn: { impressions: { chars: 0 } },
      gate: { started: held.start, done: held.done },
    })
    const turn = ports!.onMessage(message('m-2'))
    await held.started
    expect(mounted.prompts[0]).not.toContain('[impressions]')
    expect(mounted.registered).toEqual(expect.arrayContaining(['impression_put', 'impression_get', 'impression_forget']))
    held.release()
    await turn
  })
})


describe('the session scope an import may target', () => {
  const importOf = (groupKey: string) => ({ path: '/srv/notes/MEMORY.md', as: { groupKey } })

  test('refuses a peer-to-peer key and a private key, and takes a group key', async () => {
    const p2p = await tempRoot()
    await expect(
      mount({ impressions: { dir: p2p, import: importOf('x:a|p2p:peer-a') } }),
    ).rejects.toThrow(/names a p2p session, not a group/)
    const priv = await tempRoot()
    await expect(
      mount({ impressions: { dir: priv, import: importOf('x:a|peer:123') } }),
    ).rejects.toThrow(/names a c2c session, not a group/)
    const group = await tempRoot()
    await expect(
      mount({ impressions: { dir: group, import: importOf('x:a|group:12345') } }),
    ).resolves.toBeDefined()
  })

  test('lets a transport that cannot name a scope through with a warning', async () => {
    const dir = await tempRoot()
    await expect(
      mount({ impressions: { dir, import: importOf('x:a|whatever:1') }, scopelessAdapter: true }),
    ).resolves.toBeDefined()
  })
})


describe('reading the store for a turn', () => {
  const bound = {
    people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
  }

  async function waitFor(condition: () => boolean): Promise<void> {
    const started = Date.now()
    while (!condition()) {
      if (Date.now() - started > 2000) throw new Error('timed out waiting for the turn')
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }

  async function seed(dir: string): Promise<string> {
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    await store.transact('person', 'alice', () => [note()])
    return join(dir, botDirectoryName('bot-a'), 'person', `${subjectFileName('alice')}.json`)
  }

  test('a peer turn does not read the store at all', async () => {
    const dir = await tempRoot()
    const path = await seed(dir)
    await chmod(path, 0o644)
    const mounted = await mount({ impressions: { dir }, identity: bound })
    const peer = message('m-peer')
    peer.source.scope = 'p2p'
    peer.sessionKey = 'p2p:peer-a'
    await ports!.onMessage(peer)
    await waitFor(() => mounted.prompts.length === 1)
    expect(mounted.prompts[0]).not.toContain('[impressions]')
    expect(mounted.warnings.filter((line) => line.includes('could not read'))).toHaveLength(0)
  })

  test('a file that stops parsing warns once across turns', async () => {
    const dir = await tempRoot()
    const path = await seed(dir)
    const mounted = await mount({ impressions: { dir }, identity: bound })
    await writeFile(path, '{not json', { mode: 0o600 })
    await ports!.onMessage(message('bad-1'))
    await waitFor(() => mounted.prompts.length === 1)
    await ports!.onMessage(message('bad-2'))
    await waitFor(() => mounted.prompts.length === 2)
    const failures = mounted.warnings.filter((line) => line.includes('could not read'))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('not valid JSON')
    expect(mounted.prompts.every((text) => !text.includes('[impressions]'))).toBe(true)
  })

  test('a read failure warns once per path and reason, clears on success, and warns again later', async () => {
    const dir = await tempRoot()
    const path = await seed(dir)
    await chmod(path, 0o644)
    const mounted = await mount({ impressions: { dir }, identity: bound })
    await ports!.onMessage(message('m-1'))
    await waitFor(() => mounted.prompts.length === 1)
    expect(mounted.prompts[0]).not.toContain('[impressions]')
    const failures = () => mounted.warnings.filter((line) => line.includes('could not read'))
    expect(failures()).toHaveLength(1)
    expect(failures()[0]).toContain(path)

    await ports!.onMessage(message('m-2'))
    await waitFor(() => mounted.prompts.length === 2)
    expect(failures()).toHaveLength(1)

    await chmod(path, 0o600)
    await ports!.onMessage(message('m-3'))
    await waitFor(() => mounted.prompts.length === 3)
    expect(mounted.prompts[2]).toContain('[impressions]')

    await chmod(path, 0o644)
    await ports!.onMessage(message('m-4'))
    await waitFor(() => mounted.prompts.length === 4)
    expect(failures()).toHaveLength(2)
  })
})


describe('the one-time import at mount', () => {
  const bound = {
    people: [{ id: 'alice', accounts: [{ kind: 'x-group', instance: 'inst-a', accountId: 'u1' }] }],
  }

  test('imports a host memory file and shows it in a private turn', async () => {
    const dir = await tempRoot()
    const memoryDir = await tempRoot()
    const path = join(memoryDir, 'MEMORY.md')
    await writeFile(path, '- alice prefers short answers [source: 1]\n', { mode: 0o600 })
    let start: () => void = () => undefined
    let release: () => void = () => undefined
    const started = new Promise<void>((resolve) => {
      start = resolve
    })
    const done = new Promise<void>((resolve) => {
      release = resolve
    })
    const mounted = await mount({
      impressions: { dir, import: { path, as: { personId: 'alice' } } },
      identity: bound,
      gate: { started: start, done },
    })
    const one = message('imp-1')
    one.source.scope = 'c2c'
    one.sessionKey = 'peer:1'
    const turn = ports!.onMessage(one)
    await started
    expect(mounted.prompts[0]).toContain('alice prefers short answers')
    expect(mounted.warnings.some((line) => line.includes('imported 1 impressions'))).toBe(true)
    release()
    await turn
  })

  test('reports the lines the subject had no room for', async () => {
    const dir = await tempRoot()
    const memoryDir = await tempRoot()
    const path = join(memoryDir, 'MEMORY.md')
    await writeFile(path, Array.from({ length: 20 }, (_, index) => `- line ${index}`).join('\n') + '\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    const many = Array.from({ length: 64 }, (_, index) =>
      note({ text: `note ${index}`, createdAt: AT + index, updatedAt: AT + index }),
    )
    await store.transact('person', 'alice', () => many)
    const mounted = await mount({
      impressions: { dir, import: { path, as: { personId: 'alice' } } },
      identity: bound,
    })
    expect(mounted.warnings.some((line) => line.includes('no room for 20 lines'))).toBe(true)
    expect(mounted.warnings.some((line) => line.includes('20 without room'))).toBe(true)
  })

  test('warns when the source is unreadable and still mounts', async () => {
    const dir = await tempRoot()
    const missing = join(dir, 'nope', 'MEMORY.md')
    const mounted = await mount({ impressions: { dir, import: { path: missing, as: { personId: 'alice' } } }, identity: bound })
    expect(mounted.warnings.some((line) => line.includes('could not import from'))).toBe(true)
  })
})
