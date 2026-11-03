import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConfigError } from '../src/config.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { instancePort } from './ports.js'
import { P2PAdapter } from '../src/adapters/p2p/adapter.js'
import type { P2PAdapterConfig } from '../src/adapters/p2p/adapter.js'
import { sendToPeer } from '../src/adapters/p2p/p2p-send.js'
import { DedupeTable } from '../src/adapters/p2p/p2p-dedupe.js'
import { startListener } from '../src/adapters/p2p/p2p-listener.js'
import type { InboundRequest } from '../src/adapters/p2p/p2p-wire.js'
import type { AdapterPorts, InboundMessage } from '../src/contract.js'

const REF = '{{SECRET_7k3mwq8t}}'
const credentials = staticCredentials({ [REF]: 'shared-value' })

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the adapter')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function config(port: number): P2PAdapterConfig {
  return {
    channel: 'p2p:b',
    instance: 'inst-b',
    botName: 'bot-b',
    peers: [{ instance: 'inst-a', secret: REF }],
    listen: { host: '127.0.0.1', port },
  }
}

const stops: (() => Promise<void>)[] = []

afterEach(async () => {
  while (stops.length > 0) await stops.pop()?.()
})

describe('the p2p adapter checks what it takes from a profile', () => {
  test('an in-flight window that is not above the turn ceiling is refused', () => {
    const adapter = new P2PAdapter({ ...config(7123), inflightTtlMs: 60_000 })
    expect(() => adapter.checkConfig({ maxTurnMs: 120_000 })).toThrow(ConfigError)
    expect(() => adapter.checkConfig({ maxTurnMs: 120_000 })).toThrow(/inflightTtlMs must exceed maxTurnMs/)
  })

  test('an adapter with no peers is refused', () => {
    const adapter = new P2PAdapter({ ...config(7123), peers: [] })
    expect(() => adapter.checkConfig({ maxTurnMs: 120_000 })).toThrow(/at least one peer/)
  })

  test('a window of zero milliseconds is refused', () => {
    const adapter = new P2PAdapter({ ...config(7123), sentAtWindowMs: 0 })
    expect(() => adapter.checkConfig({ maxTurnMs: 120_000 })).toThrow(/sentAtWindowMs/)
  })
})

describe('the p2p adapter owns its own keys and addresses', () => {
  const adapter = new P2PAdapter(config(7123))

  test('names the scope of its session keys without core parsing them', () => {
    expect(adapter.sessionScope('p2p:inst-a')).toBe('p2p')
    expect(adapter.sessionScope('group:1')).toBeUndefined()
  })

  test('a session key names a configured peer', () => {
    expect(adapter.checkSessionKey('p2p:inst-a')).toBeUndefined()
    expect(adapter.checkSessionKey('p2p:inst-z')).toMatch(/addresses no peer "inst-z"/)
    expect(adapter.checkSessionKey('group:42')).toMatch(/starts with "p2p:"/)
    expect(adapter.checkSessionKey('p2p:')).toMatch(/names a peer/)
  })

  test('a target names a configured peer and the list is printable', () => {
    expect(adapter.checkTarget('inst-a')).toBeUndefined()
    expect(adapter.checkTarget('inst-z')).toMatch(/addresses no peer/)
    expect(adapter.describeTargets()).toBe('inst-a')
  })

  test('the status is the shipped adapter shape', () => {
    const status = adapter.status()
    expect(status).toMatchObject({ channel: 'p2p:b', account: 'inst-b', bot: 'bot-b' })
    expect(status.health).toMatchObject({ kind: 'listener', listenState: 'stopped' })
    expect(status.capabilities.text).toBe(true)
    expect(status.capabilities.reply).toBe(true)
  })

  test('the guidance it hands core is the peer text', () => {
    expect(adapter.guidance.peer).toMatch(/peer message/)
    expect(adapter.guidance.group).toMatch(/group chat/)
  })
})

