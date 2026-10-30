import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import { defaultPipelineNodes } from '../src/pipeline-config.js'
import type { PipelineLayer } from '../src/pipeline-scopes.js'
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

function harness(botLayers: Map<string, PipelineLayer> = new Map([['orca', {}]])) {
  return new SessionPipelines({ global: defaultPipelineNodes(), botLayers })
}

describe('a session declares what it runs at run time', () => {
  test('the session difference lands on the bot pipeline', () => {
    const sessions = harness(new Map([['orca', { remove: ['noise'] }]]))
    sessions.forSession('orca', 'p2p:seal', { remove: ['score'] })

    expect(ids(sessions.pipelineFor('orca', 'p2p:seal'))).toEqual(['budget', 'deny', 'allow', 'judge', 'prepare'])
  })

  test('a session that declared nothing runs the bot pipeline', () => {
    const sessions = harness(new Map([['orca', { remove: ['noise'] }]]))

    expect(ids(sessions.pipelineFor('orca', 'p2p:nobody'))).toEqual(['budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
    expect(ids(sessions.pipelineFor('orca'))).toEqual(['budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
  })

  test('every adapter of one bot shares the same session layer', () => {
    const sessions = harness()
    sessions.forSession('orca', 'group:123', { remove: ['judge'] })

    expect(ids(sessions.pipelineFor('orca', 'group:123'))).not.toContain('judge')
    expect(sessions.keysFor('orca')).toEqual(['group:123'])
  })

  test('forgetting a session puts it back on the bot pipeline', () => {
    const sessions = harness()
    sessions.forSession('orca', 'peer:u1', { remove: ['score'] })
    sessions.forgetSession('orca', 'peer:u1')

    expect(ids(sessions.pipelineFor('orca', 'peer:u1'))).toContain('score')
    expect(sessions.keysFor('orca')).toEqual([])
  })
})

describe('the plugin offers the session API to its host', () => {
  test('a mounted bot can declare and read a session layer', async () => {
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
          listen: { host: '127.0.0.1', port },
        },
      ],
    })
    forks.push(fork)
    const api = ctx.get('dsbot-channel.pipeline') as {
      forSession: (botName: string, key: string, layer: PipelineLayer) => void
      pipelineFor: (botName: string, key?: string) => { id: string; type: string }[]
    }

    api.forSession('bot-a', 'p2p:seal', { remove: ['judge'] })
    const nodes = api.pipelineFor('bot-a', 'p2p:seal')

    expect(nodes.map((node) => node.id)).not.toContain('judge')
    expect(nodes.map((node) => node.id)).toContain('noise')
  })

  test('a session layer the host could never run is refused at the call', async () => {
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
          listen: { host: '127.0.0.1', port },
        },
      ],
    })
    forks.push(fork)
    const api = ctx.get('dsbot-channel.pipeline') as {
      forSession: (botName: string, key: string, layer: PipelineLayer) => void
    }

    expect(() => api.forSession('bot-a', 'p2p:seal', { insert: [{ id: 'j', type: 'judge', after: 'noise' }] })).toThrow(
      /a judge node needs a model call this version does not supply/,
    )
  })
})

describe('a session layer that could never run is refused', () => {
  test('a bot nobody answers for is refused', () => {
    const sessions = harness()

    expect(() => sessions.forSession('nobody', 'p2p:seal', {})).toThrow(/no adapter answers for bot "nobody"/)
  })

  test('a key that names no scope is refused', () => {
    const sessions = harness()

    for (const key of ['seal', 'p2p:', 'dm:1', '']) {
      expect(() => sessions.forSession('orca', key, {})).toThrow(/session key must look like/)
    }
  })

  test('a difference that cannot be applied is refused', () => {
    const sessions = harness()

    expect(() => sessions.forSession('orca', 'p2p:seal', { remove: ['ghost'] })).toThrow(/ghost/)
  })

  test('a node this version cannot bind is refused, not left to run nothing', () => {
    const sessions = harness()

    expect(() => sessions.forSession('orca', 'p2p:seal', { insert: [{ id: 'j', type: 'judge', after: 'noise' }] })).toThrow(
      /node "j": a judge node needs a model call this version does not supply/,
    )
  })
})
