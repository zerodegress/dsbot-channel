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

async function serve(onConnection?: (socket: WebSocket, index: number) => void, autoPong = true): Promise<Harness> {
  const sockets: WebSocket[] = []
  const headers: (string | null)[] = []
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong })
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

  test('a backoff window is reported as reconnecting, not as offline', async () => {
    const harness = await serve((socket, index) => {
      if (index === 0) setTimeout(() => socket.terminate(), 20)
    })
    const one = link(harness.url, { reconnect: { initialMs: 200, maxMs: 200, factor: 1 } })

    await waitFor(() => one.health().state === 'reconnecting', 3000)
    expect(one.health().lastFailure).not.toBeNull()
  })

  test('online needs the event socket too when one is named', async () => {
    const api = await serve()
    const dead = await serve()
    const deadPort = dead.url.split(':').pop()
    await dead.close()
    servers.splice(servers.indexOf(dead), 1)

    const one = link(api.url, { eventUrl: `ws://127.0.0.1:${deadPort}/onebot/event` })
    await waitFor(() => api.sockets.length === 1)
    await waitFor(() => one.health().lastFailure !== null)
    expect(one.health().state).not.toBe('online')
  })

  test('the event socket does not outlive the api socket', async () => {
    const api = await serve((socket) => setTimeout(() => socket.terminate(), 30))
    const events = await serve()
    const one = link(api.url, { eventUrl: events.url, reconnect: false })
    await waitFor(() => events.sockets.length >= 1)
    await waitFor(() => one.health().state === 'offline', 3000)
    await waitFor(() => events.sockets.every((socket) => socket.readyState !== 1), 3000)
    expect(events.sockets.length).toBe(1)
  })

  test('a frame above the limit closes the socket it arrived on, not the other one', async () => {
    const api = await serve()
    const events = await serve()
    const one = link(api.url, { eventUrl: events.url, maxFrameBytes: 32 })
    await waitFor(() => one.health().state === 'online', 3000)
    expect(one.health().state).toBe('online')

    events.sockets[0]!.send(JSON.stringify({ post_type: 'message', padding: 'x'.repeat(128) }))
    await waitFor(() => events.sockets[0]?.readyState !== 1, 3000)
    await waitFor(() => api.sockets[0]?.readyState === 1)
  })

  test('an event socket waiting to come back reports reconnecting too', async () => {
    const api = await serve()
    const events = await serve()
    const one = link(api.url, { eventUrl: events.url })
    await waitFor(() => one.health().state === 'online', 3000)

    events.sockets[0]!.terminate()
    await waitFor(() => one.health().state === 'reconnecting', 500)
    await waitFor(() => one.health().state === 'online', 3000)
  })

  test('a socket that never answers a ping is closed', async () => {
    const warnings: string[] = []
    const { clock, advance } = manualClock()
    const harness = await serve(undefined, false)
    const one = link(harness.url, { liveness: { intervalMs: 20, timeoutMs: 25 }, clock, warn: (m) => warnings.push(m) })
    await waitFor(() => one.health().state === 'online')

    await advance(20)
    await advance(25)
    await waitFor(() => warnings.some((line) => line.includes('ping')))
    await waitFor(() => one.health().state === 'offline', 3000)
  })

  test('a socket that answers its pings is left alone', async () => {
    const { clock, advance } = manualClock()
    const frames: Record<string, unknown>[] = []
    const harness = await serve()
    const one = link(harness.url, { liveness: { intervalMs: 20, timeoutMs: 25 }, clock, onEvent: (f) => frames.push(f) })
    await waitFor(() => one.health().state === 'online')
    // The pong and this frame travel the same socket in order, so seeing the frame proves the
    // pong was handled before the deadline is walked past; no timing luck involved.
    harness.sockets[0]!.on('ping', () => {
      harness.sockets[0]!.send(JSON.stringify({ post_type: 'message', message_id: 9001 }))
    })

    await advance(20)
    await waitFor(() => frames.length === 1)
    await advance(25)
    expect(one.health().state).toBe('online')
  })

  test('a disconnect during the wait for a pong is not reported as an unanswered ping', async () => {
    const warnings: string[] = []
    const { clock, advance } = manualClock()
    const harness = await serve(undefined, false)
    const one = link(harness.url, { liveness: { intervalMs: 20, timeoutMs: 60 }, clock, warn: (m) => warnings.push(m) })
    await waitFor(() => one.health().state === 'online')
    harness.sockets[0]!.on('ping', () => harness.sockets[0]!.terminate())

    await advance(20)
    await waitFor(() => one.health().state === 'offline', 3000)
    await advance(60)
    expect(warnings.some((line) => line.includes('ping'))).toBe(false)
  })
})
