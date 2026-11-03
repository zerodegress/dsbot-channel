export interface DedupeOptions {
  ttlMs: number
  limit: number
  inflightTtlMs?: number
  maxTurnMs?: number
  now?: () => number
}

export interface DedupeEntry {
  messageId: string
  at: number
}

type Waiter = (entry: DedupeEntry | null) => void

/** Dedupe table with single-flight: a concurrent duplicate waits instead of reprocessing. */
export class DedupeTable {
  /** When this table started; a replay carried into a table with a newer epoch crossed a restart. */
  readonly epoch: number
  private readonly done = new Map<string, DedupeEntry>()
  private readonly inflight = new Map<string, { at: number; waiters: Waiter[] }>()
  private readonly now: () => number

  constructor(private readonly options: DedupeOptions) {
    if (options.inflightTtlMs !== undefined && options.maxTurnMs !== undefined && options.inflightTtlMs <= options.maxTurnMs) {
      throw new Error('inflightTtlMs must exceed maxTurnMs')
    }
    this.now = options.now ?? Date.now
    this.epoch = this.now()
  }

  has(key: string): DedupeEntry | undefined {
    const entry = this.done.get(key)
    if (!entry) return undefined
    if (this.now() - entry.at > this.options.ttlMs) {
      this.done.delete(key)
      return undefined
    }
    return entry
  }

  /** Claims the key. Returns the finished entry, or null when this call now owns the work. */
  async claim(key: string, waitMs: number): Promise<{ done: true; entry: DedupeEntry | null } | { done: false }> {
    const finished = this.has(key)
    if (finished) return { done: true, entry: finished }
    const stale = this.inflight.get(key)
    if (stale && this.expired(stale)) this.reap(key, stale)
    const running = this.inflight.get(key)
    if (running) {
      const entry = await new Promise<DedupeEntry | null>((resolve) => {
        let settled = false
        const finish = (value: DedupeEntry | null) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          const index = running.waiters.indexOf(finish)
          if (index >= 0) running.waiters.splice(index, 1)
          resolve(value)
        }
        const timer = setTimeout(() => finish(null), waitMs)
        running.waiters.push(finish)
      })
      return { done: true, entry }
    }
    this.inflight.set(key, { at: this.now(), waiters: [] })
    return { done: false }
  }

  private expired(entry: { at: number }): boolean {
    const ttl = this.options.inflightTtlMs
    return ttl !== undefined && this.now() - entry.at > ttl
  }

  /** Drops a reservation left by a crashed handler so the event can be retried. */
  private reap(key: string, entry: { waiters: Waiter[] }): void {
    this.inflight.delete(key)
    for (const waiter of entry.waiters) waiter(null)
  }

  commit(key: string, messageId: string): void {
    const entry = { messageId, at: this.now() }
    this.done.set(key, entry)
    this.evict()
    const running = this.inflight.get(key)
    if (running) {
      this.inflight.delete(key)
      for (const waiter of running.waiters) waiter(entry)
    }
  }

  abort(key: string): void {
    const running = this.inflight.get(key)
    if (!running) return
    this.inflight.delete(key)
    for (const waiter of running.waiters) waiter(null)
  }

  private evict(): void {
    if (this.done.size <= this.options.limit) return
    const at = this.now()
    for (const [key, entry] of this.done) {
      if (at - entry.at > this.options.ttlMs) this.done.delete(key)
    }
    while (this.done.size > this.options.limit) {
      const oldest = this.done.keys().next()
      if (oldest.done) break
      this.done.delete(oldest.value)
    }
  }

  size(): number {
    return this.done.size
  }

  inflightSize(): number {
    return this.inflight.size
  }
}
