import type { AdapterStatus } from '../../adapter-status.js'
import { buildListenerHealth, buildStatus } from '../../adapter-status.js'
import type { ChannelSnapshot } from '../../channel-stats.js'
import { countersOf } from '../../channel-stats.js'
import { ChannelStats } from '../../channel-stats.js'
import { ConfigError } from '../../config.js'
import type {
  AdapterCheckSettings,
  RefuseInput,
  RefuseResult,
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  SendInput,
  SendResult,
} from '../../contract.js'
import { REPLY_TARGET_MAX, SESSION_KEY_MAX, tokenProblem } from '../../contract.js'
import { GROUP_GUIDANCE, PEER_GUIDANCE } from './guidance.js'
import { DedupeTable } from './p2p-dedupe.js'
import type { InboundRequest } from './p2p-wire.js'
import { DEFAULT_HOST, DEFAULT_PORT, checkListenerConfig, startListener } from './p2p-listener.js'
import { STATUS_ROUTE } from './p2p-status.js'
import { cleanExcerpt, oneLine, toP2PEvent } from './p2p-mapping.js'
import { DEFAULT_SENT_AT_WINDOW_MS, MAX_BODY_BYTES } from './p2p-protocol.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { sendToPeer } from './p2p-send.js'
import type { PeerTarget } from './p2p-send.js'

export const DEFAULT_INFLIGHT_TTL_MS = 300_000

/** Longest note a refusal carries on the wire, one line. */
export const REFUSE_NOTE_MAX = 200

const DEFAULT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const DEFAULT_DEDUPE_LIMIT = 100_000

export interface P2PPeerConfig extends PeerRef {
  url?: string
}

export interface P2PAdapterConfig {
  channel: string
  instance: string
  botName: string
  peers: readonly P2PPeerConfig[]
  listen?: { host?: string; port?: number } | undefined
  dedupe?: { ttlMs?: number; limit?: number } | undefined
  inflightTtlMs?: number | undefined
  sentAtWindowMs?: number | undefined
  maxBodyBytes?: number | undefined
  waitMs?: number | undefined
  status?: boolean | undefined
}

export interface P2PAdapterOptions {
  warn?: ((message: string) => void) | undefined
  now?: (() => number) | undefined
}

function wholeMs(field: string, value: number, atLeast: number): number {
  if (!Number.isInteger(value) || value < atLeast) {
    throw new ConfigError(`${field} must be a whole number of milliseconds, at least ${atLeast}: ${value}`, [
      'adapters',
      'p2p',
      field,
    ])
  }
  return value
}

/** The p2p transport behind the adapter contract: one configured channel, one listener. */
export class P2PAdapter implements ChannelAdapter {
  readonly kind = 'p2p'
  readonly guidance = { peer: PEER_GUIDANCE, group: GROUP_GUIDANCE }
  readonly capabilities = {
    text: true,
    image: false,
    file: false,
    voice: false,
    recall: false,
    history: false,
    mention: false,
    reply: true,
    stream: false,
  }
  readonly #config: P2PAdapterConfig
  readonly #options: P2PAdapterOptions
  readonly #stats: ChannelStats
  readonly #now: () => number
  #table: DedupeTable | undefined
  #ports: AdapterPorts | undefined

  constructor(config: P2PAdapterConfig, options: P2PAdapterOptions = {}) {
    this.#config = config
    this.#options = options
    this.#stats = new ChannelStats(options.now)
    this.#now = options.now ?? Date.now
  }

  get snapshot(): ChannelSnapshot {
    return this.#stats.snapshot()
  }

