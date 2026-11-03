import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'

/** A port the OS just said was free; binding is still the caller's race to lose. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

/** Two distinct ports, so a pair never shares the one it just released. */
export async function freePortPair(): Promise<[number, number]> {
  for (;;) {
    const first = await freePort()
    const second = await freePort()
    if (first !== second) return [first, second]
  }
}

/** Aggregate errors carry their reasons in `errors`, not `cause`; those are never retried. */
function codeOf(error: unknown): string | undefined {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

function report(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/**
 * Re-tries a test mount when the probe port was taken between close and bind.
 * Only EADDRINUSE is caught; this compensates that window, it does not retry assertions.
 */
export async function withPortRetry<T>(
  ports: () => Promise<[number, number]>,
  run: (pair: [number, number]) => Promise<T>,
): Promise<T> {
  const attempts: { ports: [number, number]; error: string }[] = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const pair = await ports()
    try {
      return await run(pair)
    } catch (error) {
      attempts.push({ ports: pair, error: report(error) })
      if (codeOf(error) !== 'EADDRINUSE') throw error
    }
  }
  throw new Error(`mount kept hitting a busy port: ${JSON.stringify(attempts)}`)
}

interface StatusLike {
  snapshot(): { adapters: { channel: string; health: { boundPort: number | null } }[] }
}

/** The port an adapter actually bound, read back from the status service. */
export function boundPort(ctx: Context, channel: string): number {
  const service = ctx.get('dsbot-channel.status') as StatusLike | undefined
  const entry = service?.snapshot().adapters.find((adapter) => adapter.channel === channel)
  const port = entry?.health.boundPort
  if (typeof port !== 'number') throw new Error(`adapter "${channel}" reports no bound port`)
  return port
}

/** Every adapter's actual port, for a failure message that has to name them. */
export function adapterPorts(ctx: Context): string {
  const service = ctx.get('dsbot-channel.status') as StatusLike | undefined
  const entries = service?.snapshot().adapters ?? []
  if (entries.length === 0) return 'no adapters'
  return entries.map((entry) => `${entry.channel}=${entry.health.boundPort ?? 'n/a'}`).join(', ')
}

/** The port an adapter instance actually bound. */
export function instancePort(adapter: { status(): { health: unknown } }): number {
  const port = (adapter.status().health as { boundPort?: unknown }).boundPort
  if (typeof port !== 'number') throw new Error('adapter reports no bound port')
  return port
}
