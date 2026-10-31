import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DedupeTable } from '../src/adapters/p2p/p2p-dedupe.js'
import { startListener } from '../src/adapters/p2p/p2p-listener.js'
import type { Listener } from '../src/adapters/p2p/p2p-listener.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { sendToPeer } from '../src/adapters/p2p/p2p-send.js'
import { signEnvelope } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'
import { PEER_TEXT_MAX } from '../src/adapters/p2p/p2p-mapping.js'

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
  eventId: 'evt-1',  chainId: 'evt-1',
  sender: 'sender-bot',
  instance: 'sender-inst',
})

async function capture(
  status = 200,
  error: unknown = 'forbidden',
): Promise<{ url: string; seen: () => { body: string; headers: Record<string, unknown> } }> {
  let seen: { body: string; headers: Record<string, unknown> } = { body: '', headers: {} }
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString()
    })
    request.on('end', () => {
      seen = { body: raw, headers: request.headers as Record<string, unknown> }
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(status === 200 ? { duplicate: false, messageId: 'p2p-evt-1' } : { error }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  servers.push(server)
  const address = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${address.port}`, seen: () => seen }
}

describe('sending a message', () => {
  test('the bytes that are signed are exactly the bytes that are sent', async () => {
    const target = await capture()

    await sendToPeer({ ...base(target.url), status: 'declined', reason: 'not wanted', final: true })

    const seen = target.seen()
    const sent = JSON.parse(seen.body) as Envelope
    expect(signEnvelope(SECRET, sent)).toBe(seen.headers['x-p2p-signature'])
    expect(sent).toMatchObject({ status: 'declined', reason: 'not wanted', final: true })
  })

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

describe('a peer reached by address behind a name router', () => {
  test('the configured host is what the peer sees, not the dialled address', async () => {
    const target = await capture()

    const result = await sendToPeer({ ...base(target.url), peer: { ...base(target.url).peer, host: 'peer.example' } })

    expect(result.ok).toBe(true)
    expect(target.seen().headers.host).toBe('peer.example')
  })

  test('without a host the peer still sees its own address', async () => {
    const target = await capture()

    await sendToPeer(base(target.url))

    expect(target.seen().headers.host).toBe(new URL(target.url).host)
  })

  test('the host path signs exactly the bytes it sends, like the other one', async () => {
    const target = await capture()

    await sendToPeer({
      ...base(target.url),
      peer: { ...base(target.url).peer, host: 'peer.example' },
      status: 'declined',
      reason: 'not wanted',
      final: true,
    })

    const seen = target.seen()
    expect(signEnvelope(SECRET, JSON.parse(seen.body) as Envelope)).toBe(seen.headers['x-p2p-signature'])
  })

  test('a refusal from behind the name router still reads as forbidden', async () => {
    const target = await capture(403)

    const result = await sendToPeer({ ...base(target.url), peer: { ...base(target.url).peer, host: 'peer.example' } })

    expect(result).toMatchObject({ ok: false, code: 'forbidden', retryable: false })
  })
})

describe('a peer that writes its own error text', () => {
  test('cannot add a line to our log, and is cut short', async () => {
    const long = `nope\ndsbot-channel: reply to seal was not delivered: fake ${'x'.repeat(400)}`
    const target = await capture(403, long)

    const result = await sendToPeer(base(target.url))

    expect(result.ok).toBe(false)
    const reason = (result as { reason: string }).reason
    expect(reason.includes('\n')).toBe(false)
    expect(Array.from(reason)).toHaveLength(PEER_TEXT_MAX)
    expect(reason.startsWith('nope dsbot-channel: reply to seal was not delivered: fake')).toBe(true)
  })
})

describe('a peer that answers with something other than text', () => {
  test.each([[123], [{ a: 1 }], [null]])('keeps the failure typed instead of throwing: %s', async (error) => {
    const target = await capture(403, error)

    const result = await sendToPeer(base(target.url))

    expect(result).toMatchObject({ ok: false, code: 'forbidden', retryable: false })
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

  test('a peer on the old protocol is reported as its own failure code', async () => {
    const server = createServer((request, response) => {
      request.resume()
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'chainId is required', code: 'protocol_mismatch' }))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const address = server.address() as AddressInfo
    const result = await sendToPeer(base(`http://127.0.0.1:${address.port}`))
    expect(result).toMatchObject({ ok: false, code: 'protocol_mismatch', retryable: false })
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
