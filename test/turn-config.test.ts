import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_turn}}'

async function mount(turn: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', staticCredentials({ [REF]: 'shared-value' }))
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => Promise.resolve({ accepted: true }),
      })
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    adapters: [
      {
        channel: 'inst-a',
        botName: 'bot-a',
        transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
      },
    ],
    turn,
  })
  return ctx
}

describe('the turn block a profile may declare', () => {
  test('mounts with no block at all, keeping the one message per turn default', async () => {
    const ctx = new Context()
    await ctx.plugin(registryPlugin)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', staticCredentials({ [REF]: 'shared-value' }))
        scope.provide('sessionController')
        scope.set('sessionController', {
          create: () => Promise.resolve({ sessionId: 'session-1' }),
          prompt: () => Promise.resolve({ accepted: true }),
        })
      },
    })
    await expect(
      ctx.plugin(entry, {
        adapters: [
          {
            channel: 'inst-a',
            botName: 'bot-a',
            transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
          },
        ],
      }),
    ).resolves.toBeDefined()
  })

  test('accepts a window and the two caps', async () => {
    await expect(mount({ coalesceMs: 1200, maxBatch: 5, maxChars: 2000 })).resolves.toBeDefined()
  })

  test('accepts the context bounds themselves', async () => {
    await expect(mount({ context: { messages: 0, chars: 100 } })).resolves.toBeDefined()
    await expect(mount({ context: { messages: 50, chars: 20000 } })).resolves.toBeDefined()
  })

  test.each([
    ['a negative window', { coalesceMs: -1 }, /turn\.coalesceMs/],
    ['a fractional window', { coalesceMs: 1.5 }, /turn\.coalesceMs/],
    ['a batch of zero', { maxBatch: 0 }, /turn\.maxBatch/],
    ['a batch above the bound', { maxBatch: 51 }, /turn\.maxBatch/],
    ['too few characters', { maxChars: 50 }, /turn\.maxChars/],
    ['a context ring above the bound', { context: { messages: 51 } }, /turn\.context\.messages/],
    ['a context ring that is not whole', { context: { messages: 1.5 } }, /turn\.context\.messages/],
    ['a context budget below the floor', { context: { chars: 99 } }, /turn\.context\.chars/],
    ['a context budget above the ceiling', { context: { chars: 20001 } }, /turn\.context\.chars/],
    ['a clock the profile cannot set', { now: 1 }, /unknown config fields: now/],
  ])('refuses %s at mount', async (_label, turn, pattern) => {
    await expect(mount(turn)).rejects.toThrow(pattern)
  })
})
