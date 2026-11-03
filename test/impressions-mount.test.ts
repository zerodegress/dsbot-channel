import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { defineAdapterPlugin } from '../src/adapter-registry.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../src/adapter-status.js'
import type { AdapterPorts, ChannelAdapter, SendInput } from '../src/contract.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { botDirectoryName, subjectFileName } from '../src/impressions.js'

const REF = '{{SECRET_impressions_mount}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

class StubAdapter implements ChannelAdapter {
  readonly kind = 'x-group'
  readonly guidance = { peer: 'peer guidance', group: 'group guidance' }
  readonly capabilities = {
    text: true,
    image: NO_MEDIA,
    file: NO_MEDIA,
    voice: NO_MEDIA,
    recall: false,
    history: { group: false, private: false },
    mention: true,
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
    return '12345'
  }
  status() {
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
  async send(input: SendInput) {
    void input
    return { ok: true as const, messageId: 'm-1', duplicate: false }
  }
  async start(inbound: AdapterPorts) {
    void inbound
    return { stop: () => Promise.resolve() }
  }
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-impressions-mount-'))
  roots.push(dir)
  return dir
}

async function mount(options: { impressions?: unknown; withTools?: boolean } = {}): Promise<string[]> {
  const registered: string[] = []
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
      if (options.withTools !== false) {
        scope.provide('tools')
        scope.set('tools', {
          register: (definition: { name?: string }) => {
            if (typeof definition.name === 'string') registered.push(definition.name)
            return () => undefined
          },
        })
      }
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(defineAdapterPlugin({ kind: 'x-group', create: () => new StubAdapter() }))
  await ctx.plugin(entry, {
    ...(options.impressions === undefined ? {} : { impressions: options.impressions }),
    adapters: [{ kind: 'x-group', channel: 'x:a', instance: 'inst-a', botName: 'bot-a', policy: {}, transport: {} }],
  })
  return registered
}

describe('mounting the impression store', () => {
  test('registers no impression tool when no directory is configured', async () => {
    const registered = await mount()
    expect(registered.filter((name) => name.startsWith('impression_'))).toEqual([])
  })

  test('registers the three tools when a directory is configured', async () => {
    const dir = await tempRoot()
    const registered = await mount({ impressions: { dir } })
    expect(registered).toEqual(expect.arrayContaining(['impression_put', 'impression_get', 'impression_forget']))
  })

  test('refuses a relative directory', async () => {
    await expect(mount({ impressions: { dir: 'notes' } })).rejects.toThrow(/absolute/)
  })

  test('refuses a directory that holds a damaged file, naming it', async () => {
    const dir = await tempRoot()
    const file = join(dir, botDirectoryName('bot-a'), 'person', `${subjectFileName('alice')}.json`)
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, '{not json', { mode: 0o600 })
    await expect(mount({ impressions: { dir } })).rejects.toThrow(file)
  })

  test('needs the tools service once impressions are on', async () => {
    const dir = await tempRoot()
    await expect(mount({ impressions: { dir }, withTools: false })).rejects.toThrow(/tools service/)
  })
})
