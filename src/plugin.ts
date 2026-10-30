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
import { DEFAULT_SENT_AT_WINDOW_MS } from './p2p-protocol.js'
import type { PeerTarget } from './p2p-send.js'
import { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from './inbound-gate.js'
import type { PolicyConfig } from './policy-config.js'
import { compilePolicy } from './policy-config.js'
import { buildPipeline } from './build-pipeline.js'
import { createLedger } from './budget-config.js'
import type { BudgetConfig } from './budget-config.js'
import { TurnBilling } from './turn-billing.js'
import type { Hold } from './budget-ledger.js'

import { cleanExcerpt, toP2PEvent } from './p2p-mapping.js'
import { createWarn } from './warn.js'
import { ChannelStats } from './channel-stats.js'
import { StatusRegistry } from './p2p-status.js'
import { PushRouter, createSendText } from './push-tool.js'
import type { PushSource, SendTextTool } from './push-tool.js'
import { ClosedChains } from './chain-closer.js'
import { InjectionLedger, guidanceFor } from './inbound-guidance.js'
import { createDeclineTool, createNoReplyTool } from './control-tools.js'
import type { ControlPorts, PeerTurnRef } from './control-tools.js'

/** Turn ceiling a message may occupy before it is dropped. */
export const MAX_TURN_MS = 120_000

/** One place that turns a configured peer into a send target, so a new field reaches every path. */
function targetOf(peer: PeerRef): PeerTarget {
  const url = (peer as PeerRef & { url?: string }).url
  const host = peer.host
  return {
    instance: peer.instance,
    secret: peer.secret,
    ...(url === undefined ? {} : { url }),
    ...(host === undefined ? {} : { host }),
  }
}

export interface PolicySettings extends PolicyConfig {
  relayLimit: number
  relayResetMs: number
  score?: unknown
  judge?: unknown
  prepare?: unknown
  budget?: BudgetConfig | undefined
}

export interface AdapterConfig extends ListenerConfig {
  kind?: 'p2p'
  channel: string
  instance: string
  /** Runs every peer turn in this existing session instead of one created per peer. */
  session?: string
  policy: PolicySettings
  dedupe?: { ttlMs?: number; limit?: number }
  status?: boolean
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
        session: Schema.string(),
        peers: Schema.array(
          Schema.object({
            instance: Schema.string().required(),
            secret: Schema.string().required(),
            url: Schema.string(),
            botName: Schema.string(),
            host: Schema.string(),
          }),
        ).default([]),
        policy: Schema.object({
          relayLimit: Schema.number().default(DEFAULT_LOOP_MAX_TURNS),
          relayResetMs: Schema.number().default(DEFAULT_LOOP_IDLE_RESET_MS),
          deny: Schema.object({
            words: Schema.array(Schema.string()).default([]),
            regexes: Schema.array(Schema.string()).default([]),
          }).default({}),
          allow: Schema.object({
            peers: Schema.array(Schema.string()).default([]),
          }).default({}),
          score: Schema.any(),
          judge: Schema.any(),
          prepare: Schema.any(),
          budget: Schema.object({
            capacity: Schema.number(),
            softLimit: Schema.number(),
            hardLimit: Schema.number(),
          }).default(undefined as never),
        }).default({}),
        inflightTtlMs: Schema.number().default(300_000),
        sentAtWindowMs: Schema.number().default(DEFAULT_SENT_AT_WINDOW_MS),
        maxBodyBytes: Schema.number().default(64 * 1024),
        waitMs: Schema.number(),
        listen: Schema.object({
          host: Schema.string().default(DEFAULT_HOST),
          port: Schema.number().default(DEFAULT_PORT),
        }).default({}),
        /** Loopback only, and refused once a forwarder rewrites the request; on unless turned off. */
        status: Schema.boolean().default(true),
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
  const { relayLimit, relayResetMs } = adapter.policy
  if (!Number.isInteger(relayLimit) || relayLimit < 1) {
    throw new ConfigError(
      `relayLimit must be a whole number of rounds, at least 1: ${relayLimit}`,
      path('policy'),
    )
  }
  if (!Number.isInteger(relayResetMs) || relayResetMs < 1) {
    throw new ConfigError(
      `relayResetMs must be a whole number of milliseconds, at least 1: ${relayResetMs}`,
      path('policy'),
    )
  }
  const budget = adapter.policy.budget
  if (budget !== undefined && budget.capacity === undefined) {
    throw new ConfigError('policy.budget.capacity is required', [...path('policy'), 'budget', 'capacity'])
  }
  if (budget?.softLimit !== undefined) {
    throw new ConfigError(
      'policy.budget.softLimit is not supported in this version: a soft limit is computed but nothing acts on it yet',
      [...path('policy'), 'budget', 'softLimit'],
    )
  }
  if (budget?.capacity !== undefined && (!Number.isInteger(budget.capacity) || budget.capacity < 1)) {
    throw new ConfigError(
      `budget capacity must be a whole number of points, at least 1: ${budget.capacity}`,
      [...path('policy'), 'budget', 'capacity'],
    )
  }
  for (const unsupported of ['score', 'judge', 'prepare'] as const) {
    if (adapter.policy[unsupported] !== undefined) {
      throw new ConfigError(
        `policy.${unsupported} is not supported in this version: only deny and allow can be configured`,
        [...path('policy'), unsupported],
      )
    }
  }
  const window = adapter.sentAtWindowMs ?? DEFAULT_SENT_AT_WINDOW_MS
  if (!Number.isInteger(window) || window < 1) {
    throw new ConfigError(
      `sentAtWindowMs must be a whole number of milliseconds, at least 1: ${window}`,
      path('sentAtWindowMs'),
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
    ctx.on('session/event', (session, event) => listener(session.id, event as unknown as SessionEventLike))
  const warn = createWarn(ctx)
  const registry = new StatusRegistry()
  const sources = new Map<string, PushSource>()
  const statsByChannel = new Map<string, ChannelStats>()
  const chains = new ClosedChains()
  const injected = new InjectionLedger()
  const activeTurns = new Map<string, PeerTurnRef>()
  const started = await Promise.all(
    pairs.map(({ adapter, table }) => {
      const sessions = new PeerSessions({
        controller,
        observe,
        ...(adapter.session === undefined ? {} : { session: adapter.session }),
      })
      const stats = new ChannelStats()
      statsByChannel.set(adapter.channel, stats)
      registry.register(adapter.channel, () => ({
        channel: adapter.channel,
        bot: adapter.botName,
        instance: adapter.instance,
        snapshot: stats.snapshot(),
      }))
      const compiled = compilePolicy(adapter.policy)
      const pipeline = compiled.specs.length > 0 ? buildPipeline(compiled.specs, compiled.deps) : undefined
      const budget = adapter.policy.budget
      const ledger = budget === undefined ? undefined : createLedger(budget)
      const billing = new TurnBilling({ ledger })
      const gate = new InboundGate({
        loop: { relayLimit: adapter.policy.relayLimit, relayResetMs: adapter.policy.relayResetMs },
        pipeline,
        ledger,
      })
      const handOff = (request: InboundRequest): void => {
        const event = toP2PEvent({ ...request, messageId: `p2p-${request.eventId}` })
        let hold: Hold | undefined
        const reply = async (): Promise<void> => {
          const sessionId = await sessions.sessionFor(request.instance)
          sources.set(sessionId, { channel: adapter.channel, peer: request.instance })
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
          const turnRef: PeerTurnRef = {
            eventId: request.eventId,
            channel: adapter.channel,
            peer: request.instance,
            sender: request.sender,
            suppressed: request.status === 'declined' || chains.isClosed(request.eventId),
            pushed: false,
          }
          activeTurns.set(sessionId, turnRef)
          hold = billing.begin(adapter.botName, request.instance, sessionId)
          const guidance = injected.claim(sessionId) ? guidanceFor(event.source.scope) : ''
          const turn = await sessions.runTurn({
            peer: request.instance,
            requestId: request.eventId,
            text: guidance.length === 0 ? event.body.text : `${guidance}\n\n${event.body.text}`,
          })
          if (turnRef.suppressed) {
            billing.refund(hold)
            hold = undefined
            return
          }
          if (turnRef.pushed) {
            billing.accept(hold)
            hold = undefined
            return
          }
          if (turn.text.length === 0) {
            warn(
              `dsbot-channel: the turn for ${request.eventId} from ${request.instance} ended with no text and no tool call`,
            )
            stats.emptyTurn()
            billing.reject(hold)
            hold = undefined
            return
          }
          const configured = adapter.peers.find((candidate) => candidate.instance === request.instance)
          if (configured === undefined) {
            billing.reject(hold)
            hold = undefined
            return
          }
          const peer = targetOf(configured)
          const sent = await sendToPeer({
            peer,
            credentials,
            to: request.sender,
            body: turn.text,
            eventId: `reply:${request.eventId}`,
            sender: adapter.botName,
            instance: adapter.instance,
            inReplyTo: request.eventId,
            inReplyToExcerpt: cleanExcerpt(request.body),
          })
          if (!sent.ok) stats.sendFailed(sent.code)
          if (sent.ok) {
            gate.recordReply(adapter.botName, request.instance)
            billing.accept(hold)
            hold = undefined
            return
          }
          billing.reject(hold)
          hold = undefined
          warn(`dsbot-channel: reply to ${request.instance} was not delivered: ${sent.code} ${sent.reason}`)
        }
        void reply().catch((error: unknown) => {
          billing.refund(hold)
          warn(`dsbot-channel: peer turn for ${request.instance} failed: ${String(error)}`)
        })
      }
      return startListener({
        config: { ...adapter, credentials },
        table,
        onMessage: handOff,
        stats,
        ...(adapter.status === true
          ? {
              status: {
                report: () => ({
                  channel: adapter.channel,
                  bot: adapter.botName,
                  instance: adapter.instance,
                  snapshot: stats.snapshot(),
                }),
              },
            }
          : {}),
        onError: (error, request) => {
          warn(`dsbot-channel: handing off ${request.eventId} from ${request.instance} failed: ${String(error)}`)
        },
      })
    }),
  )
  ctx.provide('dsbot-channel.status')
  ctx.set('dsbot-channel.status', { snapshot: () => registry.snapshot() })
  ctx.provide('dsbot-channel.peers')
  ctx.set('dsbot-channel.peers', started)
  type AnyTool = SendTextTool | ReturnType<typeof createNoReplyTool> | ReturnType<typeof createDeclineTool>
  const tools = ctx.get('tools') as { register: (definition: AnyTool) => () => void } | undefined
  if (tools !== undefined && typeof tools.register === 'function') {
    const byChannel = new Map(pairs.map(({ adapter }) => [adapter.channel, adapter]))
    const router = new PushRouter({
      channels: pairs.map(({ adapter }) => ({
        channel: adapter.channel,
        instance: adapter.instance,
        botName: adapter.botName,
        peers: adapter.peers.map((peer) => ({
          instance: peer.instance,
          ...(peer.botName === undefined ? {} : { botName: peer.botName }),
          ...(peer.host === undefined ? {} : { host: peer.host }),
        })),
      })),
      source: (sessionId) => (sessionId === undefined ? undefined : sources.get(sessionId)),
      delivered: (sessionId) => {
        if (sessionId === undefined) return
        const turn = activeTurns.get(sessionId)
        if (turn !== undefined) turn.pushed = true
      },
      send: async (delivery) => {
        const adapter = byChannel.get(delivery.channel)
        const peer = adapter?.peers.find((candidate) => candidate.instance === delivery.peer)
        if (adapter === undefined || peer === undefined) {
          return {
            ok: false,
            code: 'no_url',
            retryable: false,
            reason: `peer "${delivery.peer}" is gone from channel "${delivery.channel}"`,
          }
        }
        const answered = await sendToPeer({
          peer: targetOf(peer),
          credentials,
          to: delivery.to,
          body: delivery.text,
          eventId: delivery.eventId,
          sender: adapter.botName,
          instance: adapter.instance,
        })
        if (!answered.ok) statsByChannel.get(delivery.channel)?.sendFailed(answered.code)
        return answered
      },
    })
    ctx.effect(() => tools.register(createSendText(router)), 'dsbot-channel: send_text tool')
    const ports: ControlPorts = {
      turnOf: (sessionId) => (sessionId === undefined ? undefined : activeTurns.get(sessionId)),
      isClosed: (eventId) => chains.isClosed(eventId),
      closeChain: (eventId) => {
        chains.close(eventId)
      },
      decline: async (turn, reason) => {
        const adapter = byChannel.get(turn.channel)
        const peer = adapter?.peers.find((candidate) => candidate.instance === turn.peer)
        if (adapter === undefined || peer === undefined) {
          return { ok: false, code: 'no_url', reason: `peer "${turn.peer}" is gone from channel "${turn.channel}"` }
        }
        const sent = await sendToPeer({
          peer: targetOf(peer),
          credentials,
          to: turn.sender,
          body: '',
          eventId: `decline:${turn.eventId}`,
          sender: adapter.botName,
          instance: adapter.instance,
          status: 'declined',
          final: true,
          ...(reason === undefined ? {} : { reason }),
        })
        if (!sent.ok) statsByChannel.get(turn.channel)?.sendFailed(sent.code)
        return sent.ok ? { ok: true } : { ok: false, code: sent.code, reason: sent.reason }
      },
    }
    ctx.effect(() => tools.register(createNoReplyTool(ports)), 'dsbot-channel: no_reply tool')
    ctx.effect(() => tools.register(createDeclineTool(ports)), 'dsbot-channel: decline tool')
  }
  ctx.effect(() => async () => {
    registry.clear()
    ctx.set('dsbot-channel.peers', [])
    await Promise.all(started.map((listener) => listener.close()))
  }, 'dsbot-channel: peer listeners')
}
