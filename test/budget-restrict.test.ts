import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { Config, checkPipelineScopes } from '../src/plugin.js'
import type { ChannelConfig } from '../src/plugin.js'
import { validateConfig } from '../src/config.js'
import { SessionPipelines } from '../src/session-pipeline.js'
import { budgetVerdictOf } from '../src/build-pipeline.js'
import { BudgetLedger, DEFAULT_BUDGET } from '../src/budget-ledger.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = 'budget-ref'
const credentials = staticCredentials({ [REF]: 'shared-value' })

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
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', sessionStub)
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, config)
  return ctx
}

const adapter = (overrides: Record<string, unknown> = {}) => ({
  channel: 'inst-a',
  botName: 'bot-a',
  transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
  ...overrides,
})

const parsed = (config: unknown): ChannelConfig => (Config as (value: unknown) => ChannelConfig)(config)

const budget = (overrides: Record<string, unknown> = {}) => ({ id: 'b', type: 'budget', ...overrides })

const allow = { id: 'a', type: 'allow' }

const policyWith = (block: Record<string, unknown>) => ({
  allow: { peers: ['inst-b'] },
  budget: block,
})

describe('the budget node needs a policy to read', () => {
  test('a declared budget node without policy.budget fails the mount', async () => {
    await expect(
      mount({
        adapters: [adapter({ policy: { allow: { peers: ['inst-b'] } } })],
        pipeline: { global: [budget(), allow] },
      }),
    ).rejects.toThrow(/a budget node needs policy\.budget/)
  })

  test('a budget node with a budget policy mounts', async () => {
    const ctx = await mount({
      adapters: [adapter({ policy: policyWith({ capacity: 100 }) })],
      pipeline: { global: [budget(), allow] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('restrictAt must sit above zero and below hardLimit', async () => {
    for (const restrictAt of [0, -0.1, 1, 1.5, Number.NaN]) {
      await expect(
        mount({
          adapters: [adapter({ policy: policyWith({ capacity: 100, restrictAt }) })],
          pipeline: { global: [budget({ mayRestrict: true, restrictSkip: ['judge'] }), allow] },
        }),
      ).rejects.toThrow(/restrictAt/)
    }
  })

  test('restrictAt must stay below a lower hardLimit', async () => {
    await expect(
      mount({
        adapters: [adapter({ policy: policyWith({ capacity: 100, hardLimit: 0.9, restrictAt: 0.9 }) })],
        pipeline: { global: [budget({ mayRestrict: true, restrictSkip: ['judge'] }), allow] },
      }),
    ).rejects.toThrow(/restrictAt/)
  })

  test('a restrictAt below the default hardLimit mounts', async () => {
    const ctx = await mount({
      adapters: [adapter({ policy: policyWith({ capacity: 100, restrictAt: 0.8 }) })],
      pipeline: { global: [budget({ mayRestrict: true, restrictSkip: ['judge'] }), allow] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })
})

describe('the restrict fields of a budget node', () => {
  test('mayRestrict needs a threshold', async () => {
    await expect(
      mount({
        adapters: [adapter({ policy: policyWith({ capacity: 100 }) })],
        pipeline: { global: [budget({ mayRestrict: true, restrictSkip: ['judge'] }), allow] },
      }),
    ).rejects.toThrow(/mayRestrict needs policy\.budget\.restrictAt/)
  })

  test('mayRestrict needs a non-empty restrictSkip', async () => {
    await expect(
      mount({
        adapters: [adapter({ policy: policyWith({ capacity: 100, restrictAt: 0.8 }) })],
        pipeline: { global: [budget({ mayRestrict: true, restrictSkip: [] }), allow] },
      }),
    ).rejects.toThrow(/mayRestrict needs a non-empty restrictSkip/)
  })

  test('restrictSkip without mayRestrict is a dead field', async () => {
    await expect(
      mount({
        adapters: [adapter({ policy: policyWith({ capacity: 100, restrictAt: 0.8 }) })],
        pipeline: { global: [budget({ restrictSkip: ['judge'] }), allow] },
      }),
    ).rejects.toThrow(/restrictSkip has no effect without mayRestrict/)
  })

  test('a warning names a judge that runs before the budget', () => {
    const config = parsed({
      adapters: [adapter({ policy: policyWith({ capacity: 100, restrictAt: 0.8 }) })],
      pipeline: { global: [{ id: 'j', type: 'judge' }, budget({ mayRestrict: true, restrictSkip: ['judge'] }), allow] },
    })
    const said: string[] = []
    checkPipelineScopes(config, (message) => said.push(message))
    expect(said.some((line) => line.includes('judge runs before budget'))).toBe(true)
  })
})

describe('a layer that inserts a budget node', () => {
  test('an adapter insert may carry the restrict fields', () => {
    const config = validateConfig<ChannelConfig>(Config, {
      adapters: [
        adapter({
          policy: policyWith({ capacity: 100, restrictAt: 0.8 }),
          pipeline: { insert: [{ id: 'b', type: 'budget', after: 'a', mayRestrict: true, restrictSkip: ['judge'] }] },
        }),
      ],
      pipeline: { global: [allow] },
    })
    expect(config.adapters[0]?.pipeline?.insert?.[0]).toMatchObject({
      mayRestrict: true,
      restrictSkip: ['judge'],
    })
  })

  test('an adapter insert that carries the restrict fields mounts', async () => {
    const ctx = await mount({
      adapters: [
        adapter({
          policy: policyWith({ capacity: 100, restrictAt: 0.8 }),
          pipeline: { insert: [{ id: 'b', type: 'budget', after: 'a', mayRestrict: true, restrictSkip: ['judge'] }] },
        }),
      ],
      pipeline: { global: [allow] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('a session insert cannot carry them, but a session override can', () => {
    const bots = new Map([
      [
        'orca',
        {
          base: [allow, budget({ mayRestrict: false })] as never,
          denyRules: true,
          allowRules: true,
          prepare: false,
          peers: ['seal'],
        },
      ],
    ])
    const sessions = new SessionPipelines({ bots })
    expect(() =>
      sessions.forSession('orca', 'peer:u1', {
        insert: [{ id: 'b2', type: 'budget', after: 'a', mayRestrict: true } as never],
      }),
    ).toThrow(/no insert has/)
    sessions.forSession('orca', 'peer:u1', { override: { b: { mayRestrict: true, restrictSkip: ['judge'] } } })
    expect(sessions.pipelineFor('orca', 'peer:u1').find((node) => node.id === 'b')?.mayRestrict).toBe(true)
  })
})

describe('the verdict a budget node reads', () => {
  test('the ratio is the busiest window share of capacity', () => {
    const ledger = new BudgetLedger({ capacity: 100, hardLimit: 1 }, DEFAULT_BUDGET)
    ledger.setUsage({ global: 10, 'bot:bot-a': 25, 'p2p:peer-a': 40 })
    const verdict = budgetVerdictOf(ledger, 'bot-a', 'p2p:peer-a', 0.8)
    expect(verdict.ratio).toBe(0.4)
    expect(verdict.state).toBe('normal')
    expect(verdict.restrictAt).toBe(0.8)
  })

  test('without a threshold the verdict carries none', () => {
    const ledger = new BudgetLedger({ capacity: 100, hardLimit: 1 }, DEFAULT_BUDGET)
    expect(budgetVerdictOf(ledger, 'bot-a', 'p2p:peer-a').restrictAt).toBeUndefined()
  })
})
