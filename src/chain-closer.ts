export const CHAIN_TTL_MS = 60 * 60 * 1000

/** Remembers which conversations were closed, keyed by the chain root the adapter supplies. */
export class ClosedChains {
  readonly #closed = new Map<string, number>()
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: { now?: (() => number) | undefined; ttlMs?: number | undefined } = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? CHAIN_TTL_MS
  }

  close(chainId: string): string {
    this.#sweep()
    this.#closed.set(chainId, this.#now())
    return chainId
  }

  #sweep(): void {
    const now = this.#now()
    for (const [key, at] of this.#closed) {
      if (now - at >= this.#ttlMs) this.#closed.delete(key)
    }
  }

  isClosed(chainId: string): boolean {
    const at = this.#closed.get(chainId)
    if (at === undefined) return false
    if (this.#now() - at >= this.#ttlMs) {
      this.#closed.delete(chainId)
      return false
    }
    return true
  }

  get size(): number {
    return this.#closed.size
  }

  clear(): void {
    this.#closed.clear()
  }
}
