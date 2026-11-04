import { afterEach, describe, expect, test, vi } from 'vitest'
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js'
import type { AdapterPorts, SendInput } from '../src/contract.js'

let adapter: OneBotAdapter | undefined

function config(fileFromUrl: boolean) {
  return {
    channel: 'inst-a',
    botName: 'bot-a',
    listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
    api: { url: 'http://127.0.0.1:9', timeoutMs: 1000 },
    sendTimeoutMs: 1000,
    protocol: 'http' as const,
    fileFromUrl,
    bots: [],
  }
}

async function started(fileFromUrl: boolean): Promise<OneBotAdapter> {
  adapter = new OneBotAdapter(config(fileFromUrl))
  await adapter.start({
    onMessage: () => Promise.resolve({ ok: true }),
    resolveSecret: () => Promise.resolve(undefined),
  } as AdapterPorts)
  return adapter
}

function send(target: string, file: { url?: string; handle?: string; name?: string }): SendInput {
  return {
    target,
    body: '',
    eventId: 'e-1',
    chainId: 'c-1',
    sender: 'bot-a',
    instance: 'inst-a',
    media: [
      {
        type: 'file',
        url: file.url ?? null,
        handle: file.handle ?? null,
        ...(file.name === undefined ? {} : { name: file.name }),
      },
    ],
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

afterEach(async () => {
  await adapter?.stop()
  adapter = undefined
  vi.unstubAllGlobals()
})

describe('sending a file over the OneBot api', () => {
  test('a url is refused when the profile did not open fileFromUrl', async () => {
    let called = 0
    vi.stubGlobal('fetch', async () => {
      called += 1
      return json({ status: 'ok', data: {} })
    })
    const onebot = await started(false)

    const sent = await onebot.send(send('group:1', { url: 'https://example.test/a.txt', name: 'a.txt' }))
    expect(sent).toMatchObject({ ok: false, code: 'unsupported' })
    expect(called).toBe(0)
  })

  test('a url becomes the file field when the profile opened it', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return json({ status: 'ok', data: { file_id: 'f-1' } })
    })
    const onebot = await started(true)

    const sent = await onebot.send(send('group:1', { url: 'https://example.test/a.txt', name: 'a.txt' }))
    expect(sent).toEqual({ ok: true, messageId: 'f-1', duplicate: false })
    expect(seen[0]!.url).toContain('/upload_group_file')
    expect(seen[0]!.body).toEqual({ group_id: '1', file: 'https://example.test/a.txt', name: 'a.txt' })
  })

  test('a private chat goes to its own action', async () => {
    const seen: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return json({ status: 'ok', data: {} })
    })
    const onebot = await started(false)

    const sent = await onebot.send(send('peer:9', { handle: 'token-1', name: 'a.txt' }))
    expect(sent.ok).toBe(true)
    expect(seen[0]!.url).toContain('/upload_private_file')
    expect(seen[0]!.body).toEqual({ user_id: '9', file: 'token-1', name: 'a.txt' })
  })

  test('the receipt is the file id, then the message id, then a local one', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'ok', data: { file_id: 'f-1', message_id: 'm-1' } }))
    const onebot = await started(false)
    expect(await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))).toMatchObject({ messageId: 'f-1' })

    vi.stubGlobal('fetch', async () => json({ status: 'ok', data: { message_id: 'm-1' } }))
    expect(await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))).toMatchObject({ messageId: 'm-1' })

    vi.stubGlobal('fetch', async () => json({ status: 'ok' }))
    const local = await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))
    const again = await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))
    expect(local.ok).toBe(true)
    expect(again.ok).toBe(true)
    if (local.ok) expect(local.messageId.startsWith('local:')).toBe(true)
    if (local.ok) expect(local.messageId.length).toBeGreaterThan('local:'.length)
    if (local.ok && again.ok) expect(local.messageId).not.toBe(again.messageId)
  })

  test('a file without a name is refused before any call', async () => {
    let called = 0
    vi.stubGlobal('fetch', async () => {
      called += 1
      return json({ status: 'ok' })
    })
    const onebot = await started(false)

    expect(await onebot.send(send('peer:1', { handle: 'h' }))).toMatchObject({ ok: false })
    expect(called).toBe(0)
  })

  test('a missing record is a rejection, not an unknown action', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'failed', message: '记录不存在' }))
    const onebot = await started(false)

    const sent = await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))
    expect(sent).toMatchObject({ ok: false, code: 'rejected' })
  })

  test('an implementation without the action answers unsupported', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }))
    const onebot = await started(false)

    const sent = await onebot.send(send('peer:1', { handle: 'h', name: 'a.txt' }))
    expect(sent).toMatchObject({ ok: false, code: 'unsupported' })
  })
})
