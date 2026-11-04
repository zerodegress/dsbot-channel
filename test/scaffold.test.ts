import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { Context, type Plugin } from '@deepseek-ai/cordis'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import * as entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'

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
    await ctx.plugin(registryPlugin)
    const plugin: Plugin = entry.default
    const fork = ctx.plugin(plugin, {
      adapters: [
        {
channel: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: 'PEER_SHARED_SECRET' }],
  listen: { host: '127.0.0.1', port: 0 }
}
},
      ],
    })
    await fork
    expect(ctx.registry.has(plugin)).toBe(true)
    await fork.dispose()
    expect(ctx.registry.has(plugin)).toBe(false)
  })
})

describe('the changelog lists', () => {
  test('no blank line splits one section into two lists', () => {
    const lines = readFileSync(join(import.meta.dirname, '..', 'CHANGELOG.md'), 'utf8').split('\n')
    const split = lines.flatMap((line, index) => {
      if (line.trim() !== '') return []
      const before = lines[index - 1] ?? ''
      const after = lines[index + 1] ?? ''
      return before.startsWith('- ') && after.startsWith('- ') ? [`line ${index + 1}`] : []
    })
    expect(split).toEqual([])
  })
})

describe('the readme tables', () => {
  const separator = /^\|(?:\s*:?-{3,}:?\s*\|)+$/
  const readmes = ['README.md', 'README_ZH.md']

  for (const name of readmes) {
    test(`${name} opens every table block with a header and a separator`, () => {
      const lines = readFileSync(join(import.meta.dirname, '..', name), 'utf8').split('\n')
      const broken: string[] = []
      let fenced = false
      let run: number[] = []
      const check = (): void => {
        if (run.length === 0) return
        const second = run[1]
        if (second === undefined || !separator.test(lines[second] ?? '')) broken.push(`line ${(run[0] ?? 0) + 1}`)
        run = []
      }
      lines.forEach((line, index) => {
        if (line.trimStart().startsWith('```')) {
          check()
          fenced = !fenced
          return
        }
        if (!fenced && line.startsWith('|')) {
          run.push(index)
          return
        }
        check()
      })
      check()
      expect(broken).toEqual([])
    })
  }
})
