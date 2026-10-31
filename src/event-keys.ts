import { createHash } from 'node:crypto'

export const KEY_GUARD_LIMIT = 10_000
export const KEY_GUARD_TTL_MS = 60 * 60 * 1000

export interface KeyGuardOptions {
  limit?: number | undefined
  ttlMs?: number | undefined
  now?: (() => number) | undefined
}

interface Seen {
  hash: string
  at: number
}

/**
 * Refuses a key an adapter reused for different content: the key is the adapter's claim
 * about identity, so a second meaning for it is a broken adapter, not a duplicate.
 */
export class KeyGuard {
  readonly #seen = new Map<string, Seen>()
  readonly #limit: number
  readonly #ttlMs: number
  readonly #now: () => number

  constructor(options: KeyGuardOptions = {}) {
    this.#limit = options.limit ?? KEY_GUARD_LIMIT
    this.#ttlMs = options.ttlMs ?? KEY_GUARD_TTL_MS
    this.#now = options.now ?? Date.now
  }

  /** The problem with this key, or undefined when it is new or names the same content. */
  check(key: string, content: string): string | undefined {
    const hash = createHash('sha256').update(content, 'utf8').digest('hex')
    const at = this.#now()
    const seen = this.#seen.get(key)
    if (seen !== undefined && at - seen.at < this.#ttlMs) {
      if (seen.hash === hash) return undefined
      return `"${key}" already named different content`
    }
    this.#remember(key, hash, at)
    return undefined
  }

  get size(): number {
    return this.#seen.size
  }

  #remember(key: string, hash: string, at: number): void {
    this.#seen.set(key, { hash, at })
    if (this.#seen.size <= this.#limit) return
    for (const [seenKey, seen] of this.#seen) {
      if (at - seen.at >= this.#ttlMs || this.#seen.size > this.#limit) this.#seen.delete(seenKey)
      if (this.#seen.size <= this.#limit) break
    }
  }
}
