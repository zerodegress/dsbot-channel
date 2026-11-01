import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_boundary}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

async function mount(raw: unknown): Promise<void> {
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
  await ctx.plugin(entry, raw)
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((found) => {
    const path = join(dir, found.name)
    if (found.isDirectory()) return sources(path)
    return found.name.endsWith('.ts') ? [path] : []
  })
}

describe('the transport block a profile declares', () => {
  test('a profile that still writes transport fields at the adapter is refused', async () => {
    await expect(
      mount({
        adapters: [
          {
            channel: 'p2p:a',
            instance: 'inst-a',
            botName: 'bot-a',
            peers: [{ instance: 'inst-b', secret: REF }],
            listen: { host: '127.0.0.1', port: 0 },
          },
        ],
      }),
    ).rejects.toThrow(/unknown config fields: peers/)
  })

  test('a transport field the adapter does not read is refused', async () => {
    await expect(
      mount({
        adapters: [
          {
            channel: 'p2p:a',
            instance: 'inst-a',
            botName: 'bot-a',
            p2p: { peers: [{ instance: 'inst-b', secret: REF }], bogus: true },
          },
        ],
      }),
    ).rejects.toThrow(/p2p names a field this adapter does not read: bogus/)
  })
})

describe('the core does not reach into a transport', () => {
  test('no file outside src/adapters and the composition root names the adapter directory', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const offenders = sources(root)
      .filter((path) => !path.includes(`${join('src', 'adapters')}`) && !path.endsWith(join('src', 'index.ts')))
      .filter((path) => readFileSync(path, 'utf8').includes('adapters/'))
    expect(offenders).toEqual([])
  })
})
