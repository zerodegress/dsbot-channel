import { describe, expect, test } from 'vitest'
import { buildEvent, chargeKey, dedupeKeyFor, replyIdempotencyKey, unstableDedupeKey } from '../src/event-build.js'
import type { EventInput } from '../src/event-types.js'

const base = {
  source: { kind: 'onebot' as const, instance: 'onebot:10001', peer: null, scope: 'group' as const },
  author: { senderId: 'u1', kind: 'person' as const, personId: '9f1c2b3f-0f6e-4c4e-9b3b-3f8f2a1d4c6e' },
  body: { text: 'hello', media: [], replyTo: null },
  transport: {
    messageId: 'm1',
    timestamp: 1700000000000,
    mentioned: { self: false, others: false, all: false },
    isReply: false,
    signature: null,
  },
  declared: { nickname: 'someone', avatar: 'a', claimedIdentity: null },
}

const media = (one: unknown) => ({ ...base, body: { ...base.body, media: [one] } }) as EventInput

describe('a media reference the core carries', () => {
  test('a url alone is enough', () => {
    expect(buildEvent(media({ type: 'image', url: 'https://example.test/a.png', handle: null })).body.media[0]).toEqual({
      type: 'image',
      url: 'https://example.test/a.png',
      handle: null,
    })
  })

  test('a platform handle alone is enough and is carried untouched', () => {
    const handle = 'onebot:image:abc-123'
    expect(buildEvent(media({ type: 'image', url: null, handle })).body.media[0]).toEqual({
      type: 'image',
      url: null,
      handle,
    })
  })

  test('a reference with neither is refused', () => {
    expect(() => buildEvent(media({ type: 'image', url: null, handle: null }))).toThrow(/needs a url or a handle/)
    expect(() => buildEvent(media({ type: 'image' }))).toThrow(/needs a url or a handle/)
  })

  test('a handle must be one bounded line', () => {
    for (const bad of ['', 'two words', 'a\nb', 'a\tb', 'x'.repeat(257)]) {
      expect(() => buildEvent(media({ type: 'image', url: null, handle: bad }))).toThrow(/media\[0\]/)
    }
  })

  test('a url that is present but empty is refused', () => {
    expect(() => buildEvent(media({ type: 'image', url: '', handle: null }))).toThrow(/url must be a non-empty string/)
  })

  test('the media type stays a closed set', () => {
    expect(() => buildEvent(media({ type: 'video', url: 'u', handle: null }))).toThrow(/type must be one of/)
  })
})

describe('the mention report', () => {
  const withMention = (mentioned: unknown) => ({ ...base, transport: { ...base.transport, mentioned } })

  test('three booleans are kept as they came', () => {
    const event = buildEvent(withMention({ self: true, others: true, all: true }) as never)
    expect(event.meta.transport.mentioned).toEqual({ self: true, others: true, all: true })
  })

  test('the object is copied, not shared with the caller', () => {
    const mentioned = { self: true, others: false, all: false }
    const event = buildEvent(withMention(mentioned) as never)
    mentioned.self = false
    expect(event.meta.transport.mentioned.self).toBe(true)
  })

  test('a missing field is refused, never read as false', () => {
    for (const partial of [{ self: true, others: false }, { self: true }, {}, null, 'yes']) {
      expect(() => buildEvent(withMention(partial) as never)).toThrow(/transport\.mentioned/)
    }
  })

  test('a non-boolean field is refused', () => {
    expect(() => buildEvent(withMention({ self: 1, others: false, all: false }) as never)).toThrow(/self must be a boolean/)
  })
})

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
      author: { senderId: 'bot', kind: 'bot' as const, personId: null },
    })
    expect(event.author.personId).toBeNull()
  })

  test('a person author keeps its kind', () => {
    expect(buildEvent(base).author.kind).toBe('person')
  })

  test('rejects an author kind outside the closed enum', () => {
    expect(() => buildEvent({ ...base, author: { ...base.author, kind: 'system' as never } })).toThrow()
  })

  test('accepts a kind the adapter declares, without a closed list', () => {
    expect(buildEvent({ ...base, source: { ...base.source, kind: 'x-demo' } }).source.kind).toBe('x-demo')
    expect(buildEvent({ ...base, source: { ...base.source, kind: 'onebot' } }).source.kind).toBe('onebot')
  })

  test('refuses a kind that is not one bounded printable line', () => {
    for (const bad of ['', 'two words', 'a\nb', 'a\tb', 'x'.repeat(65)]) {
      expect(() => buildEvent({ ...base, source: { ...base.source, kind: bad } })).toThrow(/source\.kind/)
    }
  })

  test('the kind does not reach the event key', () => {
    const first = buildEvent({ ...base, source: { ...base.source, kind: 'p2p' } })
    const second = buildEvent({ ...base, source: { ...base.source, kind: 'x-demo' } })
    expect(second.meta.derived.eventKey).toBe(first.meta.derived.eventKey)
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
