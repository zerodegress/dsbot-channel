import { describe, expect, test } from 'vitest'
import { Context, type Plugin } from 'cordis'
import * as entry from '../src/index.js'

describe('scaffold', () => {
  test('plugin exposes a name and an apply function', () => {
    expect(entry.name).toBe('dsbot-channel')
    expect(typeof entry.apply).toBe('function')
  })

  test('plugin applies to a cordis context and disposes cleanly', async () => {
    const ctx = new Context()
    const plugin: Plugin = entry.default
    const fork = ctx.plugin(plugin, {})
    await fork
    expect(ctx.registry.has(plugin)).toBe(true)
    await fork.dispose()
    expect(ctx.registry.has(plugin)).toBe(false)
  })
})
