import { describe, expect, test } from 'vitest'
import { registryPlugin } from '../src/registry-plugin.js'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../src/index.js'
import { DEFAULT_PORT } from '../src/adapters/p2p/p2p-listener.js'
import { ConfigError } from '../src/config.js'
import { P2P_ROUTE } from '../src/adapters/p2p/p2p-protocol.js'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Listener } from '../src/adapters/p2p/p2p-listener.js'

const secret = 'peer-secret-1'
const secretRef = 'PEER_SHARED_SECRET'

const credentialsProvider = {
  name: 'test-credentials',
  apply(ctx: Context) {
    ctx.provide('credentials')
    ctx.set('credentials', {
      resolve: async (reference: string) => (reference === secretRef ? { value: secret, source: 'test' } : undefined),
    })
  },
}

const sessionStub = {
  create: () => Promise.resolve({ sessionId: 'session-1' }),
  prompt: () => Promise.resolve({ accepted: true }),
}

async function contextWithCredentials(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(credentialsProvider)
  await ctx.plugin({
    name: 'stub-sessions',
    apply(c: Context) {
      c.provide('sessionController')
      c.set('sessionController', sessionStub)
    },
  })
  return ctx
}

async function contextWithSessions(
  controller: {
    create: () => Promise<{ sessionId: string }>
    prompt: (request: unknown, signal: AbortSignal) => Promise<unknown>
  },
  persistence?: { flush: () => Promise<void> },
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(credentialsProvider)
  await ctx.plugin({
    name: 'stub-sessions',
    apply(c: Context) {
      c.provide('sessionController')
      c.set('sessionController', controller)
      if (persistence === undefined) return
      c.provide('sessionPersistence')
      c.set('sessionPersistence', persistence)
    },
  })
  return ctx
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the turn to start')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const adapter = (overrides: Record<string, unknown> = {}) => {
  const { peers, listen, dedupe, inflightTtlMs, sentAtWindowMs, maxBodyBytes, waitMs, ...rest } = overrides
  return {
    channel: 'inst-a',
    botName: 'bot-a',
    transport: {
      peers: peers ?? [{ instance: 'inst-b', secret: secretRef }],
      listen: listen ?? { host: '127.0.0.1', port: 0 },
      ...(dedupe === undefined ? {} : { dedupe }),
      ...(inflightTtlMs === undefined ? {} : { inflightTtlMs }),
      ...(sentAtWindowMs === undefined ? {} : { sentAtWindowMs }),
      ...(maxBodyBytes === undefined ? {} : { maxBodyBytes }),
      ...(waitMs === undefined ? {} : { waitMs }),
    },
    ...rest,
  }
}

const config = (overrides: Record<string, unknown> = {}) => ({ adapters: [adapter(overrides)] })

const message = {
  eventId: 'evt-1',  chainId: 'evt-1',
  to: 'bot-a',
  sender: 'bot-b',
  instance: 'inst-b',
  body: 'hello',
  sentAt: Date.now(),
}

function post(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const text = JSON.stringify(body)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path: P2P_ROUTE,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
          'x-p2p-signature': signEnvelope(secret, body as unknown as Envelope),
        },
      },
      (response) => resolve(response.statusCode ?? 0),
    )
    req.on('error', reject)
    req.end(text)
  })
}

