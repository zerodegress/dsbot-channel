import { afterEach, describe, expect, test } from 'vitest'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { ForwardLink } from '../src/adapters/onebot/ws-forward.js'

interface Harness {
  url: string
  sockets: WebSocket[]
  headers: (string | null)[]
  close: () => Promise<void>
}

const links: ForwardLink[] = []
const servers: Harness[] = []

async function serve(onConnection?: (socket: WebSocket, index: number) => void): Promise<Harness> {
  const sockets: WebSocket[] = []
  const headers: (string | null)[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  server.on('connection', (socket, request) => {
    sockets.push(socket)
    headers.push((request.headers.authorization as string | undefined) ?? null)
    onConnection?.(socket, sockets.length - 1)
  })
  const port = (server.address() as AddressInfo).port
  const harness: Harness = {
    url: `ws://127.0.0.1:${port}`,
    sockets,
    headers,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate()
        server.close(() => resolve())
      }),
  }
  servers.push(harness)
  return harness
}

function link(url: string, overrides: Partial<ConstructorParameters<typeof ForwardLink>[0]> = {}): ForwardLink {
  const one = new ForwardLink({
    apiUrl: url,
    reconnect: false,
    timeoutMs: 1000,
    maxFrameBytes: 1024 * 1024,
    onEvent: () => undefined,
    onMismatch: () => undefined,
    warn: () => undefined,
    ...overrides,
  })
  links.push(one)
  one.start()
  return one
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

afterEach(async () => {
  for (const one of links.splice(0)) one.close()
  for (const harness of servers.splice(0)) await harness.close()
})

describe('the forward websocket link', () => {
  test('dials out with the bearer token and hands events to the adapter', async () => {
    const events: Record<string, unknown>[] = []
    const harness = await serve()
    const one = link(harness.url, { token: 'shared-value', onEvent: (frame) => events.push(frame) })

    await waitFor(() => harness.sockets.length === 1)
    await waitFor(() => one.health().state === 'online')
    harness.sockets[0]!.send(JSON.stringify({ post_type: 'message', message_type: 'group' }))

    await waitFor(() => events.length === 1)
    expect(events[0]).toMatchObject({ post_type: 'message', message_type: 'group' })
    expect(harness.headers[0]).toBe('Bearer shared-value')
  })

  test('a second socket carries events while the first one carries actions', async () => {
    const events: Record<string, unknown>[] = []
    const harness = await serve()
    const one = link(harness.url, {
      eventUrl: undefined,
      onEvent: (frame) => events.push(frame),
    })
    await waitFor(() => harness.sockets.length === 1)
    harness.sockets[0]!.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }))
    await waitFor(() => events.length === 1)

    harness.sockets[0]!.send(JSON.stringify({ post_type: 'message' }))
    await waitFor(() => events.length === 2)
    expect(one.health().state).toBe('online')
  })

  test('an action is matched by its echo and hands back the frame', async () => {
    const harness = await serve((socket) => {
      socket.on('message', (raw: Buffer) => {
        const request = JSON.parse(raw.toString()) as { echo: string }
        socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 77 }, echo: request.echo }))
      })
    })
    const one = link(harness.url)
    await waitFor(() => one.health().state === 'online')

    const answer = await one.request('send_group_msg', { group_id: '1' }, 500)
    expect(answer.ok).toBe(true)
    if (answer.ok) expect(answer.frame).toMatchObject({ status: 'ok', data: { message_id: 77 } })
  })

  test('a failed status comes back as a rejection with its message', async () => {
    const harness = await serve((socket) => {
      socket.on('message', (raw: Buffer) => {
        const request = JSON.parse(raw.toString()) as { echo: string }
        socket.send(JSON.stringify({ status: 'failed', retcode: 1404, message: '记录不存在', echo: request.echo }))
      })
    })
    const one = link(harness.url)
    await waitFor(() => one.health().state === 'online')

    const answer = await one.request('get_friend_msg_history', {}, 500)
    expect(answer).toMatchObject({ ok: false, code: 'rejected', reason: '记录不存在' })
  })

  test('an answer that never comes times out', async () => {
    const harness = await serve()
    const one = link(harness.url)
    await waitFor(() => one.health().state === 'online')

    expect(await one.request('get_status', {}, 30)).toMatchObject({ ok: false, code: 'timeout' })
  })

  test('a frame that is neither an event nor an answer is reported as a mismatch', async () => {
    let mismatches = 0
    const harness = await serve()
    link(harness.url, { onMismatch: () => (mismatches += 1) })
    await waitFor(() => harness.sockets.length === 1)

    harness.sockets[0]!.send(JSON.stringify({ hello: 'world' }))
    await waitFor(() => mismatches === 1)
  })

  test('a dropped socket comes back on its own, and the health says so', async () => {
    const harness = await serve((socket, index) => {
      if (index === 0) setTimeout(() => socket.terminate(), 20)
    })
    const one = link(harness.url, { reconnect: { initialMs: 10, maxMs: 20, factor: 1 } })

    await waitFor(() => harness.sockets.length >= 2, 3000)
    await waitFor(() => one.health().state === 'online', 3000)
    expect(one.health().reconnectCount).toBeGreaterThanOrEqual(1)
  })

  test('a frame above the limit closes the socket and warns once', async () => {
    const warnings: string[] = []
    const harness = await serve()
    link(harness.url, { maxFrameBytes: 16, warn: (message) => warnings.push(message) })
    await waitFor(() => harness.sockets.length === 1)

    harness.sockets[0]!.send(JSON.stringify({ post_type: 'message', padding: 'x'.repeat(64) }))
    await waitFor(() => warnings.length === 1)
    expect(warnings[0]).toContain('size limit')
  })
})
