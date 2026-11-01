import { afterEach, describe, expect, test } from 'vitest'
import { createServer, request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = '{{SECRET_onebot_e2e}}'
const TOKEN = 'e2e-token'
const credentials = staticCredentials({ [REF]: TOKEN })

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as AddressInfo).port
      probe.close(() => resolve(port))
    })
  })
}

function post(port: number, body: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpRequest(
      { host: '127.0.0.1', port, path: '/onebot/event', method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` } },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode ?? 0))
      },
    )
    req.on('error', reject)
    req.end(payload)
  })
}

const disposers: (() => unknown)[] = []
afterEach(async () => {
  while (disposers.length > 0) await disposers.pop()?.()
})

interface Mounted {
  port: number
  apiPort: number
  prompted: string[]
  calls: { action: string; body: Record<string, unknown> }[]
}

async function mount(policy: Record<string, unknown> = {}): Promise<Mounted> {
  const prompted: string[] = []
  const calls: { action: string; body: Record<string, unknown> }[] = []
  const ctx = new Context()
  const api = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      calls.push({ action: (request.url ?? '').replace(/^\//, ''), body: JSON.parse(raw) as Record<string, unknown> })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 77 } }))
    })
  })
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve))
  disposers.push(() => new Promise<void>((resolve) => api.close(() => resolve())))
  const apiPort = (api.address() as AddressInfo).port
  const port = await freePort()

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
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'onebot 回复' }] } } })
          emit({ type: 'turn/end' })
          return Promise.resolve({ accepted: true })
        },
      })
    },
  })
  const fork = await ctx.plugin(entry, {
    adapters: [
      {
        kind: 'onebot',
        channel: 'onebot:a',
        instance: 'inst-a',
        botName: 'bot-a',
        policy,
        transport: {
          selfId: '10001',
          listen: { host: '127.0.0.1', port },
          api: { url: `http://127.0.0.1:${apiPort}` },
          accessToken: REF,
        },
      },
    ],
  })
  disposers.push(() => fork.dispose())
  return { port, apiPort, prompted, calls }
}

const event = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  message_id: 31,
  user_id: 20002,
  group_id: 12345,
  time: 1_700_000_000,
  sender: { nickname: '阿明' },
  message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 帮我看看' } }],
  ...overrides,
})

const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('an onebot group message through the mounted plugin', () => {
  test('runs a turn and answers through send_group_msg', async () => {
    const mounted = await mount()
    expect(await post(mounted.port, event())).toBe(204)
    await wait()

    expect(mounted.prompted).toHaveLength(1)
    expect(mounted.prompted[0]).toContain('[onebot from 阿明 · 20002 · 31]  帮我看看')
    expect(mounted.calls[0]).toMatchObject({ action: 'send_group_msg', body: { group_id: '12345', message: 'onebot 回复' } })
  })

  test('requireMention refuses a group message that names nobody', async () => {
    const mounted = await mount({ requireMention: true })
    expect(await post(mounted.port, event({ message_id: 32, message: [{ type: 'text', data: { text: '随便聊聊' } }] }))).toBe(204)
    await wait()

    expect(mounted.prompted).toHaveLength(0)
    expect(mounted.calls).toHaveLength(0)
  })

  test('a private message answers through send_private_msg', async () => {
    const mounted = await mount()
    expect(
      await post(
        mounted.port,
        event({ message_id: 33, message_type: 'private', group_id: undefined, message: [{ type: 'text', data: { text: '在吗' } }] }),
      ),
    ).toBe(204)
    await wait()

    expect(mounted.prompted).toHaveLength(1)
    expect(mounted.calls[0]).toMatchObject({ action: 'send_private_msg', body: { user_id: '20002', message: 'onebot 回复' } })
  })
})
