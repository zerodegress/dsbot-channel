import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import { defaultPipelineNodes } from '../src/pipeline-config.js'
import type { PipelineNodeSpec } from '../src/pipeline-config.js'
import type { PipelineLayer } from '../src/pipeline-scopes.js'
import type { BotScope } from '../src/session-pipeline.js'
import { SessionPipelines } from '../src/session-pipeline.js'

const ids = (nodes: readonly { id: string }[]): string[] => nodes.map((node) => node.id)

const forks: { dispose(): Promise<void> }[] = []
const REF = '{{SECRET_4dhhwz2n}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

afterEach(async () => {
  while (forks.length > 0) await forks.pop()?.dispose()
})

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

interface BotInput {
  layer?: PipelineLayer
  deny?: boolean
  allow?: boolean
  peers?: string[]
}

function harness(input: Record<string, BotInput> = { orca: { peers: ['seal'] } }) {
  const bots = new Map<string, BotScope>(
    Object.entries(input).map(([name, one]) => [
      name,
      {
        ...(one.layer === undefined ? {} : { layer: one.layer }),
        denyRules: one.deny ?? false,
        allowRules: one.allow ?? false,
        peers: one.peers ?? [],
      },
    ]),
  )
  return new SessionPipelines({ global: defaultPipelineNodes(), bots })
}

async function mount(options: { policy?: Record<string, unknown> } = {}) {
  const port = await freePort()
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => Promise.resolve({ accepted: true }),
      })
    },
  })
  const fork = await ctx.plugin(entry, {
    adapters: [
      {
        channel: 'p2p:a',
        instance: 'inst-a',
        botName: 'bot-a',
        peers: [{ instance: 'inst-b', secret: REF }],
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        listen: { host: '127.0.0.1', port },
      },
    ],
  })
  forks.push(fork)
  return ctx.get('dsbot-channel.pipeline') as {
    forSession: (botName: string, key: string, layer: PipelineLayer) => void
    pipelineFor: (botName: string, key?: string) => { id: string; type: string }[]
  }
}

