import { describe, expect, test } from 'vitest'
import { adapterFactory, knownAdapterKinds, registerAdapter } from '../src/adapter-registry.js'
import { createP2PAdapter, parseP2PConfig } from '../src/adapters/p2p/index.js'
import { ConfigError } from '../src/config.js'
import type { AdapterMount } from '../src/adapter-registry.js'
import type { ChannelAdapter } from '../src/contract.js'

function mount(transport: Record<string, unknown>): AdapterMount {
  return { kind: 'p2p', channel: 'p2p:a', instance: 'inst-a', botName: 'bot-a', transport }
}

describe('the adapter registry', () => {
  test('a registered kind resolves to its factory and the list names it', () => {
    expect(knownAdapterKinds()).toContain('p2p')
    expect(adapterFactory('p2p')).toBe(createP2PAdapter)
  })

  test('an unknown kind names what is registered', () => {
    expect(() => adapterFactory('nope')).toThrow(ConfigError)
    expect(() => adapterFactory('nope')).toThrow(/no adapter serves kind "nope".*known: p2p/)
  })

  test('a factory is replaceable under the same kind', () => {
    const fake = (): ChannelAdapter => ({}) as ChannelAdapter
    registerAdapter('probe', fake)
    expect(adapterFactory('probe')).toBe(fake)
  })
})

describe('the p2p transport block', () => {
  test('reads peers, listen, dedupe and the windows', () => {
    const parsed = parseP2PConfig(
      mount({
        peers: [{ instance: 'inst-b', secret: '{{SECRET_a}}', url: 'http://127.0.0.1:1', botName: 'bot-b' }],
        listen: { host: '127.0.0.1', port: 7123 },
        dedupe: { ttlMs: 1000, limit: 10 },
        inflightTtlMs: 300_000,
        sentAtWindowMs: 60_000,
        maxBodyBytes: 1024,
        waitMs: 5,
      }),
    )
    expect(parsed).toMatchObject({
      channel: 'p2p:a',
      instance: 'inst-a',
      botName: 'bot-a',
      listen: { host: '127.0.0.1', port: 7123 },
      dedupe: { ttlMs: 1000, limit: 10 },
      inflightTtlMs: 300_000,
      sentAtWindowMs: 60_000,
    })
    expect(parsed.peers[0]).toMatchObject({ instance: 'inst-b', botName: 'bot-b' })
  })

  test('refuses a field it never reads', () => {
    expect(() => parseP2PConfig(mount({ peers: [{ instance: 'b', secret: 's' }], bogus: 1 }))).toThrow(
      /p2p names a field this adapter does not read: bogus/,
    )
  })

  test('refuses an empty peer list and a malformed peer', () => {
    expect(() => parseP2PConfig(mount({ peers: [] }))).toThrow(/at least one peer/)
    expect(() => parseP2PConfig(mount({ peers: [{ instance: 'b' }] }))).toThrow(/secret/)
    expect(() => parseP2PConfig(mount({ peers: [{ instance: '', secret: 's' }] }))).toThrow(/instance/)
  })

  test('refuses a port that is not a whole number', () => {
    expect(() =>
      parseP2PConfig(mount({ peers: [{ instance: 'b', secret: 's' }], listen: { port: -1 } })),
    ).toThrow(/listen.port/)
  })
})
