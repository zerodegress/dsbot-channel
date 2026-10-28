import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/p2p-secrets.js'
import { sendToPeer } from '../src/p2p-send.js'

const REF = '{{SECRET_4dhhwz2n}}'
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

class StubSessions {
  readonly prompted: Prompted[] = []
  readonly #ctx: Context
  #count = 0

  constructor(ctx: Context) {
    this.#ctx = ctx
  }

  create(): Promise<{ sessionId: string }> {
    this.#count += 1
    return Promise.resolve({ sessionId: `session-${this.#count}` })
  }

  prompt(request: Prompted & { content: readonly { type: 'text'; text: string }[] }): Promise<{ accepted: boolean }> {
    const text = request.content.map((part) => part.text).join('')
    this.prompted.push({ sessionId: request.sessionId, requestId: request.requestId, text })
    const reply = text.startsWith('reply:') ? '' : `reply:${text}`
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

    expect(sessions.prompted[0]?.text).toBe('hello')
    expect(sessions.prompted[0]?.requestId).toBe('evt-1')
    expect(sessions.prompted[1]?.text).toBe('reply:hello')

    await waitFor(() => sessions.prompted.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted).toHaveLength(2)

    await fork.dispose()
  })

  test('a peer without a url cannot be answered', async () => {
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

    await waitFor(() => sessions.prompted.length === 2)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sessions.prompted.map((entry) => entry.text)).toEqual(['hello', 'reply:hello'])

    await fork.dispose()
  })
})