describe('the p2p adapter carries a message through the contract', () => {
  test('an accepted message arrives with its own key, address and source', async () => {
    const adapter = new P2PAdapter(config(0))
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const seen: InboundMessage[] = []
    const handle = await adapter.start({
      onMessage: async (message) => {
        seen.push(message)
        return { ok: true }
      },
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    const port = instancePort(adapter)

    const sent = await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-b',
      body: 'hello',
      eventId: 'evt-adapter-1',
      sender: 'bot-a',
      instance: 'inst-a',
    })
    expect(sent.ok).toBe(true)

    await waitFor(() => seen.length > 0)
    const message = seen[0]!
    expect(message.sessionKey).toBe('p2p:inst-a')
    expect(message.replyTarget).toBe('inst-a')
    expect(message.source).toMatchObject({ kind: 'p2p', instance: 'inst-a', scope: 'p2p' })
    expect(message.author.senderId).toBe('bot-a')
    expect(message.body.text).toContain('[p2p from inst-a')
    expect(message.eventKey.endsWith('evt-adapter-1')).toBe(true)
  })

  test('a refusal from core is reported and does not throw', async () => {
    const warnings: string[] = []
    const adapter = new P2PAdapter(config(0), { warn: (line) => warnings.push(line) })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: false, code: 'session_key_invalid', reason: 'not for this turn' }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    const port = instancePort(adapter)

    await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-b',
      body: 'hello',
      eventId: 'evt-adapter-2',
      sender: 'bot-a',
      instance: 'inst-a',
    })

    await waitFor(() => warnings.length > 0)
    expect(warnings[0]).toMatch(/kept evt-adapter-2 from inst-a out of a turn: session_key_invalid/)
  })
})

describe('the replay window a restart reopens', () => {
  test('a message replayed after a restart is accepted again, under a new epoch', async () => {
    let clock = 1_700_000_000_000
    const seen: string[] = []
    const ports: AdapterPorts = {
      onMessage: async (message) => {
        seen.push(message.requestId)
        return { ok: true }
      },
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    }
    const send = (port: number) =>
      sendToPeer({
        peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
        credentials,
        to: 'bot-b',
        body: 'hello',
        eventId: 'evt-replay-1',
        sender: 'bot-a',
        instance: 'inst-a',
      })

    const first = new P2PAdapter(config(0), { now: () => clock })
    first.checkConfig({ maxTurnMs: 120_000 })
    const firstHandle = await first.start(ports)
    stops.push(firstHandle.stop)
    const epochA = first.status().dedupe?.epoch

    expect(await send(instancePort(first))).toMatchObject({ ok: true, duplicate: false })
    expect(await send(instancePort(first))).toMatchObject({ ok: true, duplicate: true })
    expect(seen).toEqual(['evt-replay-1'])
    expect(first.status().health).toMatchObject({ lastSkewMs: expect.any(Number) })

    clock += 1_000
    const second = new P2PAdapter(config(0), { now: () => clock })
    second.checkConfig({ maxTurnMs: 120_000 })
    const secondHandle = await second.start(ports)
    stops.push(secondHandle.stop)
    const epochB = second.status().dedupe?.epoch

    expect(await send(instancePort(second))).toMatchObject({ ok: true, duplicate: false })
    expect(seen).toEqual(['evt-replay-1', 'evt-replay-1'])
    expect(typeof epochA).toBe('number')
    expect(typeof epochB).toBe('number')
    expect(epochB).not.toBe(epochA)
  })

  test('a stale message leaves a count in the status, once per instance', async () => {
    const warnings: string[] = []
    const adapter = new P2PAdapter(config(0), { warn: (line) => warnings.push(line) })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    const port = instancePort(adapter)
    const stale = Date.now() - 400_000
    const staleTo = (eventId: string) =>
      sendToPeer({
        peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
        credentials,
        to: 'bot-b',
        body: 'hello',
        eventId,
        sender: 'bot-a',
        instance: 'inst-a',
        sentAt: stale,
      })

    expect(await staleTo('evt-stale-1')).toMatchObject({ ok: false })
    expect(await staleTo('evt-stale-2')).toMatchObject({ ok: false })

    expect(warnings).toHaveLength(1)
    expect(adapter.status().counters.staleSentAt).toEqual({ 'inst-a': 2 })
    expect(adapter.status().health).toMatchObject({ lastSkewMs: expect.any(Number) })
  })
})

describe('the event key the adapter builds', () => {
  const adapter = new P2PAdapter(config(7123))

  test('does not depend on the chain root', () => {
    const base = {
      eventId: 'evt-key-1',
      to: 'bot-b',
      sender: 'bot-a',
      instance: 'inst-a',
      body: 'hello',
      sentAt: 1_700_000_000_000,
    }
    const first = adapter.toInbound({ ...base, chainId: 'evt-key-1' })
    const second = adapter.toInbound({ ...base, chainId: 'some-other-root' })
    expect(second.eventKey).toBe(first.eventKey)
    expect(second.chainId).toBe('some-other-root')
  })
})

