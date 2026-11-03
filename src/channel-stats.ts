import type { AdapterCounters } from './adapter-status.js'

export type ChannelState = 'starting' | 'listening' | 'failed' | 'closed'

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
  /** Peers that spoke a protocol version this build does not sign. */
  protocolMismatches: number
  lastProtocolMismatchAt: number | null
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
  #protocolMismatches = 0
  #lastProtocolMismatchAt: number | null = null
  #emptyTurns = 0
  readonly #sendFailures = new Map<string, number>()

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

  protocolMismatch(): void {
    this.#protocolMismatches += 1
    this.#lastProtocolMismatchAt = this.#now()
  }

  emptyTurn(): void {
    this.#emptyTurns += 1
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
      protocolMismatches: this.#protocolMismatches,
      lastProtocolMismatchAt: this.#lastProtocolMismatchAt,
      health: { emptyTurns: this.#emptyTurns, sendFailures: Object.fromEntries(this.#sendFailures) },
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
    unknownPaths: snapshot.unknownPaths,
    underruns: snapshot.underruns,
    protocolMismatches: snapshot.protocolMismatches,
    sendFailures: { ...snapshot.health.sendFailures },
    lastFailure:
      snapshot.lastFailure === null ? null : { at: snapshot.lastFailure.at, reason: snapshot.lastFailure.reason },
  }
}