describe('plugin lifecycle', () => {
  test('serves requests while mounted and releases the port on dispose', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config())
    const listeners = ctx.get('dsbot-channel.peers') as Listener[]
  const listener = listeners[0]!
    const port = listener.address().port
    expect(await post(port, message)).toBe(200)
    await fork.dispose()
    await expect(post(port, message)).rejects.toThrow()
  })

  test('refuses to mount with a wildcard bind address', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ listen: { host: '0.0.0.0', port: 0 } }))).rejects.toThrow(
      ConfigError,
    )
  })

  test('refuses an adapter that still writes instance', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ instance: 'self' }))).rejects.toThrow(
      /"instance" was merged into "channel"/,
    )
  })

  test('refuses an invalid policy written at the top level, naming that path', async () => {
    for (const [policy, at] of [
      [{ groupBots: 'bogus' }, 'policy.groupBots'],
      [{ budget: { capacity: 10, hardLimit: 2 } }, 'policy.budget.hardLimit'],
      [{ relayLimit: 0 }, 'policy.relayLimit'],
    ] as const) {
      const ctx = await contextWithCredentials()
      await ctx.plugin(registryPlugin)
      await expect(ctx.plugin(entry.default, { policy, adapters: [adapter()] })).rejects.toThrow(
        new RegExp(`\\(at ${at.replace('.', '\\.')}\\)`),
      )
    }
  })

  test('refuses an invalid policy written on an adapter, naming that path', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ policy: { relayLimit: 0 } }))).rejects.toThrow(
      /at adapters\.0\.policy\.relayLimit/,
    )
  })

  test('mounts with the mapping form of peers', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, {
      ...config({ peers: { 'inst-b': secretRef } }),
      identity: { people: [{ id: 'alice', accounts: [{ kind: 'p2p', instance: 'inst-b', accountId: 'u1' }] }] },
    })
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })

  test('the mapping form and the list form report the same adapter', async () => {
    const read = async (peers: unknown): Promise<Record<string, unknown>> => {
      const ctx = await contextWithCredentials()
      await ctx.plugin(registryPlugin)
      const fork = await ctx.plugin(entry.default, config({ peers }))
      const status = ctx.get('dsbot-channel.status') as {
        snapshot(): { adapters: { sampledAt?: unknown; dedupe?: unknown; health?: Record<string, unknown> }[] }
      }
      const report = (status.snapshot().adapters[0] ?? {}) as Record<string, unknown>
      const stable: Record<string, unknown> = { ...report }
      delete stable.sampledAt
      delete stable.dedupe
      stable.health = { ...(report.health as Record<string, unknown> | undefined), boundPort: undefined }
      await fork.dispose()
      return stable
    }
    expect(await read({ 'inst-b': secretRef })).toEqual(await read([{ instance: 'inst-b', secret: secretRef }]))
  })

  test('refuses to mount without a peer secret', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ peers: [] }))).rejects.toThrow(/at least one peer/)
  })

  test('refuses an inflight ttl that does not exceed the turn ceiling', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ inflightTtlMs: 5000 }))).rejects.toThrow(ConfigError)
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ inflightTtlMs: 120_000 }))).rejects.toThrow(/must exceed/)
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ sentAtWindowMs: 0 }))).rejects.toThrow(/sentAtWindowMs/)
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, config({ sentAtWindowMs: 1.5 }))).rejects.toThrow(/sentAtWindowMs/)
  })

  test('does not silently rewrite the configured inflight ttl', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config({ inflightTtlMs: 120_001 }))
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })

  test('declares the services it needs so the host can wait for them', () => {
    expect(entry.inject).toEqual(['credentials', 'sessionController'])
  })

  test('starts idle when no adapter is declared', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, { adapters: [] })
    expect(ctx.get('dsbot-channel.peers')).toBeUndefined()
    await fork.dispose()
  })

  test('a later adapter that fails to start stops the ones already listening', async () => {
    const taken = createServer()
    await new Promise<void>((resolve) => taken.listen(0, '127.0.0.1', resolve))
    const takenPort = (taken.address() as AddressInfo).port
    const freePort = await new Promise<number>((resolve, reject) => {
      const probe = createServer()
      probe.once('error', reject)
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as AddressInfo).port
        probe.close(() => resolve(port))
      })
    })
    const ctx = await contextWithCredentials()
    const one = adapter({ channel: 'p2p:one', listen: { host: '127.0.0.1', port: freePort } })
    const two = adapter({ channel: 'p2p:two', botName: 'bot-b', listen: { host: '127.0.0.1', port: takenPort } })

    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, { adapters: [one, two] })).rejects.toThrow(/EADDRINUSE/)

    const rebound = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(false))
      probe.listen(freePort, '127.0.0.1', () => probe.close(() => resolve(true)))
    })
    expect(rebound).toBe(true)
    taken.close()
  })

  test('refuses a duplicate adapter channel', async () => {
    const ctx = await contextWithCredentials()
    const cfg = { adapters: [adapter(), adapter({ botName: 'bot-b' })] }
    await ctx.plugin(registryPlugin)
    await expect(ctx.plugin(entry.default, cfg)).rejects.toThrow(/duplicate adapter channel/)
  })
})

