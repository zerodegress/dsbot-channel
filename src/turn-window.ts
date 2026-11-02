import { TurnQueue } from './turn-queue.js'
import type { BatchLimits } from './turn-batch.js'

export interface WindowDeps {
  now: () => number
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

export interface WindowOptions {
  limits: BatchLimits
  /** Zero means every message is answered on its own, with no queue at all. */
  windowMs: number
}

interface Held<T> {
  queue: TurnQueue<T>
  timer: unknown
}

/**
 * Holds a queue per conversation and reopens the window whenever a batch leaves
 * something behind. A stopped window owns no timer, so nothing fires after it ends.
 */
export class TurnWindows<T> {
  readonly #deps: WindowDeps
  readonly #options: WindowOptions
  readonly #held = new Map<string, Held<T>>()

  constructor(deps: WindowDeps, options: WindowOptions) {
    this.#deps = deps
    this.#options = options
  }

  /** Adds one message; returns the batch to answer now, or undefined while the window stays open. */
  offer(key: string, item: { eventKey: string; chars: number; value: T }, flush: (batch: readonly T[]) => void): readonly T[] | undefined {
    if (this.#options.windowMs === 0) {
      flush([item.value])
      return [item.value]
    }
    let held = this.#held.get(key)
    if (held === undefined) {
      held = { queue: new TurnQueue<T>(this.#options.limits, this.#options.windowMs), timer: undefined }
      this.#held.set(key, held)
    }
    const ready = held.queue.push(item, this.#deps.now())
    if (ready !== undefined) {
      if (held.timer !== undefined) this.#deps.clearTimer(held.timer)
      held.timer = undefined
      flush(ready.map((one) => one.value))
      this.#open(key, held, flush)
      return ready.map((one) => one.value)
    }
    this.#open(key, held, flush)
    return undefined
  }

  /** Drops every queue and timer, for a channel that is stopping. */
  clear(): void {
    for (const held of this.#held.values()) {
      if (held.timer !== undefined) this.#deps.clearTimer(held.timer)
    }
    this.#held.clear()
  }

  get pending(): number {
    let total = 0
    for (const held of this.#held.values()) total += held.queue.pending
    return total
  }

  #open(key: string, held: Held<T>, flush: (batch: readonly T[]) => void): void {
    if (held.queue.pending === 0 || held.timer !== undefined) return
    held.timer = this.#deps.setTimer(() => {
      held.timer = undefined
      const due = held.queue.due(this.#deps.now())
      if (due !== undefined) flush(due.map((one) => one.value))
      this.#open(key, held, flush)
    }, this.#options.windowMs)
  }
}
