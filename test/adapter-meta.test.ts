import { describe, expect, test } from 'vitest'
import { buildEvent } from '../src/event-build.js'
import { ADAPTER_META_MAX_BYTES, ADAPTER_META_MAX_DEPTH } from '../src/adapter-meta.js'
import type { EventInput } from '../src/event-types.js'

const base = {
  source: { kind: 'onebot', instance: 'inst-a', peer: '12345', scope: 'group' as const },
  author: { senderId: '20002', kind: 'person' as const, personId: null },
  body: { text: 'hello', media: [], replyTo: null },
  transport: {
    messageId: 'm1',
    timestamp: 1_700_000_000_000,
    mentioned: { self: false, others: false, all: false },
    isReply: false,
    signature: null,
  },
  declared: { nickname: '', avatar: '', claimedIdentity: null },
}

const withAdapter = (adapter: unknown): EventInput => ({ ...base, adapter: adapter as Record<string, unknown> })

describe('the raw payload an adapter carries', () => {
  test('an event without one carries an empty object', () => {
    expect(buildEvent(base).meta.adapter).toEqual({})
  })

  test('what the adapter wrote is kept as it was', () => {
    const event = buildEvent(withAdapter({ rawMessage: '[CQ:at,qq=10001] 你好', messageType: 'group' }))
    expect(event.meta.adapter).toEqual({ rawMessage: '[CQ:at,qq=10001] 你好', messageType: 'group' })
  })

  test('the payload is detached from the caller', () => {
    const payload = { rawMessage: 'hello' }
    const event = buildEvent(withAdapter(payload))
    payload.rawMessage = 'changed'
    expect(event.meta.adapter.rawMessage).toBe('hello')

    ;(event.meta.adapter as { rawMessage: string }).rawMessage = 'edited'
    expect(payload.rawMessage).toBe('changed')
  })

  test('a value that is not json is refused', () => {
    for (const bad of [{ fn: () => 1 }, { n: undefined }, { n: Number.NaN }, { n: Infinity }, { big: 1n }]) {
      expect(() => buildEvent(withAdapter(bad))).toThrow(/meta\.adapter/)
    }
  })

  test('a payload that nests too deep is refused', () => {
    let deep: Record<string, unknown> = { leaf: true }
    for (let level = 0; level < ADAPTER_META_MAX_DEPTH + 1; level += 1) deep = { next: deep }
    expect(() => buildEvent(withAdapter(deep))).toThrow(/nests deeper than/)
  })

  test('a payload that is too large is refused', () => {
    const big = { rawMessage: 'x'.repeat(ADAPTER_META_MAX_BYTES) }
    expect(() => buildEvent(withAdapter(big))).toThrow(/more than 8192 bytes/)
  })

  test('a key that can reach a prototype is refused at any depth', () => {
    expect(() => buildEvent(withAdapter(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>))).toThrow(
      /meta\.adapter\.__proto__/,
    )
    expect(() =>
      buildEvent(withAdapter({ nested: JSON.parse('{"constructor":{"prototype":{"x":1}}}') as Record<string, unknown> })),
    ).toThrow(/meta\.adapter\.nested\.constructor/)
  })
})

describe('what the payload must not touch', () => {
  test('the event key ignores it', () => {
    const one = buildEvent(withAdapter({ rawMessage: 'a' }))
    const two = buildEvent(withAdapter({ rawMessage: 'b' }))
    expect(two.meta.derived.eventKey).toBe(one.meta.derived.eventKey)
  })

  test('the content hash ignores it', () => {
    const one = buildEvent(withAdapter({ rawMessage: 'a' }))
    const two = buildEvent(withAdapter({ rawMessage: 'b' }))
    expect(two.meta.derived.contentHash).toBe(one.meta.derived.contentHash)
  })
})
