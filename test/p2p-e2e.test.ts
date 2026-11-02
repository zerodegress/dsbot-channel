import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'
import { sendToPeer } from '../src/adapters/p2p/p2p-send.js'
import { PEER_GUIDANCE } from '../src/adapters/p2p/guidance.js'

/** The reset window the relay-ceiling cases configure. */
const RELAY_RESET_WINDOW_MS = 20

/** Slack on top of the window, so a poll that wakes early cannot send inside it. */
const RELAY_RESET_MARGIN_MS = 30

const REF = '{{SECRET_4dhhwz2n}}'
const INCOMING = '[p2p from inst-a · bot-a · p2p-evt-1] hello'
const credentials = staticCredentials({ [REF]: 'shared-value' })

/** Drops the line a session is taught once, so a test can read the message itself. */
const GUIDANCE_BLOCK = `[p2p] ${PEER_GUIDANCE}`

function bodyOf(text: string): string {
  return text.startsWith(GUIDANCE_BLOCK) ? text.slice(GUIDANCE_BLOCK.length + 2) : text
}

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

function captureWarnings(ctx: Context): void {
  ctx.logger.exporter({
    levels: { default: 3 },
    export(message: { args: unknown[] }) {
      warnings.push(message.args.map((arg) => String(arg)).join(' '))
    },
  })
}

class StubSessions {
  readonly prompted: Prompted[] = []
  readonly signals: AbortSignal[] = []
  readonly created: string[] = []
  readonly #ctx: Context
  readonly #replies: number
  readonly #failTimes: number
  #count = 0

  constructor(ctx: Context, replies = 1, failTimes = 0) {
    this.#ctx = ctx
    this.#replies = replies
    this.#failTimes = failTimes
  }

  create(): Promise<{ sessionId: string }> {
    this.#count += 1
    const sessionId = `session-${this.#count}`
    this.created.push(sessionId)
    return Promise.resolve({ sessionId })
  }

  prompt(
    request: Prompted & { content: readonly { type: 'text'; text: string }[] },
    signal: AbortSignal,
  ): Promise<{ accepted: boolean }> {
    signal.throwIfAborted()
    this.signals.push(signal)
    const text = request.content.map((part) => part.text).join('')
    this.prompted.push({ sessionId: request.sessionId, requestId: request.requestId, text })
    if (this.prompted.length <= this.#failTimes) {
      return Promise.reject(new Error('the session could not run this turn'))
    }
    const reply = this.prompted.length > this.#replies ? '' : `reply:${text}`
    const emit = (event: unknown): void => {
      this.#ctx.emit('session/event', { id: request.sessionId } as never, event as never)
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
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const adapter = (channel: string, instance: string, botName: string, peerInstance: string, port: number, peerPort: number) => ({
channel,
instance,
botName,
transport: {
  peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
  listen: { host: '127.0.0.1', port }
}
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

    expect(sessions.prompted[0]?.text.startsWith(`[p2p] ${PEER_GUIDANCE}`)).toBe(true)
    expect(bodyOf(sessions.prompted[0]?.text ?? '').startsWith('[p2p from inst-a · bot-a · p2p-evt-1] ')).toBe(true)
    expect(bodyOf(sessions.prompted[0]?.text ?? '').endsWith(' hello')).toBe(true)
    expect(bodyOf(sessions.prompted[0]?.text ?? '')).toBe(INCOMING)
    expect(sessions.prompted[0]?.requestId).toBe('evt-1')
    expect(bodyOf(sessions.prompted[1]?.text ?? '').startsWith('[p2p from inst-b · bot-b · p2p-reply:')).toBe(true)
    expect(bodyOf(sessions.prompted[1]?.text ?? '')).toContain(INCOMING)

    await waitFor(() => sessions.prompted.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)

    await fork.dispose()
  })

  test('refuses two adapters for one bot when their rules cannot bind the pipeline it runs', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const adapter = (channel: string, instance: string, peerInstance: string, policy: Record<string, unknown>) => ({
channel,
instance,
botName: 'bot-shared',
transport: {
  peers: [{ instance: peerInstance, secret: REF }],
  listen: { host: '127.0.0.1', port: 0 }
},
policy
})
    await expect(
      ctx.plugin(entry, {
        adapters: [
          adapter('p2p:a', 'inst-a', 'inst-b', { deny: { words: ['spam'] } }),
          adapter('p2p:b', 'inst-b', 'inst-a', {}),
        ],
      }),
    ).rejects.toThrow(/different pipelines/)
  })

  test('refuses two adapters for one bot that declare the same shape with different rules', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const adapter = (channel: string, instance: string, peerInstance: string, words: string[]) => ({
channel,
instance,
botName: 'bot-shared',
transport: {
  peers: [{ instance: peerInstance, secret: REF }],
  listen: { host: '127.0.0.1', port: 0 }
},
policy: { deny: { words } }
})
    await expect(
      ctx.plugin(entry, {
        adapters: [
          adapter('p2p:a', 'inst-a', 'inst-b', ['spam']),
          adapter('p2p:b', 'inst-b', 'inst-a', ['viagra']),
        ],
      }),
    ).rejects.toThrow(/different rules/)
  })

