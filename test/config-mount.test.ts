import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigError, validateConfig } from '../src/index.js'

const schema = Schema.object({ channels: Schema.array(Schema.string()).default([]) })

const plugin = {
  name: 'probe',
  Config: schema,
  apply(_ctx: unknown, config: unknown) {
    validateConfig(schema, config)
  },
}

describe('mounting with a config schema', () => {
  test('rejects an unknown field at mount time', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(plugin, { channels: ['a'], bogus: 1 })).rejects.toThrow(ConfigError)
  })

  test('mounts a clean config', async () => {
    const ctx = new Context()
    const fork = await ctx.plugin(plugin, { channels: ['a'] })
    expect(ctx.registry.has(plugin)).toBe(true)
    await fork.dispose()
    expect(ctx.registry.has(plugin)).toBe(false)
  })
})