  checkConfig(settings: AdapterCheckSettings): void {
    if (this.#config.peers.length === 0) {
      throw new ConfigError('at least one peer is required for each p2p adapter', ['adapters', 'p2p', 'peers'])
    }
    const host = this.#config.listen?.host ?? DEFAULT_HOST
    checkListenerConfig({
      botName: this.#config.botName,
      peers: this.#config.peers,
      credentials: { resolve: () => Promise.resolve(undefined) },
      inflightTtlMs: this.#config.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS,
      maxBodyBytes: this.#config.maxBodyBytes ?? MAX_BODY_BYTES,
      listen: { host },
    })
    const window = this.#config.sentAtWindowMs ?? DEFAULT_SENT_AT_WINDOW_MS
    wholeMs('sentAtWindowMs', window, 1)
    const inflight = this.#config.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS
    if (!Number.isInteger(inflight) || inflight <= settings.maxTurnMs) {
      throw new ConfigError(
        `inflightTtlMs must exceed maxTurnMs: ${inflight} <= ${settings.maxTurnMs}`,
        ['adapters', 'p2p', 'inflightTtlMs'],
      )
    }
    const bodyLimit = this.#config.maxBodyBytes ?? MAX_BODY_BYTES
    wholeMs('maxBodyBytes', bodyLimit, 1)
    if (this.#config.waitMs !== undefined) wholeMs('waitMs', this.#config.waitMs, 1)
    this.#table = new DedupeTable({
      ttlMs: this.#config.dedupe?.ttlMs ?? DEFAULT_DEDUPE_TTL_MS,
      limit: this.#config.dedupe?.limit ?? DEFAULT_DEDUPE_LIMIT,
      inflightTtlMs: inflight,
      maxTurnMs: settings.maxTurnMs,
      ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
    })
  }

  checkSessionKey(key: string): string | undefined {
    const shape = tokenProblem('session key', key, SESSION_KEY_MAX)
    if (shape !== undefined) return shape
    if (!key.startsWith('p2p:')) return `a p2p session key starts with "p2p:", got "${key}"`
    const peer = key.slice('p2p:'.length)
    if (peer.length === 0) return 'a p2p session key names a peer after "p2p:"'
    return this.#peer(peer) === undefined ? `this adapter addresses no peer "${peer}"` : undefined
  }

  checkTarget(target: string): string | undefined {
    const shape = tokenProblem('target', target, REPLY_TARGET_MAX)
    if (shape !== undefined) return shape
    return this.#peer(target) === undefined ? `this adapter addresses no peer "${target}"` : undefined
  }

  describeTargets(): string {
    return this.#config.peers.map((peer) => peer.instance).join(', ')
  }

  status(): AdapterStatus {
    const snapshot = this.#stats.snapshot()
    const listening = snapshot.state === 'listening'
    const failed = snapshot.state === 'failed'
    return buildStatus({
      channel: this.#config.channel,
      account: this.#config.instance,
      bot: this.#config.botName,
      health: buildListenerHealth({
        listenState: listening ? 'listening' : failed ? 'failed' : 'stopped',
        boundPort: snapshot.boundPort,
        lastAuthenticatedAt: snapshot.lastAuthenticatedAt,
        lastFailure: snapshot.lastFailure,
        queueDepth: snapshot.inFlight,
      }),
      counters: countersOf(snapshot),
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: snapshot.sampledAt,
      queueDepth: snapshot.inFlight,
    })
  }

  async send(input: SendInput): Promise<SendResult> {
    const ports = this.#ports
    if (ports === undefined) {
      return { ok: false, code: 'unreachable', retryable: true, reason: 'the p2p adapter is not started' }
    }
    const peer = this.#peer(input.target)
    if (peer === undefined) {
      return { ok: false, code: 'no_url', retryable: false, reason: `this adapter addresses no peer "${input.target}"` }
    }
    const to = input.to ?? peer.botName ?? ''
    if (to.length === 0) {
      return {
        ok: false,
        code: 'no_url',
        retryable: false,
        reason: `peer "${peer.instance}" names no bot, so this message has no recipient`,
      }
    }
    const target: PeerTarget = {
      instance: peer.instance,
      secret: peer.secret,
      ...(peer.url === undefined ? {} : { url: peer.url }),
      ...(peer.host === undefined ? {} : { host: peer.host }),
    }
    const result = await sendToPeer({
      peer: target,
      ...(input.chainId === undefined ? {} : { chainId: input.chainId }),
      credentials: this.#credentials(ports),
      to,
      body: input.body,
      eventId: input.eventId,
      sender: input.sender,
      instance: this.#config.instance,
      ...(input.sentAt === undefined ? {} : { sentAt: input.sentAt }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.inReplyToText === undefined ? {} : { inReplyToExcerpt: cleanExcerpt(input.inReplyToText) }),
    })
    if (!result.ok) this.#stats.sendFailed(result.code)
    return result
  }

  async refuse(input: RefuseInput): Promise<RefuseResult> {
    const ports = this.#ports
    if (ports === undefined) {
      return { ok: false, code: 'unreachable', reason: 'the p2p adapter is not started' }
    }
    const peer = this.#peer(input.target)
    if (peer === undefined) {
      return { ok: false, code: 'no_url', reason: `this adapter addresses no peer "${input.target}"` }
    }
    const to = input.to ?? peer.botName ?? ''
    if (to.length === 0) {
      return { ok: false, code: 'no_url', reason: `peer "${peer.instance}" names no bot, so a refusal has no recipient` }
    }
    const target: PeerTarget = {
      instance: peer.instance,
      secret: peer.secret,
      ...(peer.url === undefined ? {} : { url: peer.url }),
      ...(peer.host === undefined ? {} : { host: peer.host }),
    }
    const result = await sendToPeer({
      peer: target,
      credentials: this.#credentials(ports),
      to,
      body: '',
      eventId: `decline:${input.inReplyTo}`,
      chainId: input.chainId,
      sender: this.#config.botName,
      instance: this.#config.instance,
      status: 'declined',
      reason: oneLine(input.reason, REFUSE_NOTE_MAX),
      final: true,
    })
    if (!result.ok) this.#stats.sendFailed(result.code)
    return result.ok ? { ok: true } : { ok: false, code: result.code, reason: result.reason }
  }

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    const table = this.#table
    if (table === undefined) throw new Error('p2p: checkConfig must run before start')
    this.#ports = ports
    const listener = await startListener({
      config: {
        botName: this.#config.botName,
        peers: this.#config.peers,
        credentials: this.#credentials(ports),
        inflightTtlMs: this.#config.inflightTtlMs ?? DEFAULT_INFLIGHT_TTL_MS,
        maxBodyBytes: this.#config.maxBodyBytes ?? MAX_BODY_BYTES,
        ...(this.#config.sentAtWindowMs === undefined ? {} : { sentAtWindowMs: this.#config.sentAtWindowMs }),
        ...(this.#config.waitMs === undefined ? {} : { waitMs: this.#config.waitMs }),
        listen: { host: this.#config.listen?.host ?? DEFAULT_HOST, port: this.#config.listen?.port ?? DEFAULT_PORT },
      },
      table,
      stats: this.#stats,
      onMessage: (request) => {
        void ports.onMessage(this.toInbound(request)).then((verdict) => {
          if (!verdict.ok) this.#options.warn?.(`dsbot-channel: kept ${request.eventId} from ${request.instance} out of a turn: ${verdict.code} ${verdict.reason}`)
        })
      },
      onError: (error, request) => {
        this.#options.warn?.(`dsbot-channel: handing off ${request.eventId} from ${request.instance} failed: ${String(error)}`)
      },
      ...(this.#config.status === false
        ? {}
        : {
            status: {
              route: STATUS_ROUTE,
              report: () => this.status(),
            },
          }),
    })
    return {
      stop: async () => {
        await listener.close()
      },
      address: () => ({ port: listener.address().port }),
    }
  }

  /** Maps a verified wire request onto the inbound message core takes; the adapter owns every field. */
  toInbound(request: InboundRequest): InboundMessage {
    const event = toP2PEvent({ ...request, messageId: `p2p-${request.eventId}` })
    return {
      eventKey: event.meta.derived.eventKey,
      sessionKey: `p2p:${request.instance}`,
      replyTarget: request.instance,
      chainId: request.chainId,
      requestId: request.eventId,
      ...(request.status === 'declined' ? { suppressed: true } : {}),
      source: event.source,
      author: event.author,
      rawText: request.body,
      body: event.body,
      transport: event.meta.transport,
      declared: event.meta.declared,
      adapter: event.meta.adapter,
      receivedAt: this.#now(),
    }
  }

  #peer(instance: string): P2PPeerConfig | undefined {
    return this.#config.peers.find((peer) => peer.instance === instance)
  }

  #credentials(ports: AdapterPorts): CredentialsLike {
    return {
      resolve: async (reference: string) => {
        const value = await ports.resolveSecret(reference)
        return value === undefined ? undefined : { value }
      },
    }
  }
}
