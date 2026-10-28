import { describe, expect, test } from 'vitest'
import { buildEvent, chargeKey, dedupeKeyFor, replyIdempotencyKey, unstableDedupeKey } from '../src/event-build.js'

const base = {
  source: { kind: 'onebot' as const, instance: 'onebot:10001', peer: null, scope: 'group' as const },
  author: { senderId: 'u1', personId: '9f1c2b3f-0f6e-4c4e-9b3b-3f8f2a1d4c6e' },
  body: { text: 'hello', media: [], replyTo: null },
  transport: {
    messageId: 'm1',
    timestamp: 1700000000000,
    mentioned: false,
    isReply: false,
    signature: null,
  },
  declared: { nickname: 'someone', avatar: 'a', claimedIdentity: null },
}

describe('buildEvent', () => {
  test('produces the four parts', () => {
    const event = buildEvent(base)
    expect(Object.keys(event).sort()).toEqual(['author', 'body', 'meta', 'source'])
  })

  test('derives eventKey from instance and platform message id', () => {
    expect(buildEvent(base).meta.derived.eventKey).toBe('onebot:10001:m1')
  })

  test('derives contentHash from body and media only', () => {
    const a = buildEvent(base)
    const b = buildEvent({ ...base, transport: { ...base.transport, messageId: 'm2' } })
    expect(a.meta.derived.contentHash).toBe(b.meta.derived.contentHash)
    expect(a.meta.derived.eventKey).not.toBe(b.meta.derived.eventKey)
  })

  test('a p2p bot author has a null personId', () => {
    const event = buildEvent({
      ...base,
      source: { kind: 'p2p' as const, instance: 'p2p:self', peer: 'other', scope: 'p2p' as const },
      author: { senderId: 'bot', personId: null },
    })
    expect(event.author.personId).toBeNull()
  })

  test('rejects a source kind outside the closed enum', () => {
    expect(() => buildEvent({ ...base, source: { ...base.source, kind: 'webhook' as never } })).toThrow()
  })

  test('rejects a scope outside the closed enum', () => {
    expect(() => buildEvent({ ...base, source: { ...base.source, scope: 'channel' as never } })).toThrow()
  })
})

describe('chargeKey', () => {
  test('is the triple of eventKey, botId and chargeKind', () => {
    expect(chargeKey('onebot:1:m1', 'bot-a', 'bot')).toBe('onebot:1:m1|bot-a|bot')
  })

  test('differs per bot so a multicast charges each bot on its own', () => {
    expect(chargeKey('onebot:1:m1', 'bot-a', 'bot')).not.toBe(chargeKey('onebot:1:m1', 'bot-b', 'bot'))
  })

  test('rejects a chargeKind outside the closed set', () => {
    expect(() => chargeKey('k', 'b', 'other' as never)).toThrow()
  })
})

describe('replyIdempotencyKey', () => {
  test('combines eventKey, target and contentHash', () => {
    const key = replyIdempotencyKey('onebot:1:m1', { channel: 'onebot:1', scope: 'group', target: 'g1' }, 'h')
    expect(key).toContain('onebot:1:m1')
    expect(key).toContain('g1')
    expect(key).toContain('h')
  })

  test('differs per target', () => {
    const a = replyIdempotencyKey('k', { channel: 'c', scope: 'group', target: 'g1' }, 'h')
    const b = replyIdempotencyKey('k', { channel: 'c', scope: 'group', target: 'g2' }, 'h')
    expect(a).not.toBe(b)
  })
})

describe('unstable message id dedupe', () => {
  test('uses sender and contentHash inside the window', () => {
    expect(dedupeKeyFor({ stableMessageId: false, senderId: 'u1', contentHash: 'h', eventKey: 'k' })).toBe('u1|h')
  })

  test('falls back to the eventKey when the platform id is stable', () => {
    expect(dedupeKeyFor({ stableMessageId: true, senderId: 'u1', contentHash: 'h', eventKey: 'k' })).toBe('k')
  })

  test('only the unstable path may merge two identical bodies', () => {
    const one = unstableDedupeKey('u1', 'h')
    const two = unstableDedupeKey('u1', 'h')
    expect(one).toBe(two)
  })
})
