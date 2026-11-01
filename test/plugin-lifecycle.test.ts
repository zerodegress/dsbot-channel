import { describe, expect, test } from 'vitest'
import { createServer, request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../src/index.js'
import { DEFAULT_PORT } from '../src/index.js'
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

const adapter = (overrides: Record<string, unknown> = {}) => {
  const { peers, listen, dedupe, inflightTtlMs, sentAtWindowMs, maxBodyBytes, waitMs, ...rest } = overrides
  return {
    channel: 'p2p:self',
    instance: 'inst-a',
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
    await expect(ctx.plugin(entry.default, config({ listen: { host: '0.0.0.0', port: 0 } }))).rejects.toThrow(
      ConfigError,
    )
  })

  test('refuses to mount without a peer secret', async () => {
    const ctx = await contextWithCredentials()
    await expect(ctx.plugin(entry.default, config({ peers: [] }))).rejects.toThrow(/at least one peer/)
  })

  test('refuses an inflight ttl that does not exceed the turn ceiling', async () => {
    const ctx = await contextWithCredentials()
    await expect(ctx.plugin(entry.default, config({ inflightTtlMs: 5000 }))).rejects.toThrow(ConfigError)
    await expect(ctx.plugin(entry.default, config({ inflightTtlMs: 120_000 }))).rejects.toThrow(/must exceed/)
    await expect(ctx.plugin(entry.default, config({ sentAtWindowMs: 0 }))).rejects.toThrow(/sentAtWindowMs/)
    await expect(ctx.plugin(entry.default, config({ sentAtWindowMs: 1.5 }))).rejects.toThrow(/sentAtWindowMs/)
  })

  test('does not silently rewrite the configured inflight ttl', async () => {
    const ctx = await contextWithCredentials()
    const fork = await ctx.plugin(entry.default, config({ inflightTtlMs: 120_001 }))
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })

  test('declares the services it needs so the host can wait for them', () => {
    expect(entry.inject).toEqual(['credentials', 'sessionController'])
  })

  test('starts idle when no adapter is declared', async () => {
    const ctx = await contextWithCredentials()
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
    await expect(ctx.plugin(entry.default, cfg)).rejects.toThrow(/duplicate adapter channel/)
  })
})

describe('running peer messages', () => {
  test('activates once both services appear', async () => {
    const ctx = new Context()
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
    const fork = await ctx.plugin(entry.default, config())
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(1)
    await fork.dispose()
  })
})

describe('the shipped empty base', () => {
  test('binds no port when the adapter list is empty', async () => {
    const ctx = await contextWithCredentials()
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