  test('a peer without a url comes back as no_url instead of silence', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 2)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port: portA }
}
},
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${portA}` }],
  listen: { host: '127.0.0.1', port: portB }
}
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
    expect(bodyOf(sessions.prompted[0]?.text ?? '')).toBe(INCOMING)
    expect(bodyOf(sessions.prompted[1]?.text ?? '')).toContain(INCOMING)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)

    await fork.dispose()
  })
  test('two adapters that answer for one bot with the same rules run a turn on each', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 2)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const adapter = (
      channel: string,
      instance: string,
      peerInstance: string,
      port: number,
      peerPort: number,
    ) => ({
channel,
instance,
botName: 'bot-shared',
transport: {
  peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
  listen: { host: '127.0.0.1', port }
},
policy: { deny: { words: ['spam'] }, allow: { peers: ['inst-a', 'inst-b'] } }
})
    const fork = await ctx.plugin(entry, {
      adapters: [
        adapter('p2p:a', 'inst-a', 'inst-b', portA, portB),
        adapter('p2p:b', 'inst-b', 'inst-a', portB, portA),
      ],
    })
    forks.push(fork)

    const toB = await sendToPeer({
      peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${portB}` },
      credentials,
      to: 'bot-shared',
      body: 'hello',
      eventId: 'evt-shared-1',
      sender: 'inst-a',
      instance: 'inst-a',
    })
    const toA = await sendToPeer({
      peer: { instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${portA}` },
      credentials,
      to: 'bot-shared',
      body: 'hi there',
      eventId: 'evt-shared-2',
      sender: 'inst-b',
      instance: 'inst-b',
    })
    expect(toB).toMatchObject({ ok: true, duplicate: false })
    expect(toA).toMatchObject({ ok: true, duplicate: false })

    await waitFor(() => sessions.prompted.length >= 2)
    const texts = sessions.prompted.map((prompt) => bodyOf(prompt.text))
    expect(texts.some((text) => text.includes('hello'))).toBe(true)
    expect(texts.some((text) => text.includes('hi there'))).toBe(true)

    await fork.dispose()
  })

})

describe('reporting failures', () => {
  test('a log sink that throws does not break the round trip', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    ctx.logger.exporter({
      levels: { default: 3 },
      export() {
        attempts += 1
        throw new Error('the sink failed')
      },
    })
    const sessions = new StubSessions(ctx, 2)
    let attempts = 0
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port: portA }
}
},
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${portA}` }],
  listen: { host: '127.0.0.1', port: portB }
}
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
    budget?: { capacity: number }
    unsupported?: string
    global?: unknown[]
  } = {},
) {
  const [portA, portB] = [await freePort(), await freePort()]
  const ctx = new Context()
  captureWarnings(ctx)
  const sessions = new StubSessions(ctx, 99)
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', sessions)
    },
  })
  const adapter = (channel: string, instance: string, botName: string, peerInstance: string, port: number, peerPort: number) => ({
channel,
instance,
botName,
transport: {
  peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
  listen: { host: '127.0.0.1', port }
},
policy: {
      ...(options.relayLimit === undefined ? {} : { relayLimit: options.relayLimit }),
      ...(options.relayResetMs === undefined ? {} : { relayResetMs: options.relayResetMs }),
      ...(options.denyWords === undefined ? {} : { deny: { words: options.denyWords } }),
      ...(options.denyRegexes === undefined ? {} : { deny: { regexes: options.denyRegexes } }),
      ...(options.allowPeers === undefined ? {} : { allow: { peers: options.allowPeers } }),
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.unsupported === undefined ? {} : { [options.unsupported]: {} }),
    }
})
  const fork = await ctx.plugin(entry, {
    ...(options.global === undefined ? {} : { pipeline: { global: options.global } }),
    adapters: [
      adapter('p2p:a', 'inst-a', 'bot-a', 'inst-b', portA, portB),
      adapter('p2p:b', 'inst-b', 'bot-b', 'inst-a', portB, portA),
    ],
  })
  forks.push(fork)
  return { sessions, portB }
}

