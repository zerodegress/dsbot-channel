import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { ReverseLink } from '../src/adapters/onebot/ws-reverse.js'

interface Harness {
  port: number
  link: ReverseLink
  frames: Record<string, unknown>[]
  warnings: string[]
  failures: { auth: number; unknown: number; mismatch: number }
  close: () => Promise<void>
}

const servers: Server[] = []
const links: ReverseLink[] = []
const clients: WebSocket[] = []


/** A timer source a test walks by hand, so a ping window is walked, not slept through. */
function manualClock(): { clock: { setTimer: (run: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void }; advance: (ms: number) => Promise<void> } {
  let time = 0
  let seq = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    clock: {
      setTimer: (run, ms) => {
        const id = ++seq
        timers.set(id, { at: time + ms, run })
        return id
      },
      clearTimer: (handle) => {
        timers.delete(handle as number)
      },
    },
    advance: async (ms: number) => {
      const target = time + ms
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        time = due[1].at
        due[1].run()
        await new Promise((resolve) => setImmediate(resolve))
      }
      time = target
    },
  }
}

async function serve(
  path = '/onebot/ws',
  token?: string,
  selfId?: string,
  timeoutMs = 500,
  liveness?: { intervalMs: number; timeoutMs: number },
  clock?: { setTimer: (run: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void },
): Promise<Harness> {
  const failures = { auth: 0, unknown: 0, mismatch: 0 }
  const warnings: string[] = []
  const frames: Record<string, unknown>[] = []
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const link = new ReverseLink({
    path,
    ...(token === undefined ? {} : { token }),
    ...(selfId === undefined ? {} : { selfId }),
    maxFrameBytes: 1024 * 1024,
    timeoutMs,
    ...(liveness === undefined ? {} : { liveness }),
    ...(clock === undefined ? {} : { clock }),
    onEvent: (frame) => frames.push(frame),
    onMismatch: () => (failures.mismatch += 1),
    onAuthFailure: () => (failures.auth += 1),
    onUnknownPath: () => (failures.unknown += 1),
    warn: (message) => warnings.push(message),
  })
  links.push(link)
  link.attach(server)
  const port = (server.address() as AddressInfo).port
  return {
    port,
    link,
    frames,
    warnings,
    failures,
    close: async () => {
      link.close()
      for (const client of clients) client.terminate()
      clients.length = 0
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

function dial(
  port: number,
  path = '/onebot/ws',
  headers: Record<string, string> = {},
  options: { autoPong?: boolean } = {},
): WebSocket {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...options })
  client.on('error', () => undefined)
  clients.push(client)
  return client
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  while (servers.length > 0) {
    for (const client of clients) client.terminate()
    clients.length = 0
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const link of links.splice(0)) link.close()
})

describe('the reverse websocket link', () => {
  test('a client on another path is turned away and counted', async () => {
    const one = await serve()
    const client = dial(one.port, '/somewhere/else')
    await waitFor(() => one.failures.unknown === 1)
    expect(client.readyState).not.toBe(WebSocket.OPEN)
  })

  test('a missing or wrong token is refused', async () => {
    const one = await serve('/onebot/ws', 'shared-value')
    const client = dial(one.port)
    await waitFor(() => one.failures.auth === 1)
    expect(client.readyState).not.toBe(WebSocket.OPEN)

    const good = dial(one.port, '/onebot/ws', { authorization: 'Bearer shared-value' })
    await waitFor(() => good.readyState === WebSocket.OPEN)
    await waitFor(() => one.link.connection() !== undefined)
  })

  test('a claimed account that is not ours is refused', async () => {
    const one = await serve('/onebot/ws', undefined, '10001')
    const client = dial(one.port, '/onebot/ws', { 'x-self-id': '20002' })
    await waitFor(() => one.failures.auth === 1)
    expect(client.readyState).not.toBe(WebSocket.OPEN)
  })

  test('a second connection for the same account replaces the first, quietly once', async () => {
    const one = await serve('/onebot/ws', undefined, '10001')
    const first = dial(one.port, '/onebot/ws', { 'x-self-id': '10001' })
    await waitFor(() => one.link.connection() !== undefined)
    const second = dial(one.port, '/onebot/ws', { 'x-self-id': '10001' })
    await waitFor(() => first.readyState === WebSocket.CLOSED)
    await waitFor(() => second.readyState === WebSocket.OPEN)
    expect(one.warnings.filter((line) => line.includes('replaced')).length).toBe(1)
  })

  test('a second account is refused while one is connected', async () => {
    const one = await serve('/onebot/ws')
    dial(one.port, '/onebot/ws', { 'x-self-id': '10001' })
    await waitFor(() => one.link.connection() !== undefined)
    const other = dial(one.port, '/onebot/ws', { 'x-self-id': '20002' })
    await waitFor(() => one.failures.auth === 1)
    expect(other.readyState).not.toBe(WebSocket.OPEN)
    expect(one.link.connection()?.readyState).toBe(WebSocket.OPEN)
  })

  test('an action travels down the socket and is matched by echo', async () => {
    const one = await serve()
    const client = dial(one.port)
    await waitFor(() => one.link.connection() !== undefined)
    client.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { echo: string }
      client.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9 }, echo: frame.echo }))
    })

    const answer = await one.link.request('send_group_msg', { group_id: '1' }, 500)
    expect(answer).toMatchObject({ ok: true, frame: { status: 'ok', data: { message_id: 9 } } })
  })

  test('an action with nobody connected is unreachable', async () => {
    const one = await serve()
    expect(await one.link.request('send_group_msg', {}, 100)).toMatchObject({ ok: false, code: 'unreachable' })
  })

  test('an action without its own timeout uses the profile timeout', async () => {
    const one = await serve('/onebot/ws', undefined, undefined, 40)
    dial(one.port)
    await waitFor(() => one.link.connection() !== undefined)
    const started = Date.now()
    const answer = await one.link.request('get_status', {}, undefined)
    expect(answer).toMatchObject({ ok: false, code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(400)
  })

  test('a client that never answers a ping is dropped', async () => {
    const { clock, advance } = manualClock()
    const one = await serve('/onebot/ws', undefined, undefined, 500, { intervalMs: 20, timeoutMs: 25 }, clock)
    dial(one.port, '/onebot/ws', {}, { autoPong: false })
    await waitFor(() => one.link.connection() !== undefined)

    await advance(20)
    await advance(25)
    await waitFor(() => one.warnings.some((line) => line.includes('ping')), 3000)
    await waitFor(() => one.link.connection() === undefined, 3000)
  })

  test('a client that answers its pings is kept', async () => {
    const { clock, advance } = manualClock()
    const one = await serve('/onebot/ws', undefined, undefined, 500, { intervalMs: 20, timeoutMs: 25 }, clock)
    const client = dial(one.port)
    // The pong and this frame travel the same socket in order, so the frame proves the pong landed.
    client.on('ping', () => client.send(JSON.stringify({ post_type: 'message', message_id: 9002 })))
    await waitFor(() => one.link.connection() !== undefined)

    await advance(20)
    await waitFor(() => one.frames.length === 1)
    await advance(25)
    expect(one.link.connection()?.readyState).toBe(WebSocket.OPEN)
  })

  test('a disconnect during the wait for a pong is not reported as an unanswered ping', async () => {
    const { clock, advance } = manualClock()
    const one = await serve('/onebot/ws', undefined, undefined, 500, { intervalMs: 20, timeoutMs: 60 }, clock)
    const client = dial(one.port, '/onebot/ws', {}, { autoPong: false })
    client.on('ping', () => client.terminate())
    await waitFor(() => one.link.connection() !== undefined)

    await advance(20)
    await waitFor(() => one.link.connection() === undefined, 3000)
    await advance(60)
    expect(one.warnings.some((line) => line.includes('ping'))).toBe(false)
  })
})
