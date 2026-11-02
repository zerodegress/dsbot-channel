export const TURN_OUTCOMES = [
  'replied',
  'pushed',
  'ended',
  'refused',
  'dropped',
  'empty',
  'failed',
  'rejected',
] as const
export type TurnOutcome = (typeof TURN_OUTCOMES)[number]

/** One turn as the host may read it back; never the message body. */
export interface TurnRecord {
  eventKey: string
  bot: string
  channel: string
  sessionKey: string
  startedAt: number
  endedAt: number
  outcome: TurnOutcome
  code?: string | undefined
  durationMs: number
  /** How many messages this turn answered; `merged === mergedKeys.length` always holds. */
  merged: number
  /** The event keys it answered, in arrival order; the triggering message is included. */
  mergedKeys: string[]
}

export const DEFAULT_TURN_RECORD_LIMIT = 200

export interface TurnStatsOptions {
  now?: (() => number) | undefined
  /** How many finished turns are kept for a reader; the oldest is dropped first. */
  limit?: number | undefined
}

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
  /** Turns a tool closed on purpose, so they answered nothing; the sum of `ended` and `refused`. */
  suppressed: number
  /** Turns closed quietly with `no_reply`. */
  ended: number
  /** Turns the bot refused with `decline`. */
  refused: number
  /** Turns that ended with an exception instead of one of the endings above. */
  failed: number
  /** Outbound failures counted by the code the adapter reported. */
  sendFailures: Record<string, number>
  sampledAt: number
  /** The most recent finished turns, oldest first, at most the configured limit. */
  recent: TurnRecord[]
}

/** Counts what core sees about the turns it ran, beside the transport's own health. */
export class TurnStats {
  readonly #now: () => number
  readonly #limit: number
  readonly #recent: TurnRecord[] = []
  readonly #open = new Map<string, number>()
  #started = 0
  #replied = 0
  #empty = 0
  #dropped = 0
  #pushed = 0
  #suppressed = 0
  #ended = 0
  #refused = 0
  #failed = 0
  readonly #sendFailures = new Map<string, number>()

  constructor(options: TurnStatsOptions = {}) {
    this.#now = options.now ?? Date.now
    this.#limit = options.limit ?? DEFAULT_TURN_RECORD_LIMIT
  }

  /** Marks a turn as running, so its duration can be measured when it ends. */
  open(key: string): void {
    this.#open.set(key, this.#now())
  }

  /** Records how one turn ended; a turn opened earlier carries its own duration. */
  close(
    input: {
      eventKey: string
      bot: string
      channel: string
      sessionKey: string
      outcome: TurnOutcome
      code?: string
      mergedKeys?: readonly string[]
    },
  ): void {
    const startedAt = this.#open.get(input.eventKey) ?? this.#now()
    this.#open.delete(input.eventKey)
    const endedAt = this.#now()
    const mergedKeys = input.mergedKeys === undefined ? [input.eventKey] : [...input.mergedKeys]
    if (mergedKeys.length === 0 || !mergedKeys.includes(input.eventKey)) {
      throw new Error(`a turn record names the message it answers: "${input.eventKey}" is not in its merged keys`)
    }
    const record: TurnRecord = {
      eventKey: input.eventKey,
      bot: input.bot,
      channel: input.channel,
      sessionKey: input.sessionKey,
      startedAt,
      endedAt,
      outcome: input.outcome,
      durationMs: endedAt - startedAt,
      merged: mergedKeys.length,
      mergedKeys,
      ...(input.code === undefined ? {} : { code: input.code }),
    }
    this.#recent.push(record)
    while (this.#recent.length > this.#limit) this.#recent.shift()
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

  suppressed(outcome: 'ended' | 'refused' = 'ended'): void {
    this.#suppressed += 1
    if (outcome === 'refused') this.#refused += 1
    else this.#ended += 1
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
      ended: this.#ended,
      refused: this.#refused,
      failed: this.#failed,
      sendFailures: Object.fromEntries(this.#sendFailures),
      sampledAt: this.#now(),
      recent: this.#recent.map((record) => ({ ...record })),
    }
  }
}
