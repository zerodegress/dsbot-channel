import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import entry, { plugin as gatewayPlugin } from '../src/index.js'
import { REGISTRY_SERVICE, defineAdapterPlugin } from '../src/adapter-registry.js'
import type { AdapterRegistry } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterStatus } from '../src/adapter-status.js'
import type { ChannelAdapter, SendResult } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_registry}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

class StubAdapter implements ChannelAdapter {
  readonly kind = 'x-a'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: false,
    mention: false,
    reply: true,
    stream: false,
  }

  checkConfig(): void {}
  checkSessionKey(): string | undefined {
    return undefined
  }
  checkTarget(): string | undefined {
    return undefined
  }
  describeTargets(): string {
    return 'room-1'
  }
  status(): AdapterStatus {
    return buildStatus({
      channel: 'x:a',
      account: 'inst-a',
      bot: 'bot-a',
      health: buildListenerHealth({ listenState: 'stopped', boundPort: null, lastAuthenticatedAt: null, queueDepth: 0 }),
      counters: {
        authFailures: 0,
        unknownPaths: 0,
        underruns: 0,
        protocolMismatches: 0,
        sendFailures: {},
        lastFailure: null,
      },
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: 1,
      queueDepth: 0,
    })
  }
  async send(): Promise<SendResult> {
    return { ok: true, messageId: 'm-1', duplicate: false }
  }
  async start(): Promise<{ stop: () => Promise<void> }> {
    return { stop: () => Promise.resolve() }
  }
}

const adapterPlugin = defineAdapterPlugin({ kind: 'x-a', create: () => new StubAdapter() })

const profile = {
  adapters: [{ kind: 'x-a', channel: 'x:a', instance: 'inst-a', botName: 'bot-a', transport: {} }],
}

async function services(ctx: Context): Promise<void> {
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
}

describe('the registry a context owns', () => {
  test('the registry plugin registers the two built-in kinds', async () => {
    const ctx = new Context()
    await ctx.plugin(registryPlugin)
    const registry = ctx.get(REGISTRY_SERVICE) as AdapterRegistry
    expect(registry.known().sort()).toEqual(['onebot', 'p2p'])
    expect(typeof registry.factory('p2p')).toBe('function')
  })

  test('a third-party kind keeps its own namespace and registers once', async () => {
    const ctx = new Context()
    await ctx.plugin(registryPlugin)
    const registry = ctx.get(REGISTRY_SERVICE) as AdapterRegistry
    const fake = (() => new StubAdapter()) as never
    registry.register('x-probe', fake)
    expect(registry.has('x-probe')).toBe(true)
    expect(() => registry.register('p2p', fake)).toThrow(/reserved for the built-in transport/)
    expect(() => registry.register('probe', fake)).toThrow(/match x-\[a-z0-9-\]+/)
    expect(() => registry.register('x-Bad', fake)).toThrow(/match x-\[a-z0-9-\]+/)
    expect(() => registry.register(`x-${'a'.repeat(40)}`, fake)).toThrow(/at most 32/)
    expect(() => registry.register('x-probe', fake)).toThrow(/already registered/)
  })

  test('a second registry in one context is reported, not silently dropped', async () => {
    const ctx = new Context()
    const said: string[] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message: { args: unknown[] }) {
        said.push(message.args.map((arg) => String(arg)).join(' '))
      },
    })
    await ctx.plugin(registryPlugin)
    await ctx.plugin(registryPlugin)
    expect(said.some((line) => line.includes('already exists'))).toBe(true)
    expect((ctx.get(REGISTRY_SERVICE) as AdapterRegistry).known().sort()).toEqual(['onebot', 'p2p'])
  })

  test('two contexts never see each other', async () => {
    const one = new Context()
    const other = new Context()
    await one.plugin(registryPlugin)
    await other.plugin(registryPlugin)
    const first = one.get(REGISTRY_SERVICE) as AdapterRegistry
    const second = other.get(REGISTRY_SERVICE) as AdapterRegistry
    first.register('x-a', () => new StubAdapter())
    expect(first.has('x-a')).toBe(true)
    expect(second.has('x-a')).toBe(false)
    expect(second.known()).not.toContain('x-a')
  })
})

describe('the order a profile mounts three plugins in', () => {
  test('a registry, then the adapter, then the gateway mounts and listens', async () => {
    const ctx = new Context()
    await services(ctx)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(adapterPlugin)
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry, profile)
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })

  test('a missing registry plugin is refused, naming the plugin to mount', async () => {
    const ctx = new Context()
    await services(ctx)
    await expect(ctx.plugin(entry, profile)).rejects.toThrow(/no adapter registry.*dsbot-channel\/registry/)
  })

  test('an adapter mounted after the gateway is the other error, with the kinds it saw', async () => {
    const ctx = new Context()
    await services(ctx)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry, profile)).rejects.toThrow(/no adapter serves kind "x-a".*known: p2p, onebot/)
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry, profile)).rejects.toThrow(/between "dsbot-channel\/registry" and "dsbot-channel"/)
  })
})

describe('what must not come back', () => {
  test('the gateway does not inject the registry it only reads', () => {
    expect(gatewayPlugin.inject).not.toContain(REGISTRY_SERVICE)
    expect(gatewayPlugin.inject).toContain('credentials')
  })

  test('no module holds a registry of its own, and no adapter registers itself', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((found) => {
        const path = join(dir, found.name)
        return found.isDirectory() ? files(path) : found.name.endsWith('.ts') ? [path] : []
      })
    const all = files(root)
    expect(all.filter((path) => /^const \w+ = new Map</m.test(readFileSync(path, 'utf8')))).toEqual([])
    expect(all.filter((path) => readFileSync(path, 'utf8').includes('registerBuiltinAdapter'))).toEqual([])
  })
})