function send(port: number, eventId: string, body: string, sender = 'bot-a', chainId?: string) {
  return sendToPeer({
    peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${port}` },
    credentials,
    to: 'bot-b',
    body,
    eventId,
    sender,
    instance: 'inst-a',
    ...(chainId === undefined ? {} : { chainId }),
  })
}

describe('the session controller call shape', () => {
  test('the controller is handed a live signal, as the host signature requires', async () => {
    const { sessions, portB } = await pair()
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => sessions.prompted.length > 0)
    expect(sessions.signals[0]).toBeInstanceOf(AbortSignal)
    expect(sessions.signals[0]?.aborted).toBe(false)
  })
})

describe('the configured session', () => {
  async function mountWithSession(session: string): Promise<{ sessions: StubSessions; port: number }> {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
session,
transport: {
  peers: [{ instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${await freePort()}` }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    return { sessions, port }
  }

  test('an inbound message runs its turn on the session the profile names', async () => {
    const { sessions, port } = await mountWithSession('session-main')

    const sent = await sendToPeer({
      peer: { instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-a',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    expect(sent.ok).toBe(true)

    await waitFor(() => sessions.prompted.length > 0)
    expect(sessions.prompted[0]?.sessionId).toBe('session-main')
    expect(sessions.created).toHaveLength(0)
  })
})

describe('the send_text tool', () => {
  interface Registered {
    name: string
    execute: (args: unknown, exec: unknown) => Promise<string>
  }

  async function mountPair(): Promise<{ tools: Registered[]; sessions: StubSessions; portA: number; portB: number }> {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    const tools: Registered[] = []
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('tools')
        scope.set('tools', {
          register(definition: Registered) {
            tools.push(definition)
            return () => undefined
          },
        })
      },
    })
    const adapter = (
      channel: string,
      instance: string,
      botName: string,
      peerInstance: string,
      peerBotName: string,
      port: number,
      peerPort: number,
    ) => ({
channel,
instance,
botName,
transport: {
  peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}`, botName: peerBotName }],
  listen: { host: '127.0.0.1', port }
}
})
    const fork = await ctx.plugin(entry, {
      adapters: [
        adapter('p2p:a', 'inst-a', 'bot-a', 'inst-b', 'bot-b', portA, portB),
        adapter('p2p:b', 'inst-b', 'bot-b', 'inst-a', 'bot-a', portB, portA),
      ],
    })
    forks.push(fork)
    return { tools, sessions, portA, portB }
  }

  test('a peer link registers the text tool and the two ways to close a chain', async () => {
    const { tools } = await mountPair()

    expect(tools.map((tool) => tool.name)).toEqual([
      'send_text',
      'send_image',
      'send_file',
      'read_history',
      'no_reply',
      'decline',
    ])
  })

  test('a peer link carries no image, file or history, and each tool names what it lacks', async () => {
    const { tools } = await mountPair()
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const tool = tools.find((one) => one.name === name)
      expect(tool).toBeDefined()
      return JSON.parse(String(await tool?.execute(args, {}))) as Record<string, unknown>
    }

    const image = await call('send_image', { url: 'https://example.test/a.png', channel: 'p2p:a', target: 'inst-b' })
    const file = await call('send_file', { url: 'https://example.test/a.txt', channel: 'p2p:a', target: 'inst-b' })
    const history = await call('read_history', { channel: 'p2p:a', target: 'inst-b', limit: 10 })

    for (const [result, capability] of [
      [image, 'image'],
      [file, 'file'],
      [history, 'history'],
    ] as const) {
      expect(result).toMatchObject({ ok: false, code: 'unsupported_capability' })
      expect(result.reason).toContain(`capabilities.${capability} is false`)
      expect(result.reason).toContain('p2p:a')
    }
  })

  test('a push with no arguments answers the peer that just messaged this session', async () => {
    const { tools, sessions, portB } = await mountPair()
    await send(portB, 'evt-1', 'hello')
    await waitFor(() => sessions.prompted.length > 0)
    const sessionId = sessions.prompted[0]?.sessionId as string

    const raw = await tools[0]?.execute({ text: 'back' }, { agent: { id: sessionId } })
    const result = JSON.parse(raw as string) as Record<string, unknown>

    expect(result).toMatchObject({ ok: true, channel: 'p2p:b', target: 'inst-a' })
    await waitFor(() => sessions.prompted.some((entry) => entry.text.includes('back')))
  })

  test('one idempotency key delivers once and replays the same message id', async () => {
    const { tools, sessions, portB } = await mountPair()
    await send(portB, 'evt-1', 'hello')
    await waitFor(() => sessions.prompted.length > 0)
    const sessionId = sessions.prompted[0]?.sessionId as string

    const first = JSON.parse((await tools[0]?.execute({ text: 'once', idempotencyKey: 'k1' }, { agent: { id: sessionId } })) as string)
    const second = JSON.parse((await tools[0]?.execute({ text: 'once', idempotencyKey: 'k1' }, { agent: { id: sessionId } })) as string)

    expect(second).toEqual(first)
  })
})

describe('closing a peer conversation', () => {
  interface Captured {
    status?: string
    final?: boolean
    reason?: string
    body?: string
    chainId?: string
    inReplyTo?: string
    seenHost?: string | undefined
  }

  interface Mounted {
    posts: Captured[]
    prompted: string[]
    port: number
    close: () => void
  }

  async function mount(
    first: 'no_reply' | 'decline' | 'none',
    later: 'no_reply' | 'decline' | 'none' = first,
    host?: string,
    options: { reason?: string; relayLimit?: number; budget?: Record<string, unknown> } = {},
  ): Promise<Mounted> {
    const posts: Captured[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posts.push({ ...(JSON.parse(raw) as Captured), seenHost: request.headers.host })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const prompted: string[] = []
    const registered: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }[] = []
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: {
        sessionId: string
        requestId: string
        content: readonly { type: string; text?: string }[]
      }): Promise<{ accepted: boolean }> {
        prompted.push(request.content.map((part) => part.text ?? '').join(''))
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        emit({ type: 'turn/start' })
        const call = prompted.length === 1 ? first : later
        const tool = registered.find((candidate) => candidate.name === call)
        if (tool !== undefined) {
          await tool.execute(
            { reason: options.reason ?? 'policy', note: 'no' },
            { agent: { id: request.sessionId }, concludeTurn: () => undefined } as never,
          )
        }
        emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a reply that must not leave' }] } } })
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
        scope.provide('tools')
        scope.set('tools', {
          register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }) {
            registered.push(definition)
            return () => undefined
          },
        })
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
  ...(options.relayLimit === undefined && options.budget === undefined
    ? {}
    : {
        policy: {
          ...(options.relayLimit === undefined ? {} : { relayLimit: options.relayLimit }),
          ...(options.budget === undefined ? {} : { budget: options.budget }),
        },
      }),
transport: {
  peers: [
            {
              instance: 'inst-a',
              secret: REF,
              url: `http://127.0.0.1:${capturePort}`,
              ...(host === undefined ? {} : { host }),
            },
          ],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    return { posts, prompted, port, close: () => capture.close() }
  }

  test('no_reply leaves the peer with nothing at all', async () => {
    const mounted = await mount('no_reply')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.prompted.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posts).toHaveLength(0)
    } finally {
      mounted.close()
    }
  })

  test('decline sends one refusal and nothing after it', async () => {
    const mounted = await mount('decline')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)
      expect(mounted.posts[0]).toMatchObject({ status: 'declined', final: true, reason: 'policy', body: 'no' })

      await send(mounted.port, 'evt-2', 'are you there', 'bot-a', 'evt-1')
      await waitFor(() => mounted.prompted.length === 2)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posts).toHaveLength(1)
    } finally {
      mounted.close()
    }
  })

  test('a decline reaches a peer that answers to a name, not the dialled address', async () => {
    const mounted = await mount('decline', 'decline', 'peer.example')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)
      expect(mounted.posts[0]).toMatchObject({ status: 'declined', seenHost: 'peer.example', chainId: 'evt-1' })
    } finally {
      mounted.close()
    }
  })

  test('a message on a closed chain still runs its turn and answers nothing', async () => {
    const mounted = await mount('decline', 'none')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)

      await send(mounted.port, 'evt-2', 'are you there', 'bot-a', 'evt-1')
      await waitFor(() => mounted.prompted.length === 2)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posts).toHaveLength(1)
    } finally {
      mounted.close()
    }
  })

  test('the reason the model picked is the one on the wire', async () => {
    const mounted = await mount('decline', 'decline', undefined, { reason: 'too-busy' })
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)
      expect(mounted.posts[0]).toMatchObject({ status: 'declined', reason: 'too-busy' })
    } finally {
      mounted.close()
    }
  })

  test('a refusal counts toward the ceiling, so the next round is stopped', async () => {
    const mounted = await mount('decline', 'decline', undefined, { relayLimit: 1 })
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)

      await send(mounted.port, 'evt-2', 'again')
      await waitFor(() => warnings.some((line) => line.includes('loop-limit')))
      expect(mounted.prompted).toHaveLength(1)
    } finally {
      mounted.close()
    }
  })

  test('a refusal is charged at the rejected rate, so a burst hits the ceiling', async () => {
    const mounted = await mount('decline', 'decline', undefined, { budget: { capacity: 20 } })
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posts.length === 1)
      await send(mounted.port, 'evt-2', 'hello again')
      await waitFor(() => mounted.posts.length === 2)

      await send(mounted.port, 'evt-3', 'third')
      await waitFor(() => warnings.some((line) => line.includes('budget-hard')))
      expect(mounted.prompted).toHaveLength(2)
    } finally {
      mounted.close()
    }
  })

  test('a declined message still runs a turn and answers nothing', async () => {
    const mounted = await mount('none')
    try {
      const sent = await sendToPeer({
        peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${mounted.port}` },
        credentials,
        to: 'bot-b',
        body: 'stop it',
        eventId: 'evt-9',
        sender: 'bot-a',
        instance: 'inst-a',
        status: 'declined',
        reason: 'not wanted',
        final: true,
      })
      expect(sent.ok).toBe(true)

      await waitFor(() => mounted.prompted.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posts).toHaveLength(0)
    } finally {
      mounted.close()
    }
  })

  test('the guidance rides the first message of a session only', async () => {
    const mounted = await mount('none')
    try {
      await send(mounted.port, 'evt-1', 'first')
      await waitFor(() => mounted.prompted.length === 1)
      await send(mounted.port, 'evt-2', 'second')
      await waitFor(() => mounted.prompted.length === 2)

      expect(mounted.prompted[0]).toContain('call no_reply')
      expect(mounted.prompted[1]).not.toContain('call no_reply')
    } finally {
      mounted.close()
    }
  })
})

describe('a reply to a peer behind a name router', () => {
  test('the reply carries the configured host, not the dialled address', async () => {
    let host: string | undefined
    const capture = createServer((request, response) => {
      host = request.headers.host
      request.on('data', () => undefined)
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-reply' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, host: 'peer.example' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    try {
      await send(port, 'evt-1', 'hello')
      await waitFor(() => host !== undefined)
      expect(host).toBe('peer.example')
    } finally {
      capture.close()
    }
  })
})

describe('an active push to a peer behind a name router', () => {
  test('the configured host is what the peer sees', async () => {
    let host: string | undefined
    const capture = createServer((request, response) => {
      host = request.headers.host
      request.on('data', () => undefined)
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-push' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }[] = []
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('tools')
        scope.set('tools', {
          register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }) {
            tools.push(definition)
            return () => undefined
          },
        })
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-a', host: 'peer.example' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    try {
      const raw = await tools[0]?.execute({ text: 'hello', channel: 'p2p:b', target: 'inst-a' }, {})
      expect(JSON.parse(raw as string)).toMatchObject({ ok: true, channel: 'p2p:b', target: 'inst-a' })
      expect(host).toBe('peer.example')
    } finally {
      capture.close()
    }
  })
})

describe('a turn that already pushed with send_text', () => {
  interface Posted {
    eventId?: string
    body?: string
    inReplyTo?: string
  }

  async function mount(
    mode: 'body' | 'tool' | 'both',
    failPush = false,
  ): Promise<{ posted: Posted[]; port: number; close: () => void }> {
    const posted: Posted[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        const body = JSON.parse(raw) as Posted
        posted.push(body)
        if (failPush && (body.body ?? '').includes('pushed')) {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: 'the peer could not take it' }))
          return
        }
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-ok' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }[] = []
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: { sessionId: string; requestId: string; content: readonly { type: string; text?: string }[] }): Promise<{ accepted: boolean }> {
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        emit({ type: 'turn/start' })
        if (mode !== 'body') {
          const push = tools.find((tool) => tool.name === 'send_text')
          await push?.execute(
            { text: 'pushed', channel: 'p2p:b', target: 'inst-a' },
            { agent: { id: request.sessionId } } as never,
          )
        }
        if (mode !== 'tool') {
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a written reply' }] } } })
        }
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
        scope.provide('tools')
        scope.set('tools', {
          register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }) {
            tools.push(definition)
            return () => undefined
          },
        })
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-a' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    return { posted, port, close: () => capture.close() }
  }

  test('a written reply with no push still goes out', async () => {
    const mounted = await mount('body')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posted.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posted).toHaveLength(1)
      expect(mounted.posted[0]?.eventId?.startsWith('reply:')).toBe(true)
      expect(mounted.posted[0]?.inReplyTo).toBe('evt-1')
      expect(mounted.posted[0]?.body).toContain('a written reply')
    } finally {
      mounted.close()
    }
  })

  test('a push with no written reply leaves one message, not two', async () => {
    const mounted = await mount('tool')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posted.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posted).toHaveLength(1)
      expect(mounted.posted[0]?.eventId?.startsWith('push:')).toBe(true)
    } finally {
      mounted.close()
    }
  })

  test('a push that fails still leaves the written reply to go out', async () => {
    const mounted = await mount('both', true)
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posted.some((entry) => entry.eventId?.startsWith('reply:')))
      await new Promise((resolve) => setTimeout(resolve, 60))
      const replies = mounted.posted.filter((entry) => entry.eventId?.startsWith('reply:'))
      expect(replies).toHaveLength(1)
      expect(replies[0]?.body).toContain('a written reply')
    } finally {
      mounted.close()
    }
  })

  test('a push and a written reply send the push alone', async () => {
    const mounted = await mount('both')
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.posted.length === 1)
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(mounted.posted).toHaveLength(1)
      expect(mounted.posted[0]?.eventId?.startsWith('push:')).toBe(true)
    } finally {
      mounted.close()
    }
  })
})

describe('a turn that answers with nothing', () => {
  test('is recorded as an anomaly instead of passing for a normal end', async () => {
    const posted: unknown[] = []
    const capture = createServer((request, response) => {
      request.on('data', () => undefined)
      request.on('end', () => {
        posted.push(1)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-x' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: { sessionId: string }): Promise<{ accepted: boolean }> {
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        emit({ type: 'turn/start' })
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}` }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    try {
      await send(port, 'evt-1', 'hello')
      await waitFor(() => warnings.some((line) => line.includes('no text and no tool call')))
      await new Promise((resolve) => setTimeout(resolve, 40))
      expect(posted).toHaveLength(0)
    } finally {
      capture.close()
    }
  })
})

