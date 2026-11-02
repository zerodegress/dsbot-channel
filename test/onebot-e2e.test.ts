import { afterEach, describe, expect, test } from 'vitest'
import { registryPlugin } from '../src/registry-plugin.js'
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

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

interface Mounted {
  ctx: Context
  port: number
  apiPort: number
  prompted: string[]
  calls: { action: string; body: Record<string, unknown> }[]
  tools: ToolLike[]
}

async function mount(policy: Record<string, unknown> = {}, bots: string[] = []): Promise<Mounted> {
  const tools: ToolLike[] = []
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
          emit({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'onebot 回复' }] } } })
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
        instance: 'inst-a',
        botName: 'bot-a',
        policy,
        transport: {
          selfId: '10001',
          listen: { host: '127.0.0.1', port },
          api: { url: `http://127.0.0.1:${apiPort}` },
          accessToken: REF,
          bots,
        },
      },
    ],
  })
  disposers.push(() => fork.dispose())
  return { ctx, port, apiPort, prompted, calls, tools }
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

/** Lets the pending callbacks run when a case asserts that nothing happened. */
function drain(): Promise<void> {
  return new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve)))
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting for the onebot round trip')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('an onebot group message through the mounted plugin', () => {
  test('runs a turn and answers through send_group_msg', async () => {
    const mounted = await mount()
    expect(await post(mounted.port, event())).toBe(204)
    await waitFor(() => mounted.calls.length > 0)

    expect(mounted.prompted).toHaveLength(1)
    expect(mounted.prompted[0]).toContain('[onebot from 阿明 · 20002 · 31]  帮我看看')
    expect(mounted.calls[0]).toMatchObject({ action: 'send_group_msg', body: { group_id: '12345', message: 'onebot 回复' } })
  })

  test('requireMention refuses a group message that names nobody', async () => {
    const mounted = await mount({ requireMention: true })
    expect(await post(mounted.port, event({ message_id: 32, message: [{ type: 'text', data: { text: '随便聊聊' } }] }))).toBe(204)
    await drain()

    expect(mounted.prompted).toHaveLength(0)
    expect(mounted.calls).toHaveLength(0)
  })

  test('the raw payload never reaches the turn', async () => {
    const mounted = await mount()
    expect(
      await post(
        mounted.port,
        event({
          message_id: 34,
          raw_message: '[CQ:at,qq=10001] 看图[CQ:image,file=ab12.image]',
          message: [
            { type: 'at', data: { qq: '10001' } },
            { type: 'text', data: { text: ' 看图' } },
            { type: 'image', data: { file: 'ab12.image' } },
          ],
        }),
      ),
    ).toBe(204)
    await waitFor(() => mounted.prompted.length > 0)

    expect(mounted.prompted[0]).toContain('看图')
    expect(mounted.prompted[0]).not.toContain('[CQ:')
  })

  test('a private message answers through send_private_msg', async () => {
    const mounted = await mount()
    expect(
      await post(
        mounted.port,
        event({ message_id: 33, message_type: 'private', group_id: undefined, message: [{ type: 'text', data: { text: '在吗' } }] }),
      ),
    ).toBe(204)
    await waitFor(() => mounted.calls.length > 0)

    expect(mounted.prompted).toHaveLength(1)
    expect(mounted.calls[0]).toMatchObject({ action: 'send_private_msg', body: { user_id: '20002', message: 'onebot 回复' } })
  })
})

describe('the reply ceiling in a group', () => {
  test('a bot that answers twice in a row is stopped, and a person speaking frees it', async () => {
    const mounted = await mount({ relayLimit: 1 }, ['20002'])
    const turns = mounted.ctx.get('dsbot-channel.turns') as {
      snapshot(): { recent: { eventKey: string; outcome: string }[] }
    }

    expect(await post(mounted.port, event({ message_id: 41 }))).toBe(204)
    await waitFor(() => turns.snapshot().recent.some((one) => one.outcome === 'replied'))

    expect(await post(mounted.port, event({ message_id: 42 }))).toBe(204)
    await waitFor(() => turns.snapshot().recent.some((one) => one.outcome === 'rejected'))
    expect(mounted.prompted).toHaveLength(1)

    expect(await post(mounted.port, event({ message_id: 43, user_id: 40004 }))).toBe(204)
    await waitFor(() => mounted.prompted.length === 2)
  })
})

describe('an address that carries its own destination', () => {
  test('a group address and a private address each take their own api action', async () => {
    const mounted = await mount()
    const tool = mounted.tools.find((one) => one.name === 'send_text')
    expect(tool).toBeDefined()

    const group = JSON.parse((await tool!.execute({ text: 'to the group', channel: 'onebot:a', target: 'group:30003' }, {})) as string)
    expect(group).toMatchObject({ ok: true, target: 'group:30003' })
    expect(mounted.calls[0]).toMatchObject({ action: 'send_group_msg', body: { group_id: '30003', message: 'to the group' } })

    const priv = JSON.parse((await tool!.execute({ text: 'to one member', channel: 'onebot:a', target: 'peer:20002' }, {})) as string)
    expect(priv).toMatchObject({ ok: true, target: 'peer:20002' })
    expect(mounted.calls[1]).toMatchObject({ action: 'send_private_msg', body: { user_id: '20002', message: 'to one member' } })
  })
})

describe('an OneBot link that carries no media or history yet', () => {
  test('each of the three tools answers with the capability the channel lacks', async () => {
    const mounted = await mount()
    const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const tool = mounted.tools.find((one) => one.name === name)
      expect(tool).toBeDefined()
      return JSON.parse(String(await tool?.execute(args, {}))) as Record<string, unknown>
    }

    const image = await call('send_image', { url: 'https://example.test/a.png', channel: 'onebot:a', target: 'group:30003' })
    const file = await call('send_file', { url: 'https://example.test/a.txt', channel: 'onebot:a', target: 'group:30003' })
    const history = await call('read_history', { channel: 'onebot:a', target: 'group:30003', limit: 10 })

    expect(image).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(image.reason).toContain('declares capabilities.image')
    expect(image.reason).toContain('onebot:a')
    expect(file).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(file.reason).toContain('declares capabilities.file')
    expect(file.reason).toContain('onebot:a')
    expect(history).toMatchObject({ ok: false, code: 'unsupported_capability' })
    expect(history.reason).toContain('capabilities.history is false')
    expect(history.reason).toContain('onebot:a')
    expect(mounted.calls).toHaveLength(0)
  })
})
