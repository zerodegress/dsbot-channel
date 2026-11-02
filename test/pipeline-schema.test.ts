import { describe, expect, test } from 'vitest'
import { registryPlugin } from '../src/registry-plugin.js'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { Config, checkPipelineScopes, checkPipelineSettings } from '../src/plugin.js'
import type { ChannelConfig } from '../src/plugin.js'
import { ConfigError } from '../src/config.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_pq7x2m4a}}'

const sessionStub = {
  create: () => Promise.resolve({ sessionId: 'session-1' }),
  prompt: () => Promise.resolve({ accepted: true }),
}

async function mount(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', staticCredentials({ [REF]: 'shared-value' }))
      scope.provide('sessionController')
      scope.set('sessionController', sessionStub)

    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, config)
  return ctx
}

const adapter = (overrides: Record<string, unknown> = {}) => {
  const { peers, listen, dedupe, inflightTtlMs, sentAtWindowMs, maxBodyBytes, waitMs, ...rest } = overrides
  return {
    channel: 'p2p:self',
    instance: 'inst-a',
    botName: 'bot-a',
    transport: {
      peers: peers ?? [{ instance: 'inst-b', secret: REF }],
      listen: listen ?? { host: '127.0.0.1', port: 0 },
      ...(dedupe === undefined ? {} : { dedupe }),
      ...(inflightTtlMs === undefined ? {} : { inflightTtlMs }),
      ...(sentAtWindowMs === undefined ? {} : { sentAtWindowMs }),
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      ...(waitMs === undefined ? {} : { waitMs }),
    },
    ...rest,
  }
}

const node = (id: string, type: string) => ({ id, type })

const parsed = (config: unknown): ChannelConfig => (Config as (value: unknown) => ChannelConfig)(config)