describe('a session declares what it runs at run time', () => {
  test('the session difference lands on the bot pipeline', () => {
    const sessions = harness({ orca: { layer: { remove: ['noise'] }, peers: ['seal'] } })
    sessions.forSession('orca', 'p2p:seal', { remove: ['score'] })

    expect(ids(sessions.pipelineFor('orca', 'p2p:seal'))).toEqual(['budget', 'deny', 'allow', 'judge', 'prepare'])
  })

  test('a session that declared nothing runs the bot pipeline', () => {
    const sessions = harness({ orca: { layer: { remove: ['noise'] }, peers: ['seal'] } })

    expect(ids(sessions.pipelineFor('orca', 'p2p:seal'))).toEqual(['budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
    expect(ids(sessions.pipelineFor('orca'))).toEqual(['budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
  })

  test('every adapter of one bot shares the same session layer', () => {
    const sessions = harness()
    sessions.forSession('orca', 'group:123', { remove: ['judge'] })

    expect(ids(sessions.pipelineFor('orca', 'group:123'))).not.toContain('judge')
    expect(ids(sessions.pipelineFor('orca'))).toContain('judge')
  })

  test('forgetting a session puts it back on the bot pipeline', () => {
    const sessions = harness()
    sessions.forSession('orca', 'peer:u1', { remove: ['score'] })
    sessions.forgetSession('orca', 'peer:u1')

    expect(ids(sessions.pipelineFor('orca', 'peer:u1'))).toEqual(ids(sessions.pipelineFor('orca')))
  })

  test('a layer the caller keeps and edits cannot reach the session', () => {
    const sessions = harness({ orca: { allow: true } })
    const insert = [{ id: 'extra', type: 'allow', after: 'allow' }]
    const patch: Partial<PipelineNodeSpec> = { type: 'allow' }
    sessions.forSession('orca', 'group:1', { insert, override: { allow: patch } })

    insert.push({ id: 'sneak', type: 'judge', after: 'extra' })
    patch.type = 'deny'

    const nodes = sessions.pipelineFor('orca', 'group:1')
    expect(ids(nodes)).not.toContain('sneak')
    expect(nodes.find((node) => node.id === 'allow')?.type).toBe('allow')
  })
})

describe('the plugin offers the session API to its host', () => {
  test('a mounted bot can declare and read a session layer', async () => {
    const api = await mount()

    api.forSession('bot-a', 'p2p:inst-b', { remove: ['judge'] })
    const nodes = api.pipelineFor('bot-a', 'p2p:inst-b')

    expect(nodes.map((node) => node.id)).not.toContain('judge')
    expect(nodes.map((node) => node.id)).toContain('noise')
  })

  test('a peer name the adapter does not address is refused at the call', async () => {
    const api = await mount()

    expect(() => api.forSession('bot-a', 'p2p:inst-bb', {})).toThrow(/addresses no peer "inst-bb"; known: inst-b/)
  })

  test('a session layer the host could never run is refused at the call', async () => {
    const api = await mount()

    expect(() =>
      api.forSession('bot-a', 'p2p:inst-b', { insert: [{ id: 'j', type: 'judge', after: 'noise' }] }),
    ).toThrow(/a judge node needs a model call this version does not supply/)
  })

  test('a misspelt layer field is refused through the mounted API too', async () => {
    const api = await mount()

    expect(() => api.forSession('bot-a', 'p2p:inst-b', { insertt: [] } as never)).toThrow(
      /a session layer names a field no layer has: "insertt"/,
    )
  })

  test('a rule node with no rule behind it is refused at the call', async () => {
    const api = await mount({ policy: { allow: { peers: ['inst-b'] } } })

    expect(() =>
      api.forSession('bot-a', 'p2p:inst-b', { insert: [{ id: 'extra-deny', type: 'deny', after: 'noise' }] }),
    ).toThrow(/node "extra-deny": a deny node has no rule to match/)
  })

  test('reading a bot nobody answers for is refused too', async () => {
    const api = await mount()

    expect(() => api.pipelineFor('bot-b')).toThrow(/no adapter answers for bot "bot-b"/)
  })
})

describe('a session layer that could never run is refused', () => {
  test('a bot nobody answers for is refused', () => {
    const sessions = harness()

    expect(() => sessions.forSession('nobody', 'p2p:seal', {})).toThrow(/no adapter answers for bot "nobody"; known: orca/)
  })

  test('no known bot leaves no dangling list in the message', () => {
    const sessions = harness({})

    expect(() => sessions.forSession('nobody', 'p2p:seal', {})).toThrow(
      /no adapter answers for bot "nobody" \(at pipeline\)$/,
    )
  })

  test('a key that names no scope is refused', () => {
    const sessions = harness()

    for (const key of ['seal', 'p2p:', 'dm:1', '']) {
      expect(() => sessions.forSession('orca', key, {})).toThrow(/session key must look like/)
    }
  })

  test('a peer name no adapter of the bot addresses is refused', () => {
    const sessions = harness({ orca: { peers: ['inst-b'] } })

    for (const key of ['p2p:inst-bb', 'p2p:typo']) {
      expect(() => sessions.forSession('orca', key, {})).toThrow(/addresses no peer .*; known: inst-b/)
    }
  })

  test('a bot that addresses no peer says so instead of listing nothing', () => {
    const sessions = harness({ orca: {} })

    expect(() => sessions.forSession('orca', 'p2p:seal', {})).toThrow(
      /addresses no peer "seal"; this bot addresses no peer/,
    )
  })

  test('a group and a peer key have no registry to check, and are accepted', () => {
    const sessions = harness()

    sessions.forSession('orca', 'group:not-a-real-group', { remove: ['noise'] })
    sessions.forSession('orca', 'peer:openid-1', { remove: ['noise'] })

    expect(ids(sessions.pipelineFor('orca', 'group:not-a-real-group'))).not.toContain('noise')
    expect(ids(sessions.pipelineFor('orca', 'peer:openid-1'))).not.toContain('noise')
  })

  test('a field no layer has is refused instead of being dropped', () => {
    const sessions = harness()

    for (const layer of [{ insertt: [] }, { reomve: [] }, { inherit: 'bot', extra: 1 }]) {
      expect(() => sessions.forSession('orca', 'group:1', layer as PipelineLayer)).toThrow(
        /a session layer names a field no layer has/,
      )
    }
  })

  test('a field no insert has is refused instead of being dropped', () => {
    const sessions = harness()

    expect(() =>
      sessions.forSession('orca', 'group:1', {
        insert: [{ id: 'x', type: 'allow', after: 'allow', bogus: 1 } as never],
      }),
    ).toThrow(/insert "x" names a field no insert has: "bogus"/)
  })

  test('a difference that cannot be applied is refused', () => {
    const sessions = harness()

    expect(() => sessions.forSession('orca', 'p2p:seal', { remove: ['ghost'] })).toThrow(/ghost/)
  })

  test('a node this version cannot bind is refused, not left to run nothing', () => {
    const sessions = harness()

    expect(() =>
      sessions.forSession('orca', 'p2p:seal', { insert: [{ id: 'j', type: 'judge', after: 'noise' }] }),
    ).toThrow(/node "j": a judge node needs a model call this version does not supply/)
  })

  test('a deny node is accepted when the bot has a deny rule', () => {
    const sessions = harness({ orca: { deny: true } })
    sessions.forSession('orca', 'group:1', { insert: [{ id: 'extra-deny', type: 'deny', after: 'noise' }] })

    expect(ids(sessions.pipelineFor('orca', 'group:1'))).toContain('extra-deny')
  })

  test('an allow node with no allow rule is refused', () => {
    const sessions = harness()

    expect(() =>
      sessions.forSession('orca', 'group:1', { insert: [{ id: 'extra-allow', type: 'allow', after: 'allow' }] }),
    ).toThrow(/node "extra-allow": an allow node has no rule to match/)
  })

  test('an override that turns a node into a rule node follows the same rule', () => {
    const sessions = harness()

    expect(() => sessions.forSession('orca', 'group:1', { override: { budget: { type: 'deny' } } })).toThrow(
      /node "budget": a deny node has no rule to match/,
    )
  })
})