describe('a reply goes back to the sender of the inbound message', () => {
  async function mountWithCapture(): Promise<{
    captured: () => Record<string, unknown> | undefined
    port: number
    sessions: StubSessions
    close: () => void
  }> {
    let captured: Record<string, unknown> | undefined
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        captured = JSON.parse(raw) as Record<string, unknown>
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}` }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    return {
      captured: () => captured,
      port,
      sessions,
      close: () => {
        capture.close()
      },
    }
  }

  test('the reply names the message it answers and quotes the start of it', async () => {
    const mounted = await mountWithCapture()
    try {
      await send(mounted.port, 'evt-1', 'what about the port')
      await waitFor(() => mounted.captured() !== undefined)
      const sent = mounted.captured()
      expect(sent?.inReplyTo).toBe('evt-1')
      expect(sent?.inReplyToExcerpt).toBe('what about the port')
    } finally {
      mounted.close()
    }
  })

  test('the outgoing message is addressed to the inbound sender, not to anything else', async () => {
    const mounted = await mountWithCapture()
    try {
      await send(mounted.port, 'evt-1', 'hello')
      await waitFor(() => mounted.captured() !== undefined)
      const sent = mounted.captured()
      expect(sent?.to).toBe('bot-a')
      expect(sent?.sender).toBe('bot-b')
      expect(sent?.instance).toBe('inst-b')
      expect(sent?.chainId).toBe('evt-1')
    } finally {
      mounted.close()
    }
  })

  test('a reply that nobody answers to fails visibly instead of going quiet', async () => {
    const { sessions, portB } = await pair()
    await send(portB, 'evt-1', 'hello', 'probe')

    await waitFor(() => warnings.some((line) => line.includes('forbidden')))
    expect(sessions.prompted).toHaveLength(1)
  })
})

describe('one service reports every adapter at once', () => {
  test('two adapters appear in one snapshot, and it empties when they stop', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port: 0 }
}
},
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF }],
  listen: { host: '127.0.0.1', port: 0 }
}
},
      ],
    })

    const service = ctx.get('dsbot-channel.status') as { snapshot(): { adapters: { channel: string }[] } }

    expect(service.snapshot().adapters.map((report) => report.channel).sort()).toEqual(['p2p:a', 'p2p:b'])
    expect(service.snapshot().adapters[0]).toMatchObject({ channel: 'p2p:a', health: { kind: 'listener', listenState: 'listening' } })

    await fork.dispose()

    expect(service.snapshot().adapters).toEqual([])
  })
})

describe('a mounted adapter can report on itself', () => {
  async function getStatus(port: number): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/p2p/v1/status', method: 'GET' },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
            }),
          )
        },
      )
      req.on('error', reject)
      req.end()
    })
  }

  test('the route answers without being asked, and reports what health holds', async () => {
    const port = await freePort()
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)

    const reply = await getStatus(port)

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({ channel: 'p2p:a', health: { kind: 'listener' }, counters: { sendFailures: {} } })
  })

  test('an empty turn is reported in the log', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: { sessionId: string }): Promise<{ accepted: boolean }> {
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        emit({ type: 'turn/start' })
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF, url: 'http://127.0.0.1:1' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)

    await sendToPeer({
      peer: { instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-a',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    await waitFor(() => warnings.some((line) => line.includes('no text and no tool call')))

    const turns = ctx.get('dsbot-channel.turns') as { snapshot(): { empty: number; started: number } }
    expect(turns.snapshot()).toMatchObject({ started: 1, empty: 1 })
  })

  test('a failed push is counted by the code the send layer reported', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }[] = []
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', new StubSessions(ctx, 1))
        scope.provide('tools')
        scope.set('tools', {
          register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }) {
            tools.push(definition)
            return () => undefined
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
transport: {
  peers: [{ instance: 'inst-b', secret: REF, url: 'http://127.0.0.1:1', botName: 'bot-b' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)

    const push = tools.find((tool) => tool.name === 'send_text')
    const raw = await push?.execute({ text: 'hello', channel: 'p2p:a', target: 'inst-b' }, {})
    expect(JSON.parse(raw as string)).toMatchObject({ ok: false, code: 'unreachable' })

    const reply = await getStatus(port)
    expect(reply.body).toMatchObject({ counters: { sendFailures: { unreachable: 1 } } })
  })

  test('a reply that never lands is counted', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF, url: 'http://127.0.0.1:1' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)

    await sendToPeer({
      peer: { instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-a',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    await waitFor(() => warnings.some((line) => line.includes('was not delivered')))

    const reply = await getStatus(port)
    expect(reply.body).toMatchObject({ counters: { sendFailures: { unreachable: 1 } } })
  })

  test('a refusal that never lands is counted', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }[] = []
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: { sessionId: string }): Promise<{ accepted: boolean }> {
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        emit({ type: 'turn/start' })
        const decline = tools.find((tool) => tool.name === 'decline')
        await decline?.execute({ reason: 'policy', note: 'no' }, { agent: { id: request.sessionId }, concludeTurn: () => undefined } as never)
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
        scope.provide('tools')
        scope.set('tools', {
          register(definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<string> }) {
            tools.push(definition)
            return () => undefined
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
transport: {
  peers: [{ instance: 'inst-b', secret: REF, url: 'http://127.0.0.1:1' }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)

    await sendToPeer({
      peer: { instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${port}` },
      credentials,
      to: 'bot-a',
      body: 'hello',
      eventId: 'evt-1',
      sender: 'bot-b',
      instance: 'inst-b',
    })
    await waitFor(() => tools.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 120))

    const reply = await getStatus(port)
    expect(reply.body).toMatchObject({ counters: { sendFailures: { unreachable: 1 } } })
  })

  test('the reply names the channel and the port it is really listening on', async () => {
    const port = await freePort()
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port }
},
status: true
},
      ],
    })
    forks.push(fork)

    const reply = await getStatus(port)

    expect(reply.status).toBe(200)
    expect(reply.body).toMatchObject({
      channel: 'p2p:a',
      bot: 'bot-a',
      account: 'inst-a',
      health: { kind: 'listener', listenState: 'listening', boundPort: port },
      counters: { unknownPaths: 0, lastFailure: null },
    })
  })

  test('an adapter that turned the route off does not answer it', async () => {
    const port = await freePort()
    const ctx = new Context()
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port }
},
status: false
},
      ],
    })
    forks.push(fork)

    expect((await getStatus(port)).status).toBe(404)
  })
})

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

    const refusedAt = Date.now()
    await waitFor(() => Date.now() - refusedAt >= RELAY_RESET_WINDOW_MS + RELAY_RESET_MARGIN_MS)
    await send(portB, 'evt-2', 'again')

    await waitFor(() => sessions.prompted.some((entry) => entry.text.endsWith(' again')))
    expect(sessions.prompted.some((entry) => entry.text.endsWith(' again'))).toBe(true)
  })

  test('relayLimit below one is refused at mount time', async () => {
    const [portA, portB] = [await freePort(), await freePort()]
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const config = {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port: portA }
},
policy: { relayLimit: 0 }
},
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF }],
  listen: { host: '127.0.0.1', port: portB }
}
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

  test('a policy key this version does not know is refused at mount time', async () => {
    await expect(pair({ unsupported: 'judge' })).rejects.toThrow(/unknown config fields: judge/)
  })
})

