import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { assertBindHost } from './config.js'
import type { DedupeTable } from './p2p-dedupe.js'
import { MAX_BODY_BYTES, P2P_ROUTE, handleMessage } from './p2p-protocol.js'
import type { HandleResult, P2PConfig, P2PPayload } from './p2p-protocol.js'

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
  process?: (eventId: string) => Promise<boolean>
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
    if (request.method !== 'POST' || request.url !== P2P_ROUTE) {
      send(response, 404, { error: 'not found' })
      return
    }
    const raw = await readBody(request, limit)
    let payload: P2PPayload
    if (!raw.ok) {
      send(response, 413, { error: 'body exceeds the size limit' })
      return
    }
    try {
      payload = JSON.parse(raw.text) as P2PPayload
    } catch {
      send(response, 400, { error: 'body must be valid json' })
      return
    }
    const claimed = typeof payload.instance === 'string' ? payload.instance : ''
    let result: HandleResult
    try {
      result = await handleMessage({
        config: options.config,
        table: options.table,
        auth: {
          authorization: request.headers.authorization ?? null,
          signature: readSignature(request),
          claimedInstance: claimed,
        },
        payload,
        ...(options.process ? { process: options.process } : {}),
      })
    } catch (error) {
      send(response, 500, { error: error instanceof Error ? error.message : 'internal error' })
      return
    }
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
  })

  return {
    address: () => server.address() as AddressInfo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
    handle,
  }
}
