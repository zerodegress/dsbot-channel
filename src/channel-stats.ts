export type ChannelState = 'starting' | 'listening' | 'failed' | 'closed'

export interface ChannelFailure {
  at: number
  reason: string
}

export interface ChannelSnapshot {
  state: ChannelState
  boundPort: number | null
  lastAuthenticatedAt: number | null
  lastFailure: ChannelFailure | null
  inFlight: number
  sampledAt: number
}

/** Collects what a channel can report about itself, and nothing else. */
export class ChannelStats {
  readonly #now: () => number
  #state: ChannelState = 'starting'
  #boundPort: number | null = null
  #lastAuthenticatedAt: number | null = null
  #lastFailure: ChannelFailure | null = null
  #inFlight = 0

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

  rejected(reason: string): void {
    this.#remember(reason)
  }

  beginDelivery(): void {
    this.#inFlight += 1
  }

  endDelivery(): void {
    this.#inFlight = Math.max(0, this.#inFlight - 1)
  }

  snapshot(): ChannelSnapshot {
    return {
      state: this.#state,
      boundPort: this.#boundPort,
      lastAuthenticatedAt: this.#lastAuthenticatedAt,
      lastFailure: this.#lastFailure === null ? null : { at: this.#lastFailure.at, reason: this.#lastFailure.reason },
      inFlight: this.#inFlight,
      sampledAt: this.#now(),
    }
  }

  #remember(reason: string): void {
    this.#lastFailure = { at: this.#now(), reason }
  }
}