describe('policy budget', () => {
  async function mountWith(policy: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 1)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const config = {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-a',
transport: {
  peers: [{ instance: 'inst-b', secret: REF }],
  listen: { host: '127.0.0.1', port: await freePort() }
},
policy
},
      ],
    }
    const fork = await ctx.plugin(entry, config)
    forks.push(fork)
    return ctx
  }

  test('a budget section mounts, because a turn is now charged against it', async () => {
    await expect(mountWith({ budget: { capacity: 1000 } })).resolves.toBeDefined()
  })

  test('a capacity below one is refused, since zero would divide the window to nothing', async () => {
    await expect(mountWith({ budget: { capacity: 0 } })).rejects.toThrow(/budget capacity/)
    await expect(mountWith({ budget: { capacity: -5 } })).rejects.toThrow(/budget capacity/)
    await expect(mountWith({ budget: { capacity: 2.5 } })).rejects.toThrow(/budget capacity/)
  })

  test('a soft limit is now an unknown field', async () => {
    await expect(mountWith({ budget: { capacity: 100, softLimit: 0.8 } })).rejects.toThrow(
      /unknown config fields: softLimit/,
    )
  })

  test('a hard limit is accepted, because the gate reads it', async () => {
    await expect(mountWith({ budget: { capacity: 100, hardLimit: 0.9 } })).resolves.toBeDefined()
    await expect(mountWith({ budget: { capacity: 100, hardLimit: 1 } })).resolves.toBeDefined()
  })

  test('a hard limit that is not above zero and at most one is refused', async () => {
    for (const hardLimit of [0, -0.1, 1.5, 2]) {
      await expect(mountWith({ budget: { capacity: 100, hardLimit } })).rejects.toThrow(/budget hardLimit/)
    }
  })

  test('a point table in a profile is an unknown field', async () => {
    await expect(mountWith({ budget: { capacity: 100, points: { accepted: 5 } } })).rejects.toThrow(
      /unknown config fields: points/,
    )
  })

  test('a budget without a capacity is refused by the schema', async () => {
    await expect(mountWith({ budget: {} })).rejects.toThrow(/capacity/)
  })

  test('a full window refuses the next turn instead of starting it', async () => {
    const { sessions, portB } = await pair({ budget: { capacity: 20 } })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => warnings.some((line) => line.includes('budget-hard')))
    expect(sessions.prompted).toHaveLength(2)
    expect(sessions.prompted[0]?.text).toContain('hello')
  })

  test('a turn whose reply cannot be sent costs the refused price, not the reserved one', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF }],
  listen: { host: '127.0.0.1', port }
},
policy: { budget: { capacity: 15 } }
},
      ],
    })
    forks.push(fork)

    await send(port, 'evt-1', 'one')
    await waitFor(() => sessions.prompted.length === 1)
    await send(port, 'evt-2', 'two')
    await waitFor(() => sessions.prompted.length === 2)
    await send(port, 'evt-3', 'three')

    await waitFor(() => warnings.some((line) => line.includes('budget-hard')))
    expect(sessions.prompted).toHaveLength(2)
  })

  test('a replayed event reaches the turn twice but is charged once', async () => {
    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:a',
instance: 'inst-a',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF }],
  listen: { host: '127.0.0.1', port },
  dedupe: { ttlMs: 0 }
},
policy: { budget: { capacity: 20 } }
},
      ],
    })
    forks.push(fork)
    const settled = (): number => warnings.filter((line) => line.includes('was not delivered')).length

    await send(port, 'evt-1', 'one')
    await waitFor(() => settled() === 1)
    await send(port, 'evt-1', 'one')
    await waitFor(() => settled() === 2)
    await send(port, 'evt-2', 'two')
    await waitFor(() => sessions.prompted.length === 3)

    expect(warnings.some((line) => line.includes('budget-hard'))).toBe(false)
  })

  test('a window wide enough lets the pair finish its rounds', async () => {
    const { sessions, portB } = await pair({ budget: { capacity: 4000 }, relayLimit: 2 })
    await send(portB, 'evt-1', 'hello')

    await waitFor(() => warnings.some((line) => line.includes('loop-limit')))
    expect(warnings.some((line) => line.includes('budget-hard'))).toBe(false)
    expect(sessions.prompted.length).toBeGreaterThan(0)
  })
})


