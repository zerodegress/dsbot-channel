import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DedupeTable } from '../src/p2p-dedupe.js'
import { startListener } from '../src/p2p-listener.js'
import type { Listener } from '../src/p2p-listener.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import { sendToPeer } from '../src/p2p-send.js'

const REF = '{{SECRET_dgntdkke}}'
const SECRET = 'shared-value'
const credentials = staticCredentials({ [REF]: SECRET })

const listeners: Listener[] = []
const servers: Server[] = []

afterEach(async () => {
  while (listeners.length) await listeners.pop()!.close()
  while (servers.length) {
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

async function peer(options: { peerInstance?: string; botName?: string; waitMs?: number } = {}): Promise<{ url: string }> {
  const listener = await startListener({
    table: new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 }),
    config: {
      botName: options.botName ?? 'remote-bot',
      peers: [{ instance: options.peerInstance ?? 'sender-inst', secret: REF }],
      credentials,
      inflightTtlMs: 300_000,
      maxBodyBytes: 64 * 1024,
      waitMs: options.waitMs ?? 1000,
      listen: { host: '127.0.0.1', port: 0 },
    },
  })
  listeners.push(listener)
  const address = listener.address()
  return { url: `http://127.0.0.1:${address.port}` }
}

const base = (url: string) => ({
  peer: { instance: 'remote-inst', secret: REF, url },
  credentials,
  to: 'remote-bot',
  body: 'hello',
  eventId: 'evt-1',
  sender: 'sender-bot',
  instance: 'sender-inst',
})

describe('sending a message', () => {
  test('a signed message reaches the peer and returns its messageId', async () => {
    const { url } = await peer()
    const result = await sendToPeer(base(url))
    expect(result).toMatchObject({ ok: true, messageId: 'p2p-evt-1', duplicate: false })
  })

  test('the signature path works, no bearer token is needed', async () => {
    const { url } = await peer()
    const result = await sendToPeer(base(url))
    expect(result.ok).toBe(true)
  })

  test('retrying the same eventId is reported as a duplicate', async () => {
    const { url } = await peer()
    const first = await sendToPeer(base(url))
    const second = await sendToPeer(base(url))
    expect(first).toMatchObject({ ok: true, duplicate: false })
    expect(second).toMatchObject({ ok: true, duplicate: true, messageId: 'p2p-evt-1' })
  })
})

describe('failures are told apart', () => {
  test('a reference that does not resolve is a local credential problem', async () => {
    const { url } = await peer()
    const empty = staticCredentials({})
    const result = await sendToPeer({ ...base(url), credentials: empty })
    expect(result).toMatchObject({ ok: false, code: 'credential', retryable: false })
    expect((result as { reason: string }).reason).toMatch(/did not resolve/)
  })

  test('a blank reference value is also a credential problem, not a network one', async () => {
    const { url } = await peer()
    const blank = staticCredentials({ [REF]: '   ' })
    const result = await sendToPeer({ ...base(url), credentials: blank })
    expect(result).toMatchObject({ ok: false, code: 'credential', retryable: false })
    expect((result as { reason: string }).reason).toMatch(/blank value/)
  })

  test('a peer without a url cannot be reached and says so', async () => {
    const result = await sendToPeer({ ...base('http://127.0.0.1:1'), peer: { instance: 'remote-inst', secret: REF } })
    expect(result).toMatchObject({ ok: false, code: 'no_url', retryable: false })
  })

  test('a closed port is unreachable', async () => {
    const { url } = await peer()
    await listeners.pop()!.close()
    const result = await sendToPeer(base(url))
    expect(result).toMatchObject({ ok: false, code: 'unreachable', retryable: true })
  })

  test('the wrong secret is unauthorized', async () => {
    const { url } = await peer()
    const wrong = staticCredentials({ [REF]: 'not-the-value' })
    const result = await sendToPeer({ ...base(url), credentials: wrong })
    expect(result).toMatchObject({ ok: false, code: 'unauthorized', retryable: false })
  })

  test('a mismatched sender instance is forbidden', async () => {
    const { url } = await peer({ peerInstance: 'someone-else' })
    const result = await sendToPeer(base(url))
    expect(result).toMatchObject({ ok: false, code: 'forbidden', retryable: false })
  })

  test('a body addressed to another bot is forbidden', async () => {
    const { url } = await peer({ botName: 'other-bot' })
    const result = await sendToPeer(base(url))
    expect(result).toMatchObject({ ok: false, code: 'forbidden' })
  })

  test('a peer answering 503 is busy and retryable', async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(503, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'the first delivery is still being processed' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    const result = await sendToPeer(base(`http://127.0.0.1:${address.port}`))
    expect(result).toMatchObject({ ok: false, code: 'busy', retryable: true })
  })

  test('a slow peer is reported as a timeout, and it is retryable', async () => {
    const fetchImpl = (): Promise<Response> => {
      const error = new Error('timed out')
      error.name = 'TimeoutError'
      return Promise.reject(error)
    }
    const result = await sendToPeer({ ...base('http://127.0.0.1:1'), timeoutMs: 1, fetchImpl: fetchImpl as never })
    expect(result).toMatchObject({ ok: false, code: 'timeout', retryable: true })
  })
})
