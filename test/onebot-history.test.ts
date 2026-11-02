import { afterEach, describe, expect, test, vi } from 'vitest'
import { OneBotAdapter } from '../src/adapters/onebot/adapter.js'
import type { AdapterPorts } from '../src/contract.js'

let adapter: OneBotAdapter | undefined

function config(history: { group: boolean; private: boolean }) {
  return {
    channel: 'onebot:a',
    instance: 'inst-a',
    botName: 'bot-a',
    listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
    api: { url: 'http://127.0.0.1:9', timeoutMs: 1000 },
    sendTimeoutMs: 1000,
    history,
    bots: [],
  }
}

async function started(history = { group: true, private: true }): Promise<OneBotAdapter> {
  adapter = new OneBotAdapter(config(history))
  await adapter.start({ onMessage: () => Promise.resolve({ ok: true }), resolveSecret: () => Promise.resolve(undefined) } as AdapterPorts)
  return adapter
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function recordMessage(id: number, text: string, seq: string, time = 1000) {
  return {
    message_id: id,
    message_seq: seq,
    time,
    sender: { user_id: 9000 + id, card: '', nickname: `n${id}` },
    message: [{ type: 'text', data: { text } }],
  }
}

afterEach(async () => {
  await adapter?.stop()
  adapter = undefined
  vi.unstubAllGlobals()
})

describe('history over the OneBot api', () => {
  test('maps a page of messages and offers the oldest cursor as the next page', async () => {
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(String(url))
      return json({ status: 'ok', retcode: 0, data: { messages: [recordMessage(1, 'one', 's1'), recordMessage(2, 'two', 's2')] } })
    })
    const onebot = await started()

    const page = await onebot.history({ target: 'group:12345', limit: 2 })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.records).toHaveLength(2)
    expect(page.records[0]).toMatchObject({ messageId: '1', cursor: 's1', timestamp: 1_000_000, senderId: '9001', nickname: 'n1', text: 'one' })
    expect(page.records[1]).toMatchObject({ messageId: '2', cursor: 's2', text: 'two' })
    expect(page.next).toBe('s1')
    expect(seen[0]).toContain('/get_group_msg_history')
  })

  test('sends the group and the private address to their own actions and params', async () => {
    const bodies: { url: string; body: Record<string, unknown> }[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      bodies.push({ url: String(url), body: JSON.parse(String(init.body)) as Record<string, unknown> })
      return json({ status: 'ok', retcode: 0, data: { messages: [] } })
    })
    const onebot = await started()

    await onebot.history({ target: 'group:12345', limit: 10 })
    await onebot.history({ target: 'peer:999', before: 's9', limit: 10 })

    expect(bodies[0]!.url).toContain('/get_group_msg_history')
    expect(bodies[0]!.body).toEqual({ group_id: '12345', count: 10 })
    expect(bodies[1]!.url).toContain('/get_friend_msg_history')
    expect(bodies[1]!.body).toEqual({ user_id: '999', count: 10, message_seq: 's9' })
  })

  test('an empty page is a success with no next cursor', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'ok', retcode: 0, data: { messages: [] } }))
    const onebot = await started()

    expect(await onebot.history({ target: 'group:1', limit: 5 })).toEqual({ ok: true, records: [] })
  })

  test('a status ok answer without data is still a success', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'ok', retcode: 0 }))
    const onebot = await started()

    expect(await onebot.history({ target: 'group:1', limit: 5 })).toEqual({ ok: true, records: [] })
  })

  test('says the list ended only for the message-not-found answer', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'failed', retcode: 1404, message: '消息不存在' }))
    const onebot = await started()

    expect(await onebot.history({ target: 'group:1', limit: 5 })).toEqual({ ok: true, records: [] })
  })

  test('a missing record is a failure, not an empty page', async () => {
    vi.stubGlobal('fetch', async () => json({ status: 'failed', retcode: 1404, message: '记录不存在' }))
    const onebot = await started()

    const page = await onebot.history({ target: 'peer:1', limit: 5 })
    expect(page).toMatchObject({ ok: false, code: 'rejected' })
  })

  test('an implementation without the action answers unsupported', async () => {
    vi.stubGlobal('fetch', async () => new Response('not found', { status: 404 }))
    const onebot = await started()

    const page = await onebot.history({ target: 'peer:1', limit: 5 })
    expect(page).toMatchObject({ ok: false, code: 'unsupported' })
  })

  test('three pages cover every message exactly once', async () => {
    const all = [1, 2, 3, 4, 5, 6, 7].map((id) => recordMessage(id, `m${id}`, `s${id}`))
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      const params = JSON.parse(String(init.body)) as { message_seq?: string }
      const before = params.message_seq === undefined ? undefined : all.findIndex((one) => one.message_seq === params.message_seq)
      const end = before === undefined ? all.length : before
      const start = Math.max(0, end - 3)
      return json({ status: 'ok', retcode: 0, data: { messages: all.slice(start, end) } })
    })
    const onebot = await started()

    const collected: string[] = []
    let before: string | undefined
    for (let page = 0; page < 5; page += 1) {
      const answered = await onebot.history({ target: 'group:1', limit: 3, ...(before === undefined ? {} : { before }) })
      expect(answered.ok).toBe(true)
      if (!answered.ok) return
      collected.push(...answered.records.map((one) => one.messageId))
      if (answered.next === undefined) break
      before = answered.next
    }

    expect(collected).toEqual(['5', '6', '7', '2', '3', '4', '1'])
    expect(new Set(collected).size).toBe(collected.length)
  })
})
