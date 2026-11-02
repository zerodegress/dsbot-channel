import { describe, expect, test } from 'vitest'
import { mapOneBotEvent } from '../src/adapters/onebot/adapter.js'
import type { OneBotAdapterConfig, OneBotEvent } from '../src/adapters/onebot/adapter.js'

const config: OneBotAdapterConfig = {
  channel: 'onebot:a',
  instance: 'inst-a',
  botName: 'bot-a',
  selfId: '10001',
  listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
  api: { url: 'http://127.0.0.1:1', timeoutMs: 1000 },
  sendTimeoutMs: 1000,
  bots: ['20002'],
}

function event(overrides: Partial<OneBotEvent> = {}): OneBotEvent {
  return {
    post_type: 'message',
    message_type: 'group',
    self_id: 10001,
    message_id: 1,
    user_id: 20002,
    group_id: 12345,
    time: 1_700_000_000,
    message: [{ type: 'text', data: { text: '你好' } }],
    sender: { nickname: '阿明', card: '名片' },
    ...overrides,
  }
}

const noChain = (): undefined => undefined

describe('what an onebot event becomes', () => {
  test('a group message carries its group, its sender and a framed body', () => {
    const message = mapOneBotEvent(event(), config, noChain)!
    expect(message.source).toEqual({ kind: 'onebot', instance: 'inst-a', peer: '12345', scope: 'group' })
    expect(message.sessionKey).toBe('group:12345')
    expect(message.replyTarget).toBe('group:12345')
    expect(message.requestId).toBe('1')
    expect(message.eventKey).toBe('group:12345:1')
    expect(message.rawText).toBe('你好')
    expect(message.body.text).toBe('[onebot from 名片 · 20002 · 1] 你好')
    expect(message.author).toEqual({ senderId: '20002', kind: 'bot', personId: null })
    expect(message.transport.timestamp).toBe(1_700_000_000_000)
  })

  test('a private message is a c2c conversation, even when it starts from a group', () => {
    const privateOne = mapOneBotEvent(event({ message_type: 'private', sub_type: 'group', group_id: undefined }), config, noChain)!
    expect(privateOne.source.scope).toBe('c2c')
    expect(privateOne.sessionKey).toBe('peer:20002')

    const friend = mapOneBotEvent(event({ message_type: 'private', sub_type: 'friend', group_id: undefined }), config, noChain)!
    expect(friend.source.scope).toBe('c2c')
  })

  test('the mention report comes from the message array only', () => {
    const at = (qq: string) => ({ type: 'at', data: { qq } })
    const text = { type: 'text', data: { text: 'hi' } }

    expect(mapOneBotEvent(event({ message: [at('10001'), text] }), config, noChain)!.transport.mentioned).toEqual({
      self: true,
      others: false,
      all: false,
    })
    expect(mapOneBotEvent(event({ message: [at('10001'), at('40004'), at('all'), text] }), config, noChain)!.transport.mentioned).toEqual(
      { self: true, others: true, all: true },
    )
    expect(mapOneBotEvent(event({ message: [text] }), config, noChain)!.transport.mentioned).toEqual({
      self: false,
      others: false,
      all: false,
    })
  })

  test('a hand-typed nickname produces no mention', () => {
    const message = mapOneBotEvent(
      event({ message: [{ type: 'text', data: { text: '@机器人 你好' } }], raw_message: '@机器人 你好' }),
      config,
      noChain,
    )!
    expect(message.transport.mentioned).toEqual({ self: false, others: false, all: false })
    expect(message.rawText).toBe('@机器人 你好')
  })

  test('a reply names the message it answers and inherits a known chain', () => {
    const chainOf = (messageId: string): string | undefined => (messageId === '88001' ? 'group:12345:5' : undefined)
    const known = mapOneBotEvent(
      event({ message: [{ type: 'reply', data: { id: '88001' } }, { type: 'text', data: { text: '回你' } }] }),
      config,
      chainOf,
    )!
    expect(known.body.replyTo).toBe('88001')
    expect(known.transport.isReply).toBe(true)
    expect(known.chainId).toBe('group:12345:5')

    const unknown = mapOneBotEvent(
      event({ message: [{ type: 'reply', data: { id: '99999' } }] }),
      config,
      noChain,
    )!
    expect(unknown.chainId).toBe(unknown.eventKey)
  })

  test('media keeps what it can address and drops what it cannot', () => {
    const drops: string[] = []
    const good = mapOneBotEvent(
      event({
        message: [
          { type: 'image', data: { url: 'https://example.test/a.png', file: 'ab12.image' } },
          { type: 'record', data: { file: 'ab12.amr' } },
          { type: 'file', data: { url: 'https://example.test/b.bin', file: 'bad name.bin' } },
          { type: 'image', data: { file: 'with space.image' } },
        ],
      }),
      config,
      noChain,
      (line) => drops.push(line),
    )!
    expect(good.body.media).toEqual([
      { type: 'image', url: 'https://example.test/a.png' },
      { type: 'file', url: 'https://example.test/b.bin' },
    ])
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatch(/dropped 2 onebot media reference\(s\) .* that carried no url/)
  })

  test('an event for another account is dropped with a warning', () => {
    const drops: string[] = []
    const message = mapOneBotEvent(event({ self_id: 99999 }), config, noChain, (line) => drops.push(line))
    expect(message).toBeUndefined()
    expect(drops[0]).toMatch(/dropped an onebot event for account 99999: this adapter answers for 10001/)
  })

  test('the receive time comes from the injected clock', () => {
    const message = mapOneBotEvent(event(), config, noChain, undefined, () => 42)
    expect(message?.receivedAt).toBe(42)
  })

  test('an event that is not a message is not handed over at all', () => {
    expect(mapOneBotEvent(event({ post_type: 'notice' }), config, noChain)).toBeUndefined()
    expect(mapOneBotEvent(event({ post_type: 'meta_event' }), config, noChain)).toBeUndefined()
  })

  test('the raw text never carries CQ codes from the at segment', () => {
    const message = mapOneBotEvent(
      event({
        message: [
          { type: 'at', data: { qq: '10001' } },
          { type: 'text', data: { text: ' 你好' } },
        ],
        raw_message: '[CQ:at,qq=10001] 你好',
      }),
      config,
      noChain,
    )!
    expect(message.rawText).toBe(' 你好')
    expect(message.rawText).not.toContain('[CQ:')
    expect(message.body.text).not.toContain('[CQ:')
  })

  test('a pure at with no text still becomes a message', () => {
    const message = mapOneBotEvent(event({ message: [{ type: 'at', data: { qq: '10001' } }] }), config, noChain)!
    expect(message.rawText).toBe('')
    expect(message.body.text).toBe('[onebot from 名片 · 20002 · 1]')
    expect(message.transport.mentioned.self).toBe(true)
  })
})
