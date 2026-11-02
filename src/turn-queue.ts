import { takeBatch } from './turn-batch.js'
import type { BatchLimits, PendingMessage } from './turn-batch.js'

/** One message waiting for the turn that will answer it. */
export interface QueuedMessage<T> extends PendingMessage {
  value: T
}

/**
 * Holds messages until a window closes or a cap is reached. `push` and `due` never drop a
 * message: whatever a batch does not take stays at the head for the next one.
 */
export class TurnQueue<T> {
  #queue: QueuedMessage<T>[] = []
  #openedAt: number | undefined

  constructor(
    private readonly limits: BatchLimits,
    private readonly windowMs: number,
  ) {}

  get pending(): number {
    return this.#queue.length
  }

  /** Adds one message and returns the batch to answer now, when a cap has just been reached. */
  push(message: QueuedMessage<T>, now: number): QueuedMessage<T>[] | undefined {
    this.#queue.push(message)
    if (this.#openedAt === undefined) this.#openedAt = now
    if (this.windowMs === 0) return this.#take(now)
    const fits = takeBatch(this.#queue, this.limits)
    if (fits < this.#queue.length || this.#queue.length >= this.limits.maxBatch) return this.#take(now)
    return undefined
  }

  /** Returns the batch to answer when the window has closed, or undefined while it is open. */
  due(now: number): QueuedMessage<T>[] | undefined {
    if (this.#queue.length === 0) return undefined
    if (this.windowMs > 0 && this.#openedAt !== undefined && now - this.#openedAt < this.windowMs) return undefined
    return this.#take(now)
  }

  /** Empties the queue, for a channel that is stopping. */
  clear(): void {
    this.#queue = []
    this.#openedAt = undefined
  }

  #take(now: number): QueuedMessage<T>[] | undefined {
    const count = takeBatch(this.#queue, this.limits)
    if (count === 0) return undefined
    const batch = this.#queue.splice(0, count)
    this.#openedAt = this.#queue.length === 0 ? undefined : now
    return batch
  }
}
