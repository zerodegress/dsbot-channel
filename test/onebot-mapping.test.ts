import { describe, expect, test } from 'vitest'
import { mapOneBotEvent, oneBotEventClass } from '../src/adapters/onebot/adapter.js'
import type { OneBotAdapterConfig, OneBotEvent } from '../src/adapters/onebot/adapter.js'

const config: OneBotAdapterConfig = {
  channel: 'onebot:a',
  botName: 'bot-a',
  selfId: '10001',
  listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
  api: { url: 'http://127.0.0.1:1', timeoutMs: 1000 },
  sendTimeoutMs: 1000,
    protocol: 'http' as const,
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
    expect(message.source).toEqual({ kind: 'onebot', instance: 'onebot:a', peer: '12345', scope: 'group' })
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
          { type: 'image', data: { file: 'ab12.image' } },
          { type: 'record', data: { file: 'ab12.amr' } },
          { type: 'file', data: {} },
        ],
      }),
      config,
      noChain,
      (line) => drops.push(line),
    )!
    expect(good.body.media).toEqual([
      { type: 'image', url: 'https://example.test/a.png', handle: 'ab12.image', owner: { kind: 'onebot', instance: 'onebot:a' } },
      { type: 'image', url: null, handle: 'ab12.image', owner: { kind: 'onebot', instance: 'onebot:a' } },
      { type: 'voice', url: null, handle: 'ab12.amr', owner: { kind: 'onebot', instance: 'onebot:a' } },
    ])
    expect(drops).toHaveLength(1)
    expect(drops[0]).toMatch(/dropped 1 onebot media reference\(s\) .* that carried neither a url nor a file name/)
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

  test('an event that is not a message keeps its own kind', () => {
    expect(mapOneBotEvent(event({ post_type: 'notice', notice_type: 'group_recall' }), config, noChain)!.kind).toBe('notice')
    expect(mapOneBotEvent(event({ post_type: 'meta_event', meta_event_type: 'heartbeat' }), config, noChain)!.kind).toBe('meta')
    expect(mapOneBotEvent(event({ post_type: 'something_else' }), config, noChain)).toBeUndefined()
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

describe('the non-message events a link reads', () => {
  const recall = (): OneBotEvent =>
    event({
      post_type: 'notice',
      notice_type: 'group_recall',
      message_id: 30003,
      user_id: 20002,
      group_id: 12345,
      time: 1_700_000_100,
    })

  test('a recall becomes a notice with a one-line summary and no raw payload', () => {
    const notice = mapOneBotEvent(recall(), config, noChain)!
    expect(notice.kind).toBe('notice')
    expect(notice.event).toEqual({ postType: 'notice', type: 'group_recall' })
    expect(notice.sessionKey).toBe('group:12345')
    expect(notice.rawText).toBe('[onebot notice: group_recall] user 20002 recalled message 30003 in group 12345')
    expect(notice.body).toEqual({ text: notice.rawText, media: [], replyTo: null })
    expect(notice.adapter).toEqual({})
  })

  test('the same event maps onto the same key, and another recall differs', () => {
    const first = mapOneBotEvent(recall(), config, noChain)!
    const again = mapOneBotEvent(recall(), config, noChain)!
    const other = mapOneBotEvent(event({ ...recall(), message_id: 30004 }), config, noChain)!
    expect(again.eventKey).toBe(first.eventKey)
    expect(other.eventKey).not.toBe(first.eventKey)
    expect(first.eventKey).toMatch(/^[-:A-Za-z0-9_.]+$/)
    expect(first.requestId).toBe(first.eventKey)
  })

  test('a ban names its operator and target, and keeps its subtype', () => {
    const ban = mapOneBotEvent(
      event({
        post_type: 'notice',
        notice_type: 'group_ban',
        sub_type: 'ban',
        operator_id: 10001,
        target_id: 40004,
        group_id: 12345,
        time: 1_700_000_200,
      }),
      config,
      noChain,
    )!
    expect(ban.kind).toBe('notice')
    expect(ban.event).toEqual({ postType: 'notice', type: 'group_ban', subType: 'ban' })
    expect(ban.rawText).toBe('[onebot notice: group_ban] operator 10001 banned user 20002 in group 12345')
  })

  test('a friend request keeps its comment on one bounded line', () => {
    const ask = mapOneBotEvent(
      event({
        post_type: 'request',
        request_type: 'friend',
        user_id: 20002,
        group_id: undefined,
        comment: 'hello\nworld',
        flag: 'flag-1',
        time: 1_700_000_300,
      }),
      config,
      noChain,
    )!
    expect(ask.kind).toBe('request')
    expect(ask.sessionKey).toBe('peer:20002')
    expect(ask.rawText).toBe('[onebot request: friend] user 20002 asked to be a friend: hello world')
    expect(ask.rawText).not.toContain('\n')
  })

  test('our own sent message is a notice, never a message', () => {
    const sent = mapOneBotEvent(
      event({
        post_type: 'message_sent',
        message_type: 'group',
        message_id: 50005,
        group_id: 12345,
        time: 1_700_000_400,
      }),
      config,
      noChain,
    )!
    expect(sent.kind).toBe('notice')
    expect(sent.event).toEqual({ postType: 'message_sent', type: 'sent' })
    expect(sent.rawText).toBe('[onebot sent: group] message 50005 in 12345')
  })

  test('a heartbeat is a meta event with no conversation', () => {
    const beat = mapOneBotEvent(
      event({
        post_type: 'meta_event',
        meta_event_type: 'heartbeat',
        group_id: undefined,
        user_id: undefined,
        time: 1_700_000_500,
      }),
      config,
      noChain,
    )!
    expect(beat.kind).toBe('meta')
    expect(beat.sessionKey).toBe('peer:10001')
    expect(beat.rawText).toBe('[onebot meta: heartbeat] account 10001')
  })

  test('an unknown post type maps onto nothing and is counted as unknown', () => {
    const odd = event({ post_type: 'something_else' })
    expect(mapOneBotEvent(odd, config, noChain)).toBeUndefined()
    expect(oneBotEventClass(odd)).toBe('unknown')
  })

  test('a message still says message and stays uncounted', () => {
    expect(mapOneBotEvent(event(), config, noChain)!.kind).toBeUndefined()
    expect(oneBotEventClass(event())).toBeUndefined()
  })

  test('each class a status counts has its own key', () => {
    expect(oneBotEventClass(recall())).toBe('notice.group_recall')
    expect(oneBotEventClass(event({ post_type: 'request', request_type: 'group' }))).toBe('request.group')
    expect(oneBotEventClass(event({ post_type: 'meta_event', meta_event_type: 'lifecycle' }))).toBe('meta.lifecycle')
    expect(oneBotEventClass(event({ post_type: 'message_sent' }))).toBe('message_sent')
    expect(oneBotEventClass(event({ post_type: 'notice', notice_type: undefined }))).toBe('notice.unknown')
    expect(oneBotEventClass(event({ post_type: 'notice', notice_type: 'x'.repeat(5000) }))).toBe('notice.other')
  })
})

describe('the key a notice is filed under', () => {
  test('a ban and a lift in the same second are different events', () => {
    const base = {
      post_type: 'notice',
      notice_type: 'group_ban',
      operator_id: 10001,
      user_id: 20002,
      group_id: 12345,
      time: 1_700_000_600,
    }
    const banned = mapOneBotEvent(event({ ...base, sub_type: 'ban' }), config, noChain)!
    const lifted = mapOneBotEvent(event({ ...base, sub_type: 'lift_ban' }), config, noChain)!
    expect(banned.eventKey).not.toBe(lifted.eventKey)
  })
})

describe('the actor a notice names', () => {
  test('a ban is authored by the operator, not by the banned user', () => {
    const ban = mapOneBotEvent(
      event({
        post_type: 'notice',
        notice_type: 'group_ban',
        sub_type: 'ban',
        operator_id: 10001,
        user_id: 20002,
        group_id: 12345,
        time: 1_700_000_700,
      }),
      config,
      noChain,
    )!
    expect(ban.author.senderId).toBe('10001')
    expect(ban.rawText).toContain('20002')
  })

  test('long ids cannot push the time out of the key', () => {
    const long = 'x'.repeat(48)
    const shape = {
      post_type: 'notice',
      notice_type: 'group_recall',
      group_id: long,
      user_id: long,
      message_id: long,
      target_id: long,
      flag: long,
    }
    const first = mapOneBotEvent(event({ ...shape, time: 1_700_000_001 }), config, noChain)!
    const second = mapOneBotEvent(event({ ...shape, time: 1_700_000_002 }), config, noChain)!
    expect(first.eventKey).not.toBe(second.eventKey)
    expect(first.eventKey.length).toBeLessThanOrEqual(256)
  })
})

describe('the words a ban notice carries', () => {
  test('lift_ban is not described as a ban', () => {
    const shape = {
      post_type: 'notice' as const,
      notice_type: 'group_ban',
      operator_id: 10001,
      user_id: 20002,
      group_id: 12345,
      time: 1_700_000_800,
    }
    const banned = mapOneBotEvent(event({ ...shape, sub_type: 'ban' }), config, noChain)!
    const lifted = mapOneBotEvent(event({ ...shape, sub_type: 'lift_ban' }), config, noChain)!
    expect(banned.rawText).toBe('[onebot notice: group_ban] operator 10001 banned user 20002 in group 12345')
    expect(lifted.rawText).toBe(
      '[onebot notice: group_ban] operator 10001 lifted the ban on user 20002 in group 12345',
    )
  })
})
