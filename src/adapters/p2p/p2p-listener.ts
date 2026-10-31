import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertBindHost } from '../../config.js'
import type { DedupeTable } from './p2p-dedupe.js'
import type { ChannelStats } from '../../channel-stats.js'
import { STATUS_ROUTE, hasForwardingHeaders, isLoopbackPeer } from './p2p-status.js'
import { MAX_BODY_BYTES, P2P_ROUTE, handleMessage, parseRequest } from './p2p-protocol.js'
import type { HandleResult, P2PConfig, P2PPayload } from './p2p-protocol.js'
import type { InboundRequest } from './p2p-wire.js'

export const DEFAULT_HOST = '127.0.0.1'

export const DEFAULT_PORT = 7123

export const SIGNATURE_HEADER = 'x-p2p-signature'

export interface ListenerConfig extends P2PConfig {
  listen: { host?: string; port?: number }
}

/** Checks the bind address before anything touches the network. */
export function checkListenerConfig(config: ListenerConfig): string {
  const host = config.listen.host ?? DEFAULT_HOST
  assertBindHost(host, ['listen', 'host'])
  if (!config.peers.length) throw new Error('p2p: at least one peer secret is required to start')
  return host
}

function readBody(request: IncomingMessage, limit: number): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const settle = (value: { ok: true; text: string } | { ok: false }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        chunks.length = 0
        settle({ ok: false })
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') }))
    request.on('error', () => settle({ ok: false }))
  })
}

function readSignature(request: IncomingMessage): string | null {
  const header = request.headers[SIGNATURE_HEADER]
  const value = Array.isArray(header) ? header[0] : header
  return value ?? null
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  response.end(text)
}

export interface ListenerOptions {
  config: ListenerConfig
  table: DedupeTable
  /** Runs after the dedupe claim and must return before the turn finishes.
   * A 200 means accepted, not completed. */
  onMessage?: (request: InboundRequest) => void | Promise<void>
  /** Receives a rejected asynchronous hand off so it never becomes a crash. */
  onError?: (error: unknown, request: InboundRequest) => void
  /** Collects what this channel can report about itself. */
  stats?: ChannelStats | undefined
  /** Answers a loopback only status read; absent means the route does not exist. */
  status?: { route?: string | undefined; report: () => unknown } | undefined
}

export interface Listener {
  /** Bound address once listening. */
  address(): AddressInfo
  /** Stops accepting connections and resolves once closed. */
  close(): Promise<void>
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>
}

/** Starts the self hosted peer listener on the configured address. */
export async function startListener(options: ListenerOptions): Promise<Listener> {
  const host = checkListenerConfig(options.config)
  const port = options.config.listen.port ?? DEFAULT_PORT
  const limit = options.config.maxBodyBytes ?? MAX_BODY_BYTES

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const status = options.status
    if (status !== undefined && request.method === 'GET' && request.url === (status.route ?? STATUS_ROUTE)) {
      if (!isLoopbackPeer(request.socket.remoteAddress) || hasForwardingHeaders(request.headers)) {
        options.stats?.unknownPath()
        send(response, 404, { error: 'not found' })
        return
      }
      send(response, 200, status.report())
      return
    }
    if (request.method !== 'POST' || request.url !== P2P_ROUTE) {
      options.stats?.unknownPath()
      send(response, 404, { error: 'not found' })
      return
    }
    const raw = await readBody(request, limit)
    let payload: P2PPayload
    if (!raw.ok) {
      options.stats?.rejected('body exceeds the size limit')
      send(response, 413, { error: 'body exceeds the size limit' })
      return
    }
    try {
      payload = JSON.parse(raw.text) as P2PPayload
    } catch {
      options.stats?.rejected('body must be valid json')
      send(response, 400, { error: 'body must be valid json' })
      return
    }
    const claimed = typeof payload.instance === 'string' ? payload.instance : ''
    const onMessage = options.onMessage
    let result: HandleResult
    try {
      result = await handleMessage({
        config: options.config,
        table: options.table,
        auth: {
          signature: readSignature(request),
          claimedInstance: claimed,
        },
        payload,
        ...(options.stats === undefined ? {} : { stats: options.stats }),
        ...(onMessage === undefined
          ? {}
          : {
              process: (eventId: string): Promise<boolean> => {
                const parsed = parseRequest(payload, limit)
                if (parsed.ok && parsed.value.eventId === eventId) {
                  const request = parsed.value
                  const dispatched = onMessage(request)
                  if (dispatched instanceof Promise) {
                    void dispatched.catch((error: unknown) => {
                      const report = options.onError
                      if (report === undefined) return
                      void Promise.resolve()
                        .then(() => report(error, request))
                        .catch(() => undefined)
                    })
                  }
                }
                return Promise.resolve(true)
              },
            }),
      })
    } catch (error) {
      options.stats?.rejected(error instanceof Error ? error.message : 'internal error')
      send(response, 500, { error: error instanceof Error ? error.message : 'internal error' })
      return
    }
    if (result.status !== 200) options.stats?.rejected(result.body.error)
    send(response, result.status, result.body)
  }

  const server: Server = createServer((request, response) => {
    void handle(request, response)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  }).catch((error: unknown) => {
    options.stats?.failed(error instanceof Error ? error.message : String(error))
    throw error
  })
  options.stats?.listening((server.address() as AddressInfo).port)

  return {
    address: () => server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            options.stats?.failed(error.message)
            reject(error)
            return
          }
          options.stats?.closed()
          resolve()
        })
      }),
    handle,
  }
}
