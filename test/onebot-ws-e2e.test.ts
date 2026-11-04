import { afterEach, describe, expect, test } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { boundPort } from './ports.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_ws_e2e}}'
const TOKEN = 'shared-value'
const credentials = staticCredentials({ [REF]: TOKEN })

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Mounted {
  ctx: Context
  server: WebSocketServer
  sockets: WebSocket[]
  actions: { action: string; params: Record<string, unknown>; echo: string }[]
  prompted: string[]
  tools: ToolLike[]
  close: () => Promise<void>
}

const mounted: Mounted[] = []

async function mountForward(): Promise<Mounted> {
  const sockets: WebSocket[] = []
  const actions: { action: string; params: Record<string, unknown>; echo: string }[] = []
  const prompted: string[] = []
  const tools: ToolLike[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  server.on('connection', (socket) => {
    sockets.push(socket)
    socket.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
      if (frame.action === undefined || frame.echo === undefined) return
      actions.push({ action: frame.action, params: frame.params ?? {}, echo: frame.echo })
      socket.send(
        JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 77 }, echo: frame.echo }),
      )
    })
  })
  const port = (server.address() as AddressInfo).port
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', credentials)
      scope.provide('tools')
      scope.set('tools', {
        register: (tool: ToolLike) => {
          tools.push(tool)
          return () => undefined
        },
      })
      scope.provide('sessionController')
      scope.set('sessionController', {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: (request: { sessionId: string; content: readonly { text?: string }[] }) => {
          prompted.push(request.content.map((part) => part.text ?? '').join(''))
          const emit = (event: unknown): void => {
            ctx.emit('session/event', { id: request.sessionId } as never, event as never)
          }
          emit({ type: 'turn/start' })
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a reply' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  await ctx.plugin(registryPlugin)
  const fork = await ctx.plugin(entry, {
    adapters: [
      {
        kind: 'onebot',
        channel: 'onebot:a',
        botName: 'bot-a',
        policy: {},
        transport: {
          protocol: 'ws-forward',
          selfId: '10001',
          api: { url: `ws://127.0.0.1:${port}` },
          accessToken: REF,
          bots: [],
        },
      },
    ],
  })
  const one: Mounted = {
    ctx,
    server,
    sockets,
    actions,
    prompted,
    tools,
    close: async () => {
      await fork.dispose()
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
  mounted.push(one)
  return one
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()!.close()
})

describe('OneBot over a forward websocket', () => {
  test('an event becomes a turn and the reply leaves as an action on the same socket', async () => {
    const one = await mountForward()
    await waitFor(() => one.sockets.length === 1)

    one.sockets[0]!.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10001,
        message_id: 501,
        user_id: 20002,
        group_id: 30003,
        time: 1_700_000_000,
        sender: { nickname: 'peer' },
        message: [{ type: 'text', data: { text: 'ping over ws' } }],
      }),
    )

    await waitFor(() => one.prompted.length === 1)
    expect(one.prompted[0]).toContain('ping over ws')

    await waitFor(() => one.actions.length >= 1)
    expect(one.actions[0]).toMatchObject({
      action: 'send_group_msg',
      params: { group_id: '30003' },
    })
    await waitFor(() => one.sockets[0] !== undefined)
  })

  test('a client that dials us sends an event, runs a turn, and reads the reply as an action', async () => {
    const prompted: string[] = []
    const actions: { action: string; params: Record<string, unknown>; echo: string }[] = []
    const ctx = new Context()
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', {
          create: () => Promise.resolve({ sessionId: 'session-1' }),
          prompt: (request: { sessionId: string; content: readonly { text?: string }[] }) => {
            prompted.push(request.content.map((part) => part.text ?? '').join(''))
            const emit = (event: unknown): void => {
              ctx.emit('session/event', { id: request.sessionId } as never, event as never)
            }
            emit({ type: 'turn/start' })
            emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a reply' }] } } })
            emit({ type: 'turn/end' })
            return Promise.resolve({ accepted: true })
          },
        })
      },
    })
    await ctx.plugin(registryPlugin)
    const fork = await ctx.plugin(entry, {
      adapters: [
        {
          kind: 'onebot',
          channel: 'onebot:a',
          botName: 'bot-a',
          policy: {},
          transport: {
            protocol: 'ws-reverse',
            listen: { host: '127.0.0.1', port: 0 },
            accessToken: REF,
            bots: [],
          },
        },
      ],
    })

    const port = boundPort(ctx, 'onebot:a')
    const status = await fetch(`http://127.0.0.1:${port}/onebot/status`)
    expect(status.status).toBe(200)
    const report = (await status.json()) as Record<string, unknown>
    expect(report).toMatchObject({ channel: 'onebot:a' })
    const missing = await fetch(`http://127.0.0.1:${port}/onebot/nope`)
    expect(missing.status).toBe(404)

    const client = new WebSocket(`ws://127.0.0.1:${port}/onebot/ws`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-self-id': '10001' },
    })
    client.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { action?: string; params?: Record<string, unknown>; echo?: string }
      if (frame.action === undefined || frame.echo === undefined) return
      actions.push({ action: frame.action, params: frame.params ?? {}, echo: frame.echo })
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 77 }, echo: frame.echo }))
    })
    await new Promise<void>((resolve, reject) => {
      client.once('open', () => resolve())
      client.once('error', reject)
    })

    client.send(
      JSON.stringify({
        post_type: 'message',
        message_type: 'group',
        sub_type: 'normal',
        self_id: 10001,
        message_id: 502,
        user_id: 20002,
        group_id: 30003,
        time: 1_700_000_000,
        sender: { nickname: 'peer' },
        message: [{ type: 'text', data: { text: 'ping to us' } }],
      }),
    )

    await waitFor(() => prompted.length === 1)
    expect(prompted[0]).toContain('ping to us')
    await waitFor(() => actions.length >= 1)
    expect(actions[0]).toMatchObject({ action: 'send_group_msg', params: { group_id: '30003' } })

    client.terminate()
    await fork.dispose()
  })
})
