import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { ReverseLink } from '../src/adapters/onebot/ws-reverse.js'

interface Harness {
  port: number
  link: ReverseLink
  warnings: string[]
  failures: { auth: number; unknown: number; mismatch: number }
  close: () => Promise<void>
}

const servers: Server[] = []
const links: ReverseLink[] = []
const clients: WebSocket[] = []

async function serve(path = '/onebot/ws', token?: string, selfId?: string): Promise<Harness> {
  const failures = { auth: 0, unknown: 0, mismatch: 0 }
  const warnings: string[] = []
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const link = new ReverseLink({
    path,
    ...(token === undefined ? {} : { token }),
    ...(selfId === undefined ? {} : { selfId }),
    maxFrameBytes: 1024 * 1024,
    onEvent: () => undefined,
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

function dial(port: number, path = '/onebot/ws', headers: Record<string, string> = {}): WebSocket {
  const client = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
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
    await waitFor(() => one.link.connection() !== undefined)
    expect(good.readyState).toBe(WebSocket.OPEN)
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
})
