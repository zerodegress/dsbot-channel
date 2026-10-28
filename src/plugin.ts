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

export interface ChannelConfig extends ListenerConfig {
  dedupe?: { ttlMs?: number; limit?: number }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export const Config: any = Schema.object({
  botName: Schema.string().required(),
  peers: Schema
    .array(
      Schema.object({
        instance: Schema.string().required(),
        secret: Schema.string().required(),
      }),
    )
    .required(),
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
})
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Validates config and binds the peer listener for the life of the fiber. */
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const config = validateConfig<ChannelConfig>(Config, raw)
  assertBindHost(config.listen.host ?? DEFAULT_HOST, ['listen', 'host'])
  const credentials = ctx.get('credentials') as CredentialsLike | undefined
  if (!credentials?.resolve) throw new ConfigError('the credentials service is required to resolve peer secrets', [
    'peers',
  ])
  if (config.peers.length === 0) throw new Error('p2p: at least one peer secret is required to start')
  await assertPeersResolvable(config.peers, credentials)
  if (config.inflightTtlMs <= MAX_TURN_MS) {
    throw new ConfigError(
      `inflightTtlMs must exceed maxTurnMs: ${config.inflightTtlMs} <= ${MAX_TURN_MS}`,
      ['inflightTtlMs'],
    )
  }
  const table = new DedupeTable({
    ttlMs: config.dedupe?.ttlMs ?? 7 * 24 * 60 * 60 * 1000,
    limit: config.dedupe?.limit ?? 100_000,
    inflightTtlMs: config.inflightTtlMs,
    maxTurnMs: MAX_TURN_MS,
  })
  const listener = await startListener({ config: { ...config, credentials }, table })
  ctx.provide('dsbot-channel.peer')
  ctx.set('dsbot-channel.peer', listener)
  ctx.effect(() => async () => {
    ctx.set('dsbot-channel.peer', undefined)
    await listener.close()
  }, 'dsbot-channel: peer listener')
}
