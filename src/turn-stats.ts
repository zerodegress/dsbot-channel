export interface TurnStatsSnapshot {
  /** Turns core started, one per accepted message. */
  started: number
  /** Turns whose reply was delivered. */
  replied: number
  /** Turns that ended with no text and no tool call, which always loses an answer. */
  empty: number
  /** Turns whose plain text was discarded because the session requires a tool call. */
  dropped: number
  /** Turns that already answered through send_text. */
  pushed: number
  /** Turns a tool closed on purpose, so they answered nothing. */
  suppressed: number
  /** Turns that ended with an exception instead of one of the endings above. */
  failed: number
  /** Outbound failures counted by the code the adapter reported. */
  sendFailures: Record<string, number>
  sampledAt: number
}

/** Counts what core sees about the turns it ran, beside the transport's own health. */
export class TurnStats {
  readonly #now: () => number
  #started = 0
  #replied = 0
  #empty = 0
  #dropped = 0
  #pushed = 0
  #suppressed = 0
  #failed = 0
  readonly #sendFailures = new Map<string, number>()

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  started(): void {
    this.#started += 1
  }

  replied(): void {
    this.#replied += 1
  }

  empty(): void {
    this.#empty += 1
  }

  dropped(): void {
    this.#dropped += 1
  }

  pushed(): void {
    this.#pushed += 1
  }

  suppressed(): void {
    this.#suppressed += 1
  }

  failed(): void {
    this.#failed += 1
  }

  sendFailed(code: string): void {
    this.#sendFailures.set(code, (this.#sendFailures.get(code) ?? 0) + 1)
  }

  snapshot(): TurnStatsSnapshot {
    return {
      started: this.#started,
      replied: this.#replied,
      empty: this.#empty,
      dropped: this.#dropped,
      pushed: this.#pushed,
      suppressed: this.#suppressed,
      failed: this.#failed,
      sendFailures: Object.fromEntries(this.#sendFailures),
      sampledAt: this.#now(),
    }
  }
}