async function mounted(
  ctx: Context,
  sessions: StubSessions,
  options: { budget?: { capacity: number }; denyWords?: string[]; allowPeers?: string[] } = {},
): Promise<{ portB: number }> {
  const [portA, portB] = [await freePort(), await freePort()]
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('sessionController')
      scope.set('sessionController', sessions)
    },
  })
  const adapter = (channel: string, instance: string, botName: string, peerInstance: string, port: number, peerPort: number) => ({
channel,
instance,
botName,
transport: {
  peers: [{ instance: peerInstance, secret: REF, url: `http://127.0.0.1:${peerPort}` }],
  listen: { host: '127.0.0.1', port }
},
policy: {
      ...(options.budget === undefined ? {} : { budget: options.budget }),
      ...(options.denyWords === undefined ? {} : { deny: { words: options.denyWords } }),
      ...(options.allowPeers === undefined ? {} : { allow: { peers: options.allowPeers } }),
    }
})
  const fork = await ctx.plugin(entry, {
    adapters: [
      adapter('p2p:a', 'inst-a', 'bot-a', 'inst-b', portA, portB),
      adapter('p2p:b', 'inst-b', 'bot-b', 'inst-a', portB, portA),
    ],
  })
  forks.push(fork)
  return { portB }
}

describe('what the wiring charges', () => {
  test('an empty turn costs the refused price, not the reserved one', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 0)
    const { portB } = await mounted(ctx, sessions, { budget: { capacity: 20 } })
    await send(portB, 'evt-1', 'hello')
    await waitFor(() => sessions.prompted.length === 1)
    await send(portB, 'evt-2', 'again')
    await waitFor(() => sessions.prompted.length === 2)
    expect(sessions.prompted).toHaveLength(2)
  })

  test('a turn that never ran costs nothing', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 0, 1)
    const { portB } = await mounted(ctx, sessions, { budget: { capacity: 20 } })
    await send(portB, 'evt-1', 'hello')
    await waitFor(() => warnings.some((line) => line.includes('failed')))
    await send(portB, 'evt-2', 'again')
    await waitFor(() => sessions.prompted.length === 2)
    expect(sessions.prompted).toHaveLength(2)
  })

  test('a refused message costs nothing, so a burst cannot exhaust the window', async () => {
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 0)
    const { portB } = await mounted(ctx, sessions, {
      budget: { capacity: 20 },
      denyWords: ['spam'],
      allowPeers: ['inst-a'],
    })
    await send(portB, 'evt-1', 'spam')
    await waitFor(() => warnings.some((line) => line.includes('pipeline-deny')))
    await send(portB, 'evt-2', 'spam')
    await send(portB, 'evt-3', 'hello')
    await waitFor(() => sessions.prompted.length === 1)
    expect(warnings.some((line) => line.includes('budget-hard'))).toBe(false)
  })
})