describe('the p2p adapter tells a peer it was refused', () => {
  test('the refusal is deterministic, empty, and carries the chain it answers', async () => {
    const posted: Record<string, unknown>[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-x' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const adapter = new P2PAdapter({
      channel: 'p2p:b',
      instance: 'inst-b',
      botName: 'bot-b',
      peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-a' }],
      listen: { host: '127.0.0.1', port: 0 },
    })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    stops.push(async () => {
      capture.close()
    })

    const refused = await adapter.refuse({
      target: 'inst-a',
      inReplyTo: 'evt-42',
      chainId: 'evt-42',
      reason: 'policy',
      note: 'no',
    })

    expect(refused).toEqual({ ok: true })
    expect(posted[0]).toMatchObject({
      eventId: 'decline:evt-42',
      chainId: 'evt-42',
      status: 'declined',
      final: true,
      body: 'no',
      reason: 'policy',
    })
    expect('media' in (posted[0] ?? {})).toBe(false)
  })

  test('a refusal reaches a real listener, which takes the note as its body', async () => {
    const received: InboundRequest[] = []
    const listener = await startListener({
      config: {
        botName: 'bot-a',
        peers: [{ instance: 'inst-b', secret: REF }],
        credentials,
        inflightTtlMs: 300_000,
        maxBodyBytes: 64 * 1024,
        listen: { host: '127.0.0.1', port: 0 },
      },
      table: new DedupeTable({ ttlMs: 1000, limit: 10, inflightTtlMs: 300_000, maxTurnMs: 120_000 }),
      onMessage: (request) => {
        received.push(request)
      },
    })
    const adapter = new P2PAdapter({
      channel: 'p2p:b',
      instance: 'inst-b',
      botName: 'bot-b',
      peers: [
        {
          instance: 'inst-a',
          secret: REF,
          url: `http://127.0.0.1:${listener.address().port}`,
          botName: 'bot-a',
        },
      ],
      listen: { host: '127.0.0.1', port: 0 },
    })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(async () => {
      await handle.stop()
    })
    stops.push(async () => {
      await listener.close()
    })

    const refused = await adapter.refuse({
      target: 'inst-a',
      inReplyTo: 'evt-rt-1',
      chainId: 'evt-rt-1',
      reason: 'too-busy',
      note: 'later please',
    })
    await adapter.refuse({ target: 'inst-a', inReplyTo: 'evt-rt-2', chainId: 'evt-rt-2', reason: 'policy' })

    expect(refused).toEqual({ ok: true })
    await waitFor(() => received.length === 2)
    expect(received[0]).toMatchObject({
      eventId: 'decline:evt-rt-1',
      chainId: 'evt-rt-1',
      status: 'declined',
      final: true,
      reason: 'too-busy',
      body: 'later please',
    })
    expect(received[1]).toMatchObject({ status: 'declined', reason: 'policy', body: 'declined' })
  })
})

