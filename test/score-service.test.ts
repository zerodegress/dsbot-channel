import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { Config, checkPipelineScopes } from '../src/plugin.js'
import type { ChannelConfig } from '../src/plugin.js'
import { validateConfig } from '../src/config.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = 'score-ref'
const credentials = staticCredentials({ [REF]: 'shared-value' })

const sessionStub = {
  create: () => Promise.resolve({ sessionId: 'session-1' }),
  prompt: () => Promise.resolve({ accepted: true }),
}

interface MountOptions {
  score?: ((event: unknown, context: unknown) => number | Promise<number>) | undefined
  service?: unknown
  pipeline?: Record<string, unknown>
  layers?: Record<string, unknown>
}

async function mount(options: MountOptions = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', sessionStub)
      const service = options.service ?? (options.score === undefined ? undefined : { score: options.score })
      if (service !== undefined) {
        scope.provide('dsbot-channel/score')
        scope.set('dsbot-channel/score', service)
      }
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    pipeline: { global: [{ id: 's', type: 'score' }, { id: 'a', type: 'allow' }], ...(options.pipeline ?? {}) },
    adapters: [
      {
        channel: 'inst-a',
        botName: 'bot-a',
        policy: { allow: { peers: ['inst-b'] } },
        ...(options.layers === undefined ? {} : { pipeline: options.layers }),
        transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
      },
    ],
  })
  return ctx
}

const adapter = (overrides: Record<string, unknown> = {}) => ({
  channel: 'inst-a',
  botName: 'bot-a',
  policy: { allow: { peers: ['inst-b'] } },
  transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
  ...overrides,
})

describe('a score node binds the scoring service', () => {
  test('a declared score node without the service fails the mount, naming it', async () => {
    await expect(mount()).rejects.toThrow(/dsbot-channel\/score/)
  })

  test('a service without a score function fails the mount the same way', async () => {
    await expect(mount({ service: {} })).rejects.toThrow(/dsbot-channel\/score/)
  })

  test('mounting the service lets the pipeline load', async () => {
    const ctx = await mount({ score: () => 1 })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('no score node means the service is not needed', async () => {
    const ctx = await mount({ pipeline: { global: [{ id: 'a', type: 'allow' }] } })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('a score node a layer inserts still needs the service', async () => {
    await expect(
      mount({ pipeline: { global: [{ id: 'a', type: 'allow' }] }, layers: { insert: [{ id: 's', type: 'score', after: 'a' }] } }),
    ).rejects.toThrow(/dsbot-channel\/score/)
  })

  test('a layer insert that carries the service mounts', async () => {
    const ctx = await mount({
      score: () => 2,
      pipeline: { global: [{ id: 'a', type: 'allow' }] },
      layers: { insert: [{ id: 's', type: 'score', after: 'a' }] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('a layer insert may not give a score node a field it does not own', () => {
    const config = validateConfig<ChannelConfig>(Config, {
      adapters: [adapter({ pipeline: { insert: [{ id: 's', type: 'score', after: 'a', allowAtLeast: 0.5 }] } })],
      pipeline: { global: [{ id: 'a', type: 'allow' }] },
    })
    expect(() => checkPipelineScopes(config, () => undefined)).toThrow(/only a judge node may declare allowAtLeast/)
  })
})
