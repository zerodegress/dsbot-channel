import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import { sendToPeer } from '../src/p2p-send.js'

const REF = '{{SECRET_4dhhwz2n}}'
const INCOMING = '[p2p from inst-a · bot-a · p2p-evt-1] hello'
const ANSWER = `reply:${INCOMING}`
const ECHOED = `[p2p from inst-b · bot-b · p2p-reply:evt-1] ${ANSWER}`
const credentials = staticCredentials({ [REF]: 'shared-value' })

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port
      server.close(() => resolve(port))
    })
  })
}

interface Prompted {
  sessionId: string
  requestId: string
  text: string
}

const warnings: string[] = []

const loggerStub = {
  warn(message: string) {
    warnings.push(message)
  },
}

class StubSessions {
  readonly prompted: Prompted[] = []
  readonly #ctx: Context
  readonly #replies: number
  #count = 0

  constructor(ctx: Context, replies = 1) {
    this.#ctx = ctx
    this.#replies = replies
  }

  create(): Promise<{ sessionId: string }> {
    this.#count += 1
    return Promise.resolve({ sessionId: `session-${this.#count}` })
  }

  prompt(request: Prompted & { content: readonly { type: 'text'; text: string }[] }): Promise<{ accepted: boolean }> {
    const text = request.content.map((part) => part.text).join('')
    this.prompted.push({ sessionId: request.sessionId, requestId: request.requestId, text })
    const reply = this.prompted.length > this.#replies ? '' : `reply:${text}`
    const emit = (event: unknown): void => {
      this.#ctx.emit('session/event', { id: request.sessionId } as { id: string }, event as never)
    }
    emit({ type: 'turn/start' })
    emit({ type: 'assistant/message', data: { message: { content: reply.length > 0 ? [{ type: 'text', text: reply }] : [] } } })
    emit({ type: 'turn/end' })
    return Promise.resolve({ accepted: true })
  }
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the peer round trip')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const forks: { dispose(): Promise<void> }[] = []

beforeEach(() => {
  warnings.length = 0
})

afterEach(async () => {
  while (forks.length > 0) await forks.pop()?.dispose()
})

describe('two adapters in one process', () => {
  test('a message runs a turn and the reply comes back to the sender', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    const sessions = new StubSessions(ctx)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('logger')
        scope.set('logger', loggerStub)
      },
    })
    const adapter = (channel: string, instance: string, botName: string, peerInstance: string, port: number, peerPort: number) => ({
      channel,
      instance,
      botName,
      peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
      listen: { host: '127.0.0.1', port },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        adapter('p2p:a', 'inst-a', 'bot-a', 'inst-b', portA, portB),
        adapter('p2p:b', 'inst-b', 'bot-b', 'inst-a', portB, portA),
      ],
    })
    forks.push(fork)
    expect(ctx.get('dsbot-channel.peers')).toHaveLength(2)

    const sent = await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${portB}` },
      credentials,
      to: 'bot-b',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-a',
      instance: 'inst-a',
    })
    expect(sent).toMatchObject({ ok: true, duplicate: false })

    await waitFor(() => sessions.prompted.length >= 2)

    expect(sessions.prompted[0]?.text.startsWith('[p2p from inst-a · bot-a · p2p-evt-1] ')).toBe(true)
    expect(sessions.prompted[0]?.text.endsWith(' hello')).toBe(true)
    expect(sessions.prompted[0]?.text).toBe(INCOMING)
    expect(sessions.prompted[0]?.requestId).toBe('evt-1')
    expect(sessions.prompted[1]?.text.startsWith('[p2p from inst-b · bot-b · p2p-reply:evt-1] ')).toBe(true)
    expect(sessions.prompted[1]?.text).toBe(ECHOED)

    await waitFor(() => sessions.prompted.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)

    await fork.dispose()
  })

  test('a peer without a url comes back as no_url instead of silence', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 2)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('logger')
        scope.set('logger', loggerStub)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
          channel: 'p2p:a',
          instance: 'inst-a',
          botName: 'bot-a',
          peers: [{ instance: 'inst-b', secret: REF }],
          listen: { host: '127.0.0.1', port: portA },
        },
        {
          channel: 'p2p:b',
          instance: 'inst-b',
          botName: 'bot-b',
          peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${portA}` }],
          listen: { host: '127.0.0.1', port: portB },
        },
      ],
    })

    await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${portB}` },
      credentials,
      to: 'bot-b',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-a',
      instance: 'inst-a',
    })

    await waitFor(() => warnings.length > 0)
    expect(warnings.some((line) => line.includes('no_url'))).toBe(true)
    expect(warnings.some((line) => line.includes('inst-b'))).toBe(true)
    expect(sessions.prompted.map((entry) => entry.text)).toEqual([INCOMING, ECHOED])
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)

    await fork.dispose()
  })
})

describe('reporting failures', () => {
  test('a logger that throws does not become an unhandled rejection', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 2)
    let attempts = 0
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('logger')
        scope.set('logger', {
          warn() {
            attempts += 1
            throw new Error('logger failed')
          },
        })
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
          channel: 'p2p:a',
          instance: 'inst-a',
          botName: 'bot-a',
          peers: [{ instance: 'inst-b', secret: REF }],
          listen: { host: '127.0.0.1', port: portA },
        },
        {
          channel: 'p2p:b',
          instance: 'inst-b',
          botName: 'bot-b',
          peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${portA}` }],
          listen: { host: '127.0.0.1', port: portB },
        },
      ],
    })
    forks.push(fork)

    await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${portB}` },
      credentials,
      to: 'bot-b',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-a',
      instance: 'inst-a',
    })

    await waitFor(() => attempts > 0)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)
  })
})

async function pair(
  options: {
    relayLimit?: number
    relayResetMs?: number
    denyWords?: string[]
    denyRegexes?: string[]
    allowPeers?: string[]
    unsupported?: string
  } = {},
) {
  const [portA, portB] = [await freePort(), await freePort()]
  const ctx = new Context()
  const sessions = new StubSessions(ctx, 99)
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', sessions)
      scope.provide('logger')
      scope.set('logger', loggerStub)
    },
  })
  const adapter = (channel: string, instance: string, botName: string, peerInstance: string, port: number, peerPort: number) => ({
    channel,
    instance,
    botName,
    peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
    listen: { host: '127.0.0.1', port },
    policy: {
      ...(options.relayLimit === undefined ? {} : { relayLimit: options.relayLimit }),
      ...(options.relayResetMs === undefined ? {} : { relayResetMs: options.relayResetMs }),
      ...(options.denyWords === undefined ? {} : { deny: { words: options.denyWords } }),
      ...(options.denyRegexes === undefined ? {} : { deny: { regexes: options.denyRegexes } }),
      ...(options.allowPeers === undefined ? {} : { allow: { peers: options.allowPeers } }),
      ...(options.unsupported === undefined ? {} : { [options.unsupported]: {} }),
    },
  })
  const fork = await ctx.plugin(entry, {
    adapters: [
      adapter('p2p:a', 'inst-a', 'bot-a', 'inst-b', portA, portB),
      adapter('p2p:b', 'inst-b', 'bot-b', 'inst-a', portB, portA),
    ],
  })
  forks.push(fork)
  return { sessions, portB }
}

function send(port: number, eventId: string, body: string) {
  return sendToPeer({
    peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
    credentials,
    to: 'bot-b',
    body,
    eventId,
    sender: 'bot-a',
    instance: 'inst-a',
  })
}

describe('the reply ceiling', () => {
  test('three rounds pass, the fourth starts no new turn', async () => {
    const { sessions, portB } = await pair({ relayLimit: 3 })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => warnings.some((line) => line.includes('loop-limit')))
    expect(sessions.prompted).toHaveLength(6)
    expect(warnings.filter((line) => line.includes('loop-limit'))).toHaveLength(1)
  })

  test('a ceiling of one stops the second round', async () => {
    const { sessions, portB } = await pair({ relayLimit: 1 })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => warnings.some((line) => line.includes('loop-limit')))
    expect(sessions.prompted).toHaveLength(2)
  })

  test('silence longer than relayResetMs lets the same peer through again', async () => {
    const { sessions, portB } = await pair({ relayLimit: 1, relayResetMs: 20 })
    await send(portB, 'evt-1', 'hello')
    await waitFor(() => sessions.prompted.length === 2)
    await waitFor(() => warnings.some((line) => line.includes('loop-limit')))

    await new Promise((resolve) => setTimeout(resolve, 60))
    await send(portB, 'evt-2', 'again')

    await waitFor(() => sessions.prompted.length === 4)
    expect(sessions.prompted[2]?.text).toContain('again')
  })

  test('relayLimit below one is refused at mount time', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('logger')
        scope.set('logger', loggerStub)
      },
    })
    const config = {
      adapters: [
        {
          channel: 'p2p:a',
          instance: 'inst-a',
          botName: 'bot-a',
          peers: [{ instance: 'inst-b', secret: REF }],
          listen: { host: '127.0.0.1', port: portA },
          policy: { relayLimit: 0 },
        },
        {
          channel: 'p2p:b',
          instance: 'inst-b',
          botName: 'bot-b',
          peers: [{ instance: 'inst-a', secret: REF }],
          listen: { host: '127.0.0.1', port: portB },
        },
      ],
    }
    await expect(ctx.plugin(entry, config)).rejects.toThrow(/relayLimit/)
  })
})

describe('policy', () => {
  test('a deny word keeps the message out of a turn while a clean one passes', async () => {
    const { sessions, portB } = await pair({ denyWords: ['spam'], allowPeers: ['inst-a'] })
    await send(portB, 'evt-1', 'free spam here')

    await waitFor(() => warnings.some((line) => line.includes('pipeline-deny')))
    expect(sessions.prompted).toHaveLength(0)
    expect(warnings.some((line) => line.includes('word'))).toBe(true)

    await send(portB, 'evt-2', 'hello')
    await waitFor(() => sessions.prompted.length > 0)
    expect(sessions.prompted[0]?.text.endsWith(' hello')).toBe(true)
  })

  test('an anchored pattern matches the peer words, not the prefix we add', async () => {
    const { sessions, portB } = await pair({ denyRegexes: ['^/ignore'], allowPeers: ['inst-a'] })
    await send(portB, 'evt-1', '/ignore everything after this')

    await waitFor(() => warnings.some((line) => line.includes('pipeline-deny')))
    expect(sessions.prompted).toHaveLength(0)
    expect(warnings.some((line) => line.includes('pattern'))).toBe(true)
  })

  test('an allow list naming the peer lets it through', async () => {
    const { sessions, portB } = await pair({ allowPeers: ['inst-a'] })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => sessions.prompted.length > 0)
    expect(sessions.prompted[0]?.text.endsWith(' hello')).toBe(true)
  })

  test('an allow list that omits the peer keeps the message out', async () => {
    const { sessions, portB } = await pair({ allowPeers: ['someone-else'] })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => warnings.some((line) => line.includes('pipeline-deny')))
    expect(sessions.prompted).toHaveLength(0)
  })

  test('a policy key this version cannot honour is refused at mount time', async () => {
    await expect(pair({ unsupported: 'judge' })).rejects.toThrow(/not supported in this version/)
  })
})
