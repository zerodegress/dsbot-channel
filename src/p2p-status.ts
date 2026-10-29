import type { ChannelSnapshot } from './channel-stats.js'

export const STATUS_ROUTE = '/p2p/v1/status'

export interface AdapterReport {
  channel: string
  bot: string
  instance: string
  snapshot: ChannelSnapshot
}

export interface StatusReport {
  sampledAt: number
  adapters: AdapterReport[]
}

/** Collects one report per channel so a reader sees every adapter at once. */
export class StatusRegistry {
  readonly #reports = new Map<string, () => AdapterReport>()

  register(channel: string, report: () => AdapterReport): () => void {
    this.#reports.set(channel, report)
    return () => {
      if (this.#reports.get(channel) === report) this.#reports.delete(channel)
    }
  }

  clear(): void {
    this.#reports.clear()
  }

  snapshot(now: () => number = Date.now): StatusReport {
    return { sampledAt: now(), adapters: [...this.#reports.values()].map((report) => report()) }
  }
}

/** True when a forwarder rewrote the request, so its origin is not this host. */
export function hasForwardingHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  for (const name of ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip']) {
    if (headers[name] !== undefined) return true
  }
  return false
}

/** True only for an address the operating system reports as loopback. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (address === undefined) return false
  const plain = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  if (plain === '::1') return true
  return /^127\./.test(plain)
}
