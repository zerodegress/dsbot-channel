export const OWN_RECENT_WINDOW = 10
export const OWN_RECENT_TTL_MS = 10 * 60_000
export const OWN_RECENT_MAX = 4096

interface Reading {
  count: number
  at: number
}

/** Counts the messages since this bot last spoke in a conversation. */
export class OwnRecent {
  readonly #readings = new Map<string, Reading>()
  readonly #now: () => number

  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  #key(channel: string, session: string): string {
    return `${channel}|${session}`
  }

  #read(channel: string, session: string): Reading {
    const key = this.#key(channel, session)
    const seen = this.#readings.get(key)
    const at = this.#now()
    if (seen !== undefined && at - seen.at <= OWN_RECENT_TTL_MS) {
      this.#readings.delete(key)
      this.#readings.set(key, seen)
      return seen
    }
    const fresh: Reading = { count: 0, at }
    this.#readings.delete(key)
    this.#readings.set(key, fresh)
    while (this.#readings.size > OWN_RECENT_MAX) {
      const oldest = this.#readings.keys().next()
      if (oldest.done === true) break
      this.#readings.delete(oldest.value)
    }
    return fresh
  }

  /** One more accepted inbound message; the reading includes it. */
  touch(channel: string, session: string): void {
    const reading = this.#read(channel, session)
    reading.count += 1
    reading.at = this.#now()
  }

  /** This bot spoke here, so the window starts again. */
  reset(channel: string, session: string): void {
    const reading = this.#read(channel, session)
    reading.count = 0
    reading.at = this.#now()
  }

  /** Whether the bot spoke within the last few messages of this conversation. */
  recent(channel: string, session: string): boolean {
    return this.#read(channel, session).count < OWN_RECENT_WINDOW
  }

  /** A send that only names the channel and its target resets every session that answers to it. */
  resetTarget(channel: string, target: string): void {
    const prefix = `${channel}|`
    const suffix = `|${target}`
    for (const key of [...this.#readings.keys()]) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
      this.#readings.delete(key)
    }
  }
}
