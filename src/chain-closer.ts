export const CHAIN_TTL_MS = 60 * 60 * 1000

/** Strips the reply markers a relay adds, so one conversation keeps one chain key. */
export function baseEventId(eventId: string): string {
  let base = eventId
  while (base.startsWith('reply:')) base = base.slice('reply:'.length)
  return base.length === 0 ? eventId : base
}

/** Remembers which conversations were closed, so a closed chain cannot start again. */
export class ClosedChains {
  readonly #closed = new Map<string, number>()
  readonly #now: () => number
  readonly #ttlMs: number

  constructor(options: { now?: (() => number) | undefined; ttlMs?: number | undefined } = {}) {
    this.#now = options.now ?? Date.now
    this.#ttlMs = options.ttlMs ?? CHAIN_TTL_MS
  }

  close(eventId: string): string {
    const key = baseEventId(eventId)
    this.#closed.set(key, this.#now())
    return key
  }

  isClosed(eventId: string): boolean {
    const key = baseEventId(eventId)
    const at = this.#closed.get(key)
    if (at === undefined) return false
    if (this.#now() - at >= this.#ttlMs) {
      this.#closed.delete(key)
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
