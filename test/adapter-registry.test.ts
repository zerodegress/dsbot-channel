import { describe, expect, test } from 'vitest'
import { adapterFactory, checkAdapterKind, knownAdapterKinds, registerAdapter } from '../src/adapter-registry.js'
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

  test('a mount-time kind is built-in or third-party shaped', () => {
    expect(() => checkAdapterKind('p2p')).not.toThrow()
    expect(() => checkAdapterKind('onebot')).not.toThrow()
    expect(() => checkAdapterKind('x-demo')).not.toThrow()
    expect(() => checkAdapterKind('demo')).toThrow(/built-in name or match x-/)
    expect(() => checkAdapterKind('qqbot')).toThrow(/built-in name or match x-/)
  })

  test('an unknown kind names what is registered', () => {
    expect(() => adapterFactory('nope')).toThrow(ConfigError)
    expect(() => adapterFactory('nope')).toThrow(/no adapter serves kind "nope".*known: p2p/)
  })

  test('a third-party kind registers under its own namespace', () => {
    const fake = (): ChannelAdapter => ({}) as ChannelAdapter
    registerAdapter('x-probe', fake)
    expect(adapterFactory('x-probe')).toBe(fake)
    expect(knownAdapterKinds()).toContain('x-probe')
  })

  test('a third-party kind cannot take a built-in name or an unnamed shape', () => {
    const fake = (): ChannelAdapter => ({}) as ChannelAdapter
    expect(() => registerAdapter('p2p', fake)).toThrow(/reserved for the built-in transport/)
    expect(() => registerAdapter('probe', fake)).toThrow(/match x-\[a-z0-9-\]+/)
    expect(() => registerAdapter('x-Bad', fake)).toThrow(/match x-\[a-z0-9-\]+/)
    expect(() => registerAdapter('x-', fake)).toThrow()
    expect(() => registerAdapter(`x-${'a'.repeat(40)}`, fake)).toThrow(/at most 32/)
  })

  test('the same kind cannot be registered twice', () => {
    const fake = (): ChannelAdapter => ({}) as ChannelAdapter
    registerAdapter('x-twice', fake)
    expect(() => registerAdapter('x-twice', fake)).toThrow(/already registered/)
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
      /transport names a field this adapter does not read: bogus/,
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

describe('one kind, one implementation, many adapters', () => {
  test('one factory serves several mounts of the same kind', () => {
    const factory = adapterFactory('p2p')
    const first = factory(
      { kind: 'p2p', channel: 'p2p:a', instance: 'inst-a', botName: 'bot-a', transport: { peers: [{ instance: 'inst-b', secret: 'x' }] } },
      { warn: () => undefined },
    )
    const second = factory(
      { kind: 'p2p', channel: 'p2p:b', instance: 'inst-b', botName: 'bot-b', transport: { peers: [{ instance: 'inst-a', secret: 'x' }] } },
      { warn: () => undefined },
    )
    expect(first.kind).toBe('p2p')
    expect(second.kind).toBe('p2p')
    expect(second).not.toBe(first)
  })
})
