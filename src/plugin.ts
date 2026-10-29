import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ConfigError, assertBindHost, validateConfig } from './config.js'
import { DedupeTable } from './p2p-dedupe.js'
import { DEFAULT_HOST, DEFAULT_PORT, startListener } from './p2p-listener.js'
import type { ListenerConfig } from './p2p-listener.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { assertPeersResolvable } from './p2p-secrets.js'
import { PeerSessions } from './p2p-inbound.js'
import type { InboundRequest, SessionControllerLike, SessionEventLike } from './p2p-inbound.js'
import { sendToPeer } from './p2p-send.js'
import type { PeerTarget } from './p2p-send.js'
import { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from './inbound-gate.js'
import { toP2PEvent } from './p2p-mapping.js'

declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/event': (session: { id: string }, event: SessionEventLike) => void
  }
}

/** Turn ceiling a message may occupy before it is dropped. */
export const MAX_TURN_MS = 120_000

export interface AdapterConfig extends ListenerConfig {
  kind?: 'p2p'
  channel: string
  instance: string
  relayLimit: number
  relayResetMs: number
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
        relayLimit: Schema.number().default(DEFAULT_LOOP_MAX_TURNS),
        relayResetMs: Schema.number().default(DEFAULT_LOOP_IDLE_RESET_MS),
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
  if (!Number.isInteger(adapter.relayLimit) || adapter.relayLimit < 1) {
    throw new ConfigError(
      `relayLimit must be a whole number of rounds, at least 1: ${adapter.relayLimit}`,
      path('relayLimit'),
    )
  }
  if (!Number.isInteger(adapter.relayResetMs) || adapter.relayResetMs < 1) {
    throw new ConfigError(
      `relayResetMs must be a whole number of milliseconds, at least 1: ${adapter.relayResetMs}`,
      path('relayResetMs'),
    )
  }
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
  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new ConfigError('the sessionController service is required to run peer messages', ['adapters'])
  }
  const observe = (listener: (sessionId: string, event: SessionEventLike) => void): (() => void) =>
    ctx.on('session/event', (session: { id: string }, event: SessionEventLike) => listener(session.id, event))
  const logger = ctx.get('logger') as { warn(message: string): void } | undefined
  const warn = (message: string): void => {
    void Promise.resolve()
      .then(() => logger?.warn(message))
      .catch(() => undefined)
  }
  const started = await Promise.all(
    pairs.map(({ adapter, table }) => {
      const sessions = new PeerSessions({ controller, observe })
      const gate = new InboundGate({
        loop: { relayLimit: adapter.relayLimit, relayResetMs: adapter.relayResetMs },
      })
      const handOff = (request: InboundRequest): void => {
        const event = toP2PEvent({ ...request, messageId: `p2p-${request.eventId}` })
        const reply = async (): Promise<void> => {
          const sessionId = await sessions.sessionFor(request.instance)
          const decision = await gate.admit({
            event: {
              eventKey: event.meta.derived.eventKey,
              scope: event.source.scope,
              mentioned: event.meta.transport.mentioned,
              text: request.body,
              peer: request.instance,
            },
            peer: request.instance,
            botId: adapter.botName,
            session: sessionId,
          })
          if (!decision.allow) {
            const detail = decision.detail === undefined ? '' : ` (${decision.detail})`
            warn(
              `dsbot-channel: kept ${request.eventId} from ${request.instance} out of a turn: ${decision.reason}${detail}`,
            )
            return
          }
          const turn = await sessions.runTurn({
            peer: request.instance,
            requestId: request.eventId,
            text: event.body.text,
          })
          if (turn.text.length === 0) return
          const configured = adapter.peers.find((candidate) => candidate.instance === request.instance)
          if (configured === undefined) return
          const url = (configured as PeerRef & { url?: string }).url
          const peer: PeerTarget = {
            instance: configured.instance,
            secret: configured.secret,
            ...(url === undefined ? {} : { url }),
          }
          const sent = await sendToPeer({
            peer,
            credentials,
            to: request.sender,
            body: turn.text,
            eventId: `reply:${request.eventId}`,
            sender: adapter.botName,
            instance: adapter.instance,
          })
          if (sent.ok) {
            gate.recordReply(adapter.botName, request.instance)
            return
          }
          warn(`dsbot-channel: reply to ${request.instance} was not delivered: ${sent.code} ${sent.reason}`)
        }
        void reply().catch((error: unknown) => {
          warn(`dsbot-channel: peer turn for ${request.instance} failed: ${String(error)}`)
        })
      }
      return startListener({
        config: { ...adapter, credentials },
        table,
        onMessage: handOff,
        onError: (error, request) => {
          warn(`dsbot-channel: handing off ${request.eventId} from ${request.instance} failed: ${String(error)}`)
        },
      })
    }),
  )
  ctx.provide('dsbot-channel.peers')
  ctx.set('dsbot-channel.peers', started)
  ctx.effect(() => async () => {
    ctx.set('dsbot-channel.peers', [])
    await Promise.all(started.map((listener) => listener.close()))
  }, 'dsbot-channel: peer listeners')
}
