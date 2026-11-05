import type { AdapterCounters } from './adapter-status.js'

export type ChannelState = 'starting' | 'listening' | 'failed' | 'closed'

/** How many unknown instance names one channel remembers, so a sender cannot grow the set without bound. */
export const UNKNOWN_WARNED_MAX = 256

export interface ChannelFailure {
  at: number
  reason: string
}

export interface ChannelHealth {
  /** Turns that ended without an answer. */
  emptyTurns: number
  /** Outbound failures counted by the code the send layer reported. */
  sendFailures: Record<string, number>
}

export interface ChannelSnapshot {
  state: ChannelState
  boundPort: number | null
  lastAuthenticatedAt: number | null
  /** sentAt minus this clock on the last authenticated message; null until one arrives. */
  lastSkewMs: number | null
  lastFailure: ChannelFailure | null
  inFlight: number
  /** Deliveries that ended without one having begun, which is always a bug. */
  underruns: number
  /** Requests for a path this channel does not serve, which a port scan also produces. */
  unknownPaths: number
  /** Requests refused because the caller did not present the configured token. */
  authFailures: number
  /** Messages from an instance the roster does not name. */
  unknownInstance: number
  /** Non-message events by the transport's own class, before core sees them. */
  events?: Record<string, number> | undefined
  /** Peers that spoke a protocol version this build does not sign. */
  protocolMismatches: number
  lastProtocolMismatchAt: number | null
  /** Messages refused as stale, by the peer instance that sent them. */
  staleSentAt: Record<string, number>
  health: ChannelHealth
  sampledAt: number
}

/** Collects what a channel can report about itself, and nothing else. */
export class ChannelStats {
  readonly #now: () => number
  #state: ChannelState = 'starting'
  #boundPort: number | null = null
  #lastAuthenticatedAt: number | null = null
  #lastSkewMs: number | null = null
  #lastFailure: ChannelFailure | null = null
  #inFlight = 0
  #underruns = 0
  #unknownPaths = 0
  #authFailures = 0
  #unknownInstance = 0
  #protocolMismatches = 0
  #lastProtocolMismatchAt: number | null = null
  readonly #staleSentAt = new Map<string, number>()
  readonly #staleWarned = new Set<string>()
  readonly #unknownWarned = new Set<string>()
  #emptyTurns = 0
  readonly #sendFailures = new Map<string, number>()
  readonly #events = new Map<string, number>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  listening(port: number): void {
    this.#state = 'listening'
    this.#boundPort = port
  }

  failed(reason: string): void {
    this.#state = 'failed'
    this.#boundPort = null
    this.#remember(reason)
  }

  closed(): void {
    this.#state = 'closed'
    this.#boundPort = null
  }

  authenticated(): void {
    this.#lastAuthenticatedAt = this.#now()
  }

  /** Records how far the sender's clock was from this one on the message just seen. */
  skew(sentAtMinusNow: number): void {
    this.#lastSkewMs = sentAtMinusNow
  }

  rejected(reason: string): void {
    this.#remember(reason)
  }

  unknownPath(): void {
    this.#unknownPaths += 1
  }

  authFailure(): void {
    this.#authFailures += 1
  }

  /** Counts a message from an instance the roster does not name; true only the first time that name is warned about. */
  unknownInstance(instance: string): boolean {
    this.#unknownInstance += 1
    if (this.#unknownWarned.has(instance)) return false
    this.#unknownWarned.add(instance)
    if (this.#unknownWarned.size > UNKNOWN_WARNED_MAX) {
      const oldest = this.#unknownWarned.values().next().value
      if (oldest !== undefined) this.#unknownWarned.delete(oldest)
    }
    return true
  }

  protocolMismatch(): void {
    this.#protocolMismatches += 1
    this.#lastProtocolMismatchAt = this.#now()
  }

  emptyTurn(): void {
    this.#emptyTurns += 1
  }

  /** Counts a message refused as stale; true only the first time this instance is warned about. */
  stale(instance: string): boolean {
    this.#staleSentAt.set(instance, (this.#staleSentAt.get(instance) ?? 0) + 1)
    if (this.#staleWarned.has(instance)) return false
    this.#staleWarned.add(instance)
    return true
  }

  /** Counts one non-message event by class; a message is not one of these. */
  event(code: string): void {
    this.#events.set(code, (this.#events.get(code) ?? 0) + 1)
  }

  sendFailed(code: string): void {
    this.#sendFailures.set(code, (this.#sendFailures.get(code) ?? 0) + 1)
  }

  beginDelivery(): void {
    this.#inFlight += 1
  }

  endDelivery(): void {
    if (this.#inFlight === 0) {
      this.#underruns += 1
      return
    }
    this.#inFlight -= 1
  }

  snapshot(): ChannelSnapshot {
    return {
      state: this.#state,
      boundPort: this.#boundPort,
      lastAuthenticatedAt: this.#lastAuthenticatedAt,
      lastSkewMs: this.#lastSkewMs,
      lastFailure: this.#lastFailure === null ? null : { at: this.#lastFailure.at, reason: this.#lastFailure.reason },
      inFlight: this.#inFlight,
      underruns: this.#underruns,
      unknownPaths: this.#unknownPaths,
      authFailures: this.#authFailures,
      unknownInstance: this.#unknownInstance,
      protocolMismatches: this.#protocolMismatches,
      lastProtocolMismatchAt: this.#lastProtocolMismatchAt,
      staleSentAt: Object.fromEntries(this.#staleSentAt),
      health: { emptyTurns: this.#emptyTurns, sendFailures: Object.fromEntries(this.#sendFailures) },
      events: Object.fromEntries(this.#events),
      sampledAt: this.#now(),
    }
  }

  #remember(reason: string): void {
    this.#lastFailure = { at: this.#now(), reason }
  }
}

/** The counters a status reader needs, taken from one transport's snapshot. */
export function countersOf(snapshot: ChannelSnapshot): AdapterCounters {
  return {
    authFailures: snapshot.authFailures,
    unknownInstance: snapshot.unknownInstance,
    unknownPaths: snapshot.unknownPaths,
    underruns: snapshot.underruns,
    protocolMismatches: snapshot.protocolMismatches,
    staleSentAt: { ...snapshot.staleSentAt },
    sendFailures: { ...snapshot.health.sendFailures },
    ...(Object.keys(snapshot.events ?? {}).length === 0 ? {} : { events: { ...snapshot.events } }),
    lastFailure:
      snapshot.lastFailure === null ? null : { at: snapshot.lastFailure.at, reason: snapshot.lastFailure.reason },
  }
}
