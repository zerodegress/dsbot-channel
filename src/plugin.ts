import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigError, assertBindHost, validateConfig } from './config.js'
import { DedupeTable } from './p2p-dedupe.js'
import { DEFAULT_HOST, DEFAULT_PORT, startListener } from './p2p-listener.js'
import type { ListenerConfig } from './p2p-listener.js'
import type { CredentialsLike } from './p2p-secrets.js'
import { assertPeersResolvable } from './p2p-secrets.js'

/** Turn ceiling a message may occupy before it is dropped. */
export const MAX_TURN_MS = 120_000

export interface AdapterConfig extends ListenerConfig {
  kind?: 'p2p'
  channel: string
  instance: string
  dedupe?: { ttlMs?: number; limit?: number }
}

export interface ChannelConfig {
  adapters: AdapterConfig[]
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const Config: any = Schema.object({
  adapters: Schema
    .array(
      Schema.object({
        kind: Schema.const('p2p').default('p2p'),
        channel: Schema.string().required(),
        instance: Schema.string().required(),
        botName: Schema.string().required(),
        peers: Schema.array(
          Schema.object({
            instance: Schema.string().required(),
            secret: Schema.string().required(),
            url: Schema.string(),
          }),
        ).default([]),
        inflightTtlMs: Schema.number().default(300_000),
        maxBodyBytes: Schema.number().default(64 * 1024),
        waitMs: Schema.number(),
        listen: Schema.object({
          host: Schema.string().default(DEFAULT_HOST),
          port: Schema.number().default(DEFAULT_PORT),
        }).default({}),
        dedupe: Schema.object({
          ttlMs: Schema.number().default(7 * 24 * 60 * 60 * 1000),
          limit: Schema.number().default(100_000),
        }).default({}),
      }),
    )
    .default([]),
})
/* eslint-enable @typescript-eslint/no-explicit-any */

function prepareAdapter(adapter: AdapterConfig, index: number): DedupeTable {
  const path = (field: string): string[] => ['adapters', String(index), field]
  assertBindHost(adapter.listen.host ?? DEFAULT_HOST, path('listen'))
  if (adapter.inflightTtlMs <= MAX_TURN_MS) {
    throw new ConfigError(
      `inflightTtlMs must exceed maxTurnMs: ${adapter.inflightTtlMs} <= ${MAX_TURN_MS}`,
      path('inflightTtlMs'),
    )
  }
  return new DedupeTable({
    ttlMs: adapter.dedupe?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    limit: adapter.dedupe?.limit ?? 100_000,
    inflightTtlMs: adapter.inflightTtlMs,
    maxTurnMs: MAX_TURN_MS,
  })
}

/** Starts only the adapters the profile declares; an empty list starts nothing. */
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = validateConfig<ChannelConfig>(Config, raw)
  if (config.adapters.length === 0) return
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (!credentials?.resolve) {
    throw new ConfigError('the credentials service is required to resolve peer secrets', ['adapters'])
  }
  const seen = new Set<string>()
  const pairs = config.adapters.map((adapter, index) => {
    if (!adapter.botName) throw new ConfigError('botName is required for each adapter', ['adapters', String(index)])
    if (seen.has(adapter.channel)) {
      throw new ConfigError(`duplicate adapter channel: ${adapter.channel}`, [
        'adapters',
        String(index),
        'channel',
      ])
    }
    seen.add(adapter.channel)
    return { adapter, index, table: prepareAdapter(adapter, index) }
  })
  for (const { adapter, index } of pairs) {
    if (adapter.peers.length === 0) {
      throw new ConfigError('at least one peer is required for each adapter', ['adapters', String(index), 'peers'])
    }
    await assertPeersResolvable(adapter.peers, credentials)
  }
  const started = await Promise.all(
    pairs.map(({ adapter, table }) => startListener({ config: { ...adapter, credentials }, table })),
  )
  ctx.provide('dsbot-channel.peers')
  ctx.set('dsbot-channel.peers', started)
  ctx.effect(() => async () => {
    ctx.set('dsbot-channel.peers', [])
    await Promise.all(started.map((listener) => listener.close()))
  }, 'dsbot-channel: peer listeners')
}
