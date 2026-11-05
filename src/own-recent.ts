export const OWN_RECENT_WINDOW = 10
export const OWN_RECENT_TTL_MS = 10 * 60_000
export const OWN_RECENT_MAX = 4096

interface Reading {
  spoke: boolean
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

  #store(key: string, reading: Reading): void {
    this.#readings.delete(key)
    this.#readings.set(key, reading)
    while (this.#readings.size > OWN_RECENT_MAX) {
      const oldest = this.#readings.keys().next()
      if (oldest.done === true) break
      this.#readings.delete(oldest.value)
    }
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
    const fresh: Reading = { spoke: false, count: 0, at }
    this.#store(key, fresh)
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
    reading.spoke = true
    reading.count = 0
    reading.at = this.#now()
  }

  /** Whether the bot spoke here recently and few messages arrived since. */
  recent(channel: string, session: string): boolean {
    const reading = this.#read(channel, session)
    return reading.spoke && reading.count < OWN_RECENT_WINDOW
  }

  /** A send that only names the channel and its target resets every session that answers to it. */
  resetTarget(channel: string, target: string): void {
    const prefix = `${channel}|`
    const suffix = `|${target}`
    const at = this.#now()
    let named = false
    for (const [key, reading] of [...this.#readings]) {
      if (!key.startsWith(prefix) || !key.endsWith(suffix)) continue
      named = true
      reading.spoke = true
      reading.count = 0
      reading.at = at
      this.#store(key, reading)
    }
    if (!named) this.#store(this.#key(channel, target), { spoke: true, count: 0, at })
  }
}