describe('the p2p adapter sends through its own addressing', () => {
  test('a send reaches the configured peer url with the contract fields', async () => {
    const posted: Record<string, unknown>[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-x' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const adapter = new P2PAdapter({
      channel: 'p2p:b',
      instance: 'inst-b',
      botName: 'bot-b',
      peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}` }],
      listen: { host: '127.0.0.1', port: 0 },
    })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    stops.push(async () => {
      capture.close()
    })

    const sent = await adapter.send({
      target: 'inst-a',
      to: 'bot-a',
      eventId: 'evt-out-1',
      body: 'reply text',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    expect(sent.ok).toBe(true)
    expect(posted[0]).toMatchObject({ eventId: 'evt-out-1', to: 'bot-a', body: 'reply text' })

    const unknown = await adapter.send({
      target: 'inst-z',
      eventId: 'evt-out-2',
      body: 'x',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.code).toBe('no_url')
  })
})

describe('the reason a refusal carries', () => {
  test('the wire carries the chosen reason, bounded and on one line', async () => {
    const posted: Record<string, unknown>[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-x' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port
    const adapter = new P2PAdapter({
      channel: 'p2p:b',
      instance: 'inst-b',
      botName: 'bot-b',
      peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-a' }],
      listen: { host: '127.0.0.1', port: 0 },
    })
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    stops.push(async () => {
      capture.close()
    })

    await adapter.refuse({
      target: 'inst-a',
      inReplyTo: 'evt-9',
      chainId: 'evt-9',
      reason: 'too-busy',
      note: `later${'x'.repeat(250)}\nplease`,
    })

    expect(posted[0]?.reason).toBe('too-busy')
    const body = posted[0]?.body as string
    expect(body).toHaveLength(200)
    expect(body.startsWith('later')).toBe(true)
    expect(body).not.toMatch(/\s{2,}|\n/)
  })
})

describe('what the adapter can carry', () => {
  test('it declares text and replies at mount time, and the status agrees', () => {
    const adapter = new P2PAdapter(config(7123))

    expect(adapter.capabilities).toMatchObject({
      text: true,
      reply: true,
      image: { in: true, out: true, fromUrl: true, fromHandle: false },
      mention: false,
    })
    expect(adapter.status().capabilities).toEqual(adapter.capabilities)
  })
})

describe('media in the adapter', () => {
  const adapter = new P2PAdapter({
    channel: 'p2p:b',
    instance: 'inst-b',
    botName: 'bot-b',
    peers: [{ instance: 'inst-a', secret: REF }],
    listen: { host: '127.0.0.1', port: 0 },
  })

  const wire = {
    eventId: 'evt-media',
    chainId: 'evt-media',
    to: 'bot-b',
    sender: 'bot-a',
    instance: 'inst-a',
    body: '',
    media: [['image', 'https://example.test/a.png']] as const,
    sentAt: 1_700_000_000_000,
  }

  test('an inbound message keeps the media and gets the owner stamped', () => {
    const message = adapter.toInbound({ ...wire, media: [['image', 'https://example.test/a.png']] })
    expect(message.body.media).toEqual([
      { type: 'image', url: 'https://example.test/a.png', handle: null, owner: { kind: 'p2p', instance: 'inst-a' } },
    ])
  })

  test('media changes the content hash of an otherwise empty message', () => {
    const withMedia = adapter.toInbound({ ...wire, media: [['image', 'https://example.test/a.png']] })
    const without = adapter.toInbound({ ...wire, body: '', media: [] })
    expect(withMedia.body.text).toBe(without.body.text)
    expect(withMedia.eventKey).toBe(without.eventKey)
  })
})

describe('media a peer could not receive', () => {
  const warned: string[] = []

  async function adapterWithCapture(): Promise<{ adapter: P2PAdapter; posted: Record<string, unknown>[]; close: () => void }> {
    const posted: Record<string, unknown>[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-x' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port
    const adapter = new P2PAdapter(
      {
        channel: 'p2p:b',
        instance: 'inst-b',
        botName: 'bot-b',
        peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-a' }],
        listen: { host: '127.0.0.1', port: 0 },
      },
      { warn: (line) => warned.push(line) },
    )
    adapter.checkConfig({ maxTurnMs: 120_000 })
    const handle = await adapter.start({
      onMessage: async () => ({ ok: true }),
      resolveSecret: (ref) => Promise.resolve(credentials.resolve(ref).then((one) => one?.value)),
    })
    stops.push(handle.stop)
    stops.push(async () => {
      capture.close()
    })
    return { adapter, posted, close: () => capture.close() }
  }

  test('a handle and a plain url are dropped with one warning', async () => {
    const { adapter, posted } = await adapterWithCapture()
    const result = await adapter.send({
      target: 'inst-a',
      eventId: 'evt-drop',
      body: 'text',
      media: [
        { type: 'image', url: null, handle: 'ab12.image' },
        { type: 'image', url: 'not-a-url', handle: null },
      ],
      sender: 'bot-a',
      instance: 'inst-b',
    })
    expect(result.ok).toBe(true)
    expect(posted[0]).not.toHaveProperty('media')
    const lines = warned.filter((line) => line.includes('dropped'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('dropped 2 media item(s) from evt-drop')
  })

  test('nothing left to send fails here, before the peer could refuse it', async () => {
    const { adapter, posted } = await adapterWithCapture()
    const result = await adapter.send({
      target: 'inst-a',
      eventId: 'evt-dead',
      body: '',
      media: [{ type: 'image', url: null, handle: 'ab12.image' }],
      sender: 'bot-a',
      instance: 'inst-b',
    })
    expect(result).toMatchObject({ ok: false, code: 'no_url' })
    expect(posted).toHaveLength(0)
  })
})