describe('the pipeline a profile declares', () => {
  test('refuses a global pipeline that cannot load, and names the layer', async () => {
    await expect(
      mount({ adapters: [], pipeline: { global: [{ id: 'prepare', type: 'prepare' }] } }),
    ).rejects.toThrow(/the pipeline cannot load: node "prepare"/)
  })

  test('a soft limit on a node is an unknown field', async () => {
    await expect(
      mount({ adapters: [], pipeline: { global: [{ id: 'budget', type: 'budget', softLimit: 0.7 }] } }),
    ).rejects.toThrow(/unknown config fields: softLimit/)
  })

  test('refuses a bot layer that writes a node the chain cannot hold', async () => {
    await expect(
      mount({
        adapters: [
          adapter({ pipeline: { insert: [{ id: 'late', type: 'prepare', after: 'allow', before: 'deny' }] } }),
        ],
        pipeline: { global: [node('deny', 'deny'), node('allow', 'allow')] },
      }),
    ).rejects.toThrow(/bot: insert "late" must name exactly one of after or before/)
  })

  test('mounts a pipeline that only looks wrong', async () => {
    const ctx = await mount({
      adapters: [adapter({ policy: { deny: { words: ['spam'] }, allow: { peers: ['inst-b'] } } })],
      pipeline: { global: [node('allow', 'allow'), node('deny', 'deny')] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('hands a warning to the reporter and keeps the mount alive', () => {
    const said: string[] = []
    const config = parsed({
      adapters: [adapter({ policy: { deny: { words: ['spam'] }, allow: { peers: ['inst-b'] } } })],
      pipeline: { global: [node('allow', 'allow'), node('deny', 'deny')] },
    })
    checkPipelineScopes(config, (message) => said.push(message))
    expect(said.some((line) => line.includes('allow runs before deny'))).toBe(true)
    expect(said.filter((line) => line.includes('pipeline warning:')).length).toBeGreaterThan(0)
  })

  test('a fatal layer stops before anything is reported as a warning', () => {
    const said: string[] = []
    const config = {
      adapters: [],
      pipeline: { global: [{ id: 'budget', type: 'budget', softLimit: 0.7 }] },
    } as unknown as Parameters<typeof checkPipelineScopes>[0]
    expect(() => checkPipelineScopes(config, (message) => said.push(message))).toThrow(/cannot load/)
    expect(said).toHaveLength(0)
  })

  test('refuses two adapters that answer for one bot with different layers', async () => {
    await expect(
      mount({
        adapters: [
          adapter({ channel: 'p2p:one', pipeline: { insert: [{ id: 'score', type: 'score', after: 'allow' }] } }),
          adapter({ channel: 'p2p:two', pipeline: { insert: [{ id: 'deny2', type: 'deny', after: 'allow' }] } }),
        ],
        pipeline: { global: [node('allow', 'allow')] },
      }),
    ).rejects.toThrow(/one bot runs one pipeline/)
  })

  test('accepts two adapters that answer for one bot with the same layer', async () => {
    const layer = { insert: [{ id: 'deny2', type: 'deny', after: 'deny' }] }
    const ctx = await mount({
      adapters: [
        adapter({ channel: 'p2p:one', pipeline: layer, policy: { deny: { words: ['spam'] } } }),
        adapter({ channel: 'p2p:two', pipeline: layer, policy: { deny: { words: ['spam'] } } }),
      ],
      pipeline: { global: [node('deny', 'deny')] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(2)
  })

  test('a pipeline is optional, and an empty one is not an error', async () => {
    const ctx = await mount({ adapters: [] })
    expect(ctx.get('dsbot-channel.peers')).toBeUndefined()
  })

  test('refuses a layer field the node type does not own', async () => {
    await expect(
      mount({
        adapters: [
          adapter({
            pipeline: { override: { deny: { restrictSkip: ['scoring'] } } },
          }),
        ],
        pipeline: { global: [node('deny', 'deny')] },
      }),
    ).rejects.toThrow(ConfigError)
  })

  test('refuses a declared node that nothing can bind', () => {
    const config = parsed({
      adapters: [
        adapter({
          pipeline: { insert: [{ id: 'judge2', type: 'judge', after: 'allow' }] },
          policy: { allow: { peers: ['inst-b'] } },
        }),
      ],
      pipeline: { global: [node('allow', 'allow')] },
    })
    expect(() => checkPipelineScopes(config, () => undefined)).toThrow(/a judge node needs a model call/)
  })

  test('refuses an unbound node even when no adapter is declared', async () => {
    await expect(
      mount({ adapters: [], pipeline: { global: [node('judge', 'judge')] } }),
    ).rejects.toThrow(/a judge node needs a model call/)
  })

  test('refuses a deny node when no adapter could ever bind a rule', async () => {
    await expect(
      mount({ adapters: [], pipeline: { global: [node('deny', 'deny')] } }),
    ).rejects.toThrow(/a deny node has no rule to match/)
  })

  test('reports one line for a problem every layer shares', () => {
    const layer = { insert: [{ id: 'deny2', type: 'deny', after: 'deny' }] }
    const config = parsed({
      adapters: [
        adapter({ channel: 'p2p:one', botName: 'bot-a', pipeline: layer, policy: { deny: { words: ['spam'] } } }),
        adapter({ channel: 'p2p:two', botName: 'bot-b', pipeline: layer, policy: { deny: { words: ['spam'] } } }),
      ],
      pipeline: { global: [node('judge', 'judge')] },
    })
    let message = ''
    try {
      checkPipelineScopes(config, () => undefined)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message.match(/a judge node needs a model call/g)?.length).toBe(1)
  })

  test('refuses a deny node with no rule to match', () => {
    const config = parsed({ adapters: [adapter()], pipeline: { global: [node('deny', 'deny')] } })
    expect(() => checkPipelineScopes(config, () => undefined)).toThrow(/a deny node has no rule to match/)
  })

  test('names the bot whose policy cannot bind the rule', () => {
    const config = parsed({
      adapters: [
        adapter({ channel: 'p2p:one', botName: 'bot-a', policy: { deny: { words: ['spam'] } } }),
        adapter({ channel: 'p2p:two', botName: 'bot-b' }),
      ],
      pipeline: { global: [node('deny', 'deny')] },
    })
    expect(() => checkPipelineScopes(config, () => undefined)).toThrow(/bot "bot-b": a deny node has no rule to match/)
  })

  test('names no bot when no adapter could bind the rule', () => {
    const config = parsed({ adapters: [], pipeline: { global: [node('allow', 'allow')] } })
    let message = ''
    try {
      checkPipelineScopes(config, () => undefined)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/an allow node has no rule to match/)
    expect(message).not.toMatch(/bot "/)
  })

  test('names no bot when the adapter has no botName to name', () => {
    const config = parsed({ adapters: [adapter({ botName: '' })], pipeline: { global: [node('deny', 'deny')] } })
    let message = ''
    try {
      checkPipelineScopes(config, () => undefined)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/a deny node has no rule to match/)
    expect(message).not.toMatch(/bot "/)
  })

  test('says nothing about enforcement when no layer is declared', () => {
    const said: string[] = []
    const config = { adapters: [], pipeline: { global: [] } } as unknown as Parameters<
      typeof checkPipelineScopes
    >[0]
    checkPipelineScopes(config, (message) => said.push(message))
    expect(said).toHaveLength(0)
  })
})

describe('the turn timings a profile declares', () => {
  test('an empty profile runs on the defaults', () => {
    const config = parsed({})
    expect(config.pipeline).toMatchObject({ maxTurnMs: 120_000, judgeTimeoutMs: 8_000 })
  })

  test('a profile may shorten the turn and the judge inside it', () => {
    const config = parsed({ pipeline: { maxTurnMs: 30_000, judgeTimeoutMs: 2_000 } })
    expect(() => checkPipelineSettings(config.pipeline)).not.toThrow()
    expect(config.pipeline.judgeTimeoutMs).toBe(2_000)
  })

  test('a judge timeout beyond the turn ceiling is refused', () => {
    expect(() => checkPipelineSettings({ maxTurnMs: 1_000, judgeTimeoutMs: 2_000 })).toThrow(
      /judgeTimeoutMs must not exceed maxTurnMs: 2000 > 1000/,
    )
  })

  test.each([0, -1, 1.5])('a timing of %s is refused', (value) => {
    expect(() => checkPipelineSettings({ maxTurnMs: value, judgeTimeoutMs: 1 })).toThrow(
      /maxTurnMs must be a whole number of milliseconds, at least 1/,
    )
  })

  test('a longer turn ceiling makes the default dedupe window too short', async () => {
    await expect(
      mount({ adapters: [adapter()], pipeline: { maxTurnMs: 400_000 } }),
    ).rejects.toThrow(/inflightTtlMs must exceed maxTurnMs: 300000 <= 400000/)
  })

  test('a longer dedupe window lets the longer turn through', async () => {
    const ctx = await mount({
      adapters: [adapter({ inflightTtlMs: 600_000 })],
      pipeline: { maxTurnMs: 400_000 },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })
})