describe('unloading while a turn is in flight', () => {
  test('aborts the signal the controller was handed and starts no further prompt', async () => {
    const signals: AbortSignal[] = []
    const prompts: string[] = []
    const ctx = await contextWithSessions({
      create: () => Promise.resolve({ sessionId: 'session-1' }),
      prompt: (request, signal) => {
        prompts.push((request as { requestId: string }).requestId)
        signals.push(signal)
        return new Promise<never>(() => undefined)
      },
    })
    const warnings: string[] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message: { args: unknown[] }) {
        warnings.push(message.args.map((arg) => String(arg)).join(' '))
      },
    })
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config())
    const port = (ctx.get('dsbot-channel.peers') as Listener[])[0]!.address().port

    expect(await post(port, message)).toBe(200)
    await waitFor(() => signals.length === 1)

    await fork.dispose()

    expect(signals[0]?.aborted).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(prompts).toHaveLength(1)
    expect(warnings.filter((line) => line.includes('the peer sessions were disposed'))).toEqual([])
  })

  test('still warns about a turn that fails for its own reason', async () => {
    const ctx = await contextWithSessions({
      create: () => Promise.resolve({ sessionId: 'session-1' }),
      prompt: () => Promise.reject(new Error('the session could not run this turn')),
    })
    const warnings: string[] = []
    ctx.logger.exporter({
      levels: { default: 3 },
      export(message: { args: unknown[] }) {
        warnings.push(message.args.map((arg) => String(arg)).join(' '))
      },
    })
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config())
    const port = (ctx.get('dsbot-channel.peers') as Listener[])[0]!.address().port

    expect(await post(port, message)).toBe(200)
    await waitFor(() => warnings.some((line) => line.includes('peer turn for')))

    expect(warnings.some((line) => line.includes('the session could not run this turn'))).toBe(true)
    await fork.dispose()
  })
})

describe('unloading with a session log', () => {
  test('flushes once when the plugin unloads', async () => {
    let flushes = 0
    const ctx = await contextWithSessions(
      { create: () => Promise.resolve({ sessionId: 'session-1' }), prompt: () => new Promise<never>(() => undefined) },
      {
        flush: () => {
          flushes += 1
          return Promise.resolve()
        },
      },
    )
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config())
    expect(flushes).toBe(0)

    await fork.dispose()

    expect(flushes).toBe(1)
  })
})

describe('running peer messages', () => {
  test('activates once both services appear', async () => {
    const ctx = new Context()
    await ctx.plugin(registryPlugin)
    await ctx.plugin(registryPlugin)
    await ctx.plugin(entry.default, config())
    expect(ctx.get('dsbot-channel.peers')).toBeUndefined()

    await ctx.plugin(credentialsProvider)
    await ctx.plugin({
      name: 'stub-sessions',
      apply(c: Context) {
        c.provide('sessionController')
        c.set('sessionController', sessionStub)
      },
    })

    for (let attempt = 0; attempt < 100 && ctx.get('dsbot-channel.peers') === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
  })

  test('stays inactive while the session service is missing', async () => {
    const ctx = new Context()
    await ctx.plugin(credentialsProvider)
    let applies = 0
    const spied = {
      ...entry.default,
      apply: (...args: Parameters<typeof entry.apply>) => {
        applies += 1
        return entry.apply(...args)
      },
    }
    await ctx.plugin(spied, config())
    expect(applies).toBe(0)
    expect(ctx.get('dsbot-channel.peers')).toBeUndefined()
  })

  test('mounts adapters once the session service is present', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, config())
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })
})

describe('the shipped empty base', () => {
  test('binds no port when the adapter list is empty', async () => {
    const ctx = await contextWithCredentials()
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry.default, { adapters: [] })

    const taken = await new Promise<boolean>((resolve) => {
      const probe = createServer()
      probe.once('error', () => resolve(true))
      probe.listen(DEFAULT_PORT, '127.0.0.1', () => probe.close(() => resolve(false)))
    })

    expect(taken).toBe(false)
    await fork.dispose()
  })
})
