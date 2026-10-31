import { describe, expect, test } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import * as entry from '../src/index.js'

const sessionStub = {
  create: () => Promise.resolve({ sessionId: 'session-1' }),
  prompt: () => Promise.resolve({ accepted: true }),
}

describe('scaffold', () => {
  test('plugin exposes a name and an apply function', () => {
    expect(entry.name).toBe('dsbot-channel')
    expect(typeof entry.apply).toBe('function')
  })

  test('plugin applies to a cordis context and disposes cleanly', async () => {
    const ctx = new Context()
    await ctx.plugin({
      name: 'scaffold-credentials',
      apply(c) {
        c.provide('credentials')
        c.set('credentials', staticCredentials({ PEER_SHARED_SECRET: 'scaffold-secret' }))
        c.provide('sessionController')
        c.set('sessionController', sessionStub)
      },
    })
    const plugin: Plugin = entry.default
    const fork = ctx.plugin(plugin, {
      adapters: [
        {
          channel: 'p2p:self',
          instance: 'inst-a',
          botName: 'bot-a',
          peers: [{ instance: 'inst-b', secret: 'PEER_SHARED_SECRET' }],
          listen: { host: '127.0.0.1', port: 0 },
        },
      ],
    })
    await fork
    expect(ctx.registry.has(plugin)).toBe(true)
    await fork.dispose()
    expect(ctx.registry.has(plugin)).toBe(false)
  })
})