describe('a message that arrives while the session is busy', () => {
  test('the answer of its own turn comes back to the sender', async () => {
    const posted: string[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push((JSON.parse(raw) as { body?: string }).body ?? '')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-reply' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port

    const port = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const controller = {
      create(): Promise<{ sessionId: string }> {
        return Promise.resolve({ sessionId: 'session-main' })
      },
      async prompt(request: {
        sessionId: string
        requestId: string
        content: readonly { type: string; text?: string }[]
      }): Promise<{ accepted: boolean }> {
        const emit = (event: unknown): void => {
          ctx.emit('session/event', { id: request.sessionId } as never, event as never)
        }
        const opening = (rpcId: string): void => {
          emit({ type: 'user/message', data: { source: { rpcId }, content: [] } })
        }
        const answer = (text: string): void => {
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
        }
        opening('a-turn-already-running')
        answer('theirs')
        emit({ type: 'turn/end' })
        opening(request.requestId)
        answer('mine')
        emit({ type: 'turn/end' })
        return { accepted: true }
      },
    }
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', controller)
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
channel: 'p2p:b',
instance: 'inst-b',
botName: 'bot-b',
transport: {
  peers: [{ instance: 'inst-a', secret: REF, url: `http://127.0.0.1:${capturePort}` }],
  listen: { host: '127.0.0.1', port }
}
},
      ],
    })
    forks.push(fork)
    try {
      await send(port, 'evt-1', 'hello')
      await waitFor(() => posted.length > 0)
      expect(posted[0]).toContain('mine')
      expect(posted[0]).not.toContain('theirs')
    } finally {
      capture.close()
    }
  })
})

