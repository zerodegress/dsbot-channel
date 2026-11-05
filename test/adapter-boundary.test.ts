import { describe, expect, test } from 'vitest'
import { registryPlugin } from '../src/registry-plugin.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = 'p2p-secret-boundary'
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
  await ctx.plugin(registryPlugin)
  await ctx.plugin(registryPlugin)
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
            channel: 'inst-a',
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
            channel: 'inst-a',
            botName: 'bot-a',
            transport: { peers: [{ instance: 'inst-b', secret: REF }], bogus: true },
          },
        ],
      }),
    ).rejects.toThrow(/transport names a field this adapter does not read: bogus/)
  })
})

describe('the mention switch a profile sets', () => {
  test('a transport that cannot tell mentions apart cannot require them', async () => {
    await expect(
      mount({
        adapters: [
          {
            channel: 'inst-a',
            botName: 'bot-a',
            policy: { requireMention: true },
            transport: { peers: [{ instance: 'inst-b', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
          },
        ],
      }),
    ).rejects.toThrow(/policy\.requireMention needs a transport that can tell mentions apart/)
  })
})

describe('the core does not reach into a transport', () => {
  test('no file outside src/adapters and the composition root names the adapter directory', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const offenders = sources(root)
      .filter(
        (path) =>
          !path.includes(`${join('src', 'adapters')}`) &&
          !path.endsWith(join('src', 'index.ts')) &&
          !path.endsWith(join('src', 'registry-plugin.ts')),
      )
      .filter((path) => readFileSync(path, 'utf8').includes('adapters/'))
    expect(offenders).toEqual([])
  })
})

describe('the transport block an old profile names', () => {
  test('the old p2p key is refused and the error points at transport', async () => {
    await expect(
      mount({
        adapters: [
          {
            channel: 'inst-a',
            botName: 'bot-a',
            p2p: { peers: [{ instance: 'inst-b', secret: REF }] },
          },
        ],
      }),
    ).rejects.toThrow(/unknown config fields: p2p.*transport block is now named "transport"/)
  })
})

describe('the package surface', () => {
  test('does not publish the p2p internals', async () => {
    const entry = await import('../src/index.js')
    const internals = [
      'signEnvelope',
      'canonicalEnvelope',
      'verifyRequest',
      'DedupeTable',
      'toP2PEvent',
      'MAX_BODY_BYTES',
      'P2P_ROUTE',
      'handleMessage',
      'parseRequest',
      'DEFAULT_HOST',
      'DEFAULT_PORT',
      'SIGNATURE_HEADER',
      'checkListenerConfig',
      'startListener',
      'SecretRefError',
      'assertPeersResolvable',
      'resolvePeers',
      'staticCredentials',
      'DEFAULT_SEND_TIMEOUT_MS',
      'sendToPeer',
      'STATUS_ROUTE',
      'hasForwardingHeaders',
      'isLoopbackPeer',
      'registerBuiltinAdapter',
      'ChannelStats',
      'ChannelSnapshot',
    ]
    for (const name of internals) expect(name in entry).toBe(false)
  })

  test('still publishes what a host mounts the plugin with', async () => {
    const entry = await import('../src/index.js')
    for (const name of ['apply', 'plugin', 'Config', 'defineAdapterPlugin', 'registryPlugin', 'buildEvent', 'Pipeline', 'buildStatus']) {
      expect(name in entry).toBe(true)
    }
  })
})

describe('the observation services', () => {
  test('are only wired into the services a host reads, never into a decision path', () => {
    const plugin = readFileSync(join(import.meta.dirname, '..', 'src', 'plugin.ts'), 'utf8')
    const lines = plugin.split('\n')
    const reads = lines
      .map((line, index) => ({ line, index: index + 1 }))
      .filter(({ line }) => line.includes('usageSnapshot(') || line.includes('turns.snapshot()'))
    expect(reads).toHaveLength(2)
    for (const one of reads) expect(one.line).toContain("ctx.set('dsbot-channel.")
  })
})

describe('the round key has one spelling', () => {
  test('only the gate builds a bot|session key', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const offenders = sources(root)
      .filter((path) => !path.endsWith(join('src', 'inbound-gate.ts')))
      .filter((path) => /`\$\{botId\}\|/.test(readFileSync(path, 'utf8')))
    expect(offenders).toEqual([])
  })
})