describe('the shape a profile declares', () => {
  test('runs the nodes in the declared order, not the policy default', async () => {
    const { sessions, portB } = await pair({
      denyWords: ['spam'],
      allowPeers: ['inst-a'],
      global: [
        { id: 'allow', type: 'allow' },
        { id: 'deny', type: 'deny' },
      ],
    })
    await send(portB, 'evt-1', 'free spam here')

    await waitFor(() => sessions.prompted.length > 0)
    expect(sessions.prompted[0]?.text.endsWith(' free spam here')).toBe(true)
  })

  test('the same policy with the default order refuses that word', async () => {
    const { sessions, portB } = await pair({ denyWords: ['spam'], allowPeers: ['inst-a'] })
    await send(portB, 'evt-1', 'free spam here')

    await waitFor(() => warnings.some((line) => line.includes('pipeline-deny')))
    expect(sessions.prompted).toHaveLength(0)
  })
})

describe('an active push to another peer on the same channel', () => {
  test('the recipient is the target peer, not the sender of the last message', async () => {
    const posted: Record<string, unknown>[] = []
    const capture = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk: string) => {
        raw += chunk
      })
      request.on('end', () => {
        posted.push(JSON.parse(raw) as Record<string, unknown>)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ duplicate: false, messageId: 'p2p-push' }))
      })
    })
    await new Promise<void>((resolve) => capture.listen(0, '127.0.0.1', resolve))
    const capturePort = (capture.address() as AddressInfo).port
    const portB = await freePort()
    const ctx = new Context()
    captureWarnings(ctx)
    const sessions = new StubSessions(ctx, 99)
    const tools: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }[] = []
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', sessions)
        scope.provide('tools')
        scope.set('tools', {
          register: (tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
            tools.push(tool)
            return () => undefined
          },
        })
      },
    })
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
          channel: 'p2p:b',
          instance: 'inst-b',
          botName: 'bot-b',
          transport: {
            peers: [
              { instance: 'inst-a', secret: REF },
              { instance: 'inst-c', secret: REF, url: `http://127.0.0.1:${capturePort}`, botName: 'bot-c' },
            ],
            listen: { host: '127.0.0.1', port: portB },
          },
        },
      ],
    })
    forks.push(fork)

    try {
      await sendToPeer({
        peer: { instance: 'inst-b', secret: REF, url: `http://127.0.0.1:${portB}` },
        credentials,
        to: 'bot-b',
        body: 'hello',
        eventId: 'evt-push-target',
        sender: 'bot-a',
        instance: 'inst-a',
      })
      await waitFor(() => sessions.prompted.length > 0)
      const sessionId = sessions.prompted[0]?.sessionId as string
      const push = tools.find((tool) => tool.name === 'send_text')
      expect(push).toBeDefined()

      await push!.execute({ text: 'to c', target: 'inst-c' }, { agent: { id: sessionId } })

      await waitFor(() => posted.length > 0)
      expect(posted[0]).toMatchObject({ to: 'bot-c', instance: 'inst-b', sender: 'bot-b', body: 'to c' })
    } finally {
      capture.close()
    }
  })
})

describe('a reply chain three hops long', () => {
  test('keeps one chain root and never grows an event id', async () => {
    const { sessions, portB } = await pair()

    await send(portB, 'evt-1', 'hello')
    await waitFor(() => sessions.prompted.length >= 3, 8000)

    const ids = sessions.prompted.map((entry) => entry.requestId)
    expect(ids[0]).toBe('evt-1')
    for (const later of ids.slice(1)) {
      expect(later.startsWith('reply:')).toBe(true)
      expect(later).not.toContain('reply:reply:')
      expect(later.length).toBeLessThanOrEqual(64)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})
