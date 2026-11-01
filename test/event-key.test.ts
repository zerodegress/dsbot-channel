import { describe, expect, test } from 'vitest'
import { contentHash, eventKey } from '../src/event-key.js'

describe('eventKey', () => {
  test('joins instance and platform message id', () => {
    expect(eventKey('onebot:10001', 'msg-42')).toBe('onebot:10001:msg-42')
  })

  test('is stable for the same pair', () => {
    expect(eventKey('p2p:self', 'e1')).toBe(eventKey('p2p:self', 'e1'))
  })

  test('changes when the platform message id changes', () => {
    expect(eventKey('p2p:self', 'e1')).not.toBe(eventKey('p2p:self', 'e2'))
  })

  test('changes when the instance changes', () => {
    expect(eventKey('a', 'm1')).not.toBe(eventKey('b', 'm1'))
  })

  test('rejects an empty instance', () => {
    expect(() => eventKey('', 'm1')).toThrow()
  })

  test('rejects an empty message id', () => {
    expect(() => eventKey('a', '')).toThrow()
  })
})

describe('contentHash', () => {
  test('ignores surrounding whitespace in the body', () => {
    expect(contentHash({ text: ' hi ', media: [] })).toBe(contentHash({ text: 'hi', media: [] }))
  })

  test('equals for two identical messages', () => {
    expect(contentHash({ text: '哈哈哈', media: [] })).toBe(contentHash({ text: '哈哈哈', media: [] }))
  })

  test('is a hex string of fixed length', () => {
    expect(contentHash({ text: 'x', media: [] })).toMatch(/^[0-9a-f]{64}$/)
  })

  test('changes when the body changes', () => {
    expect(contentHash({ text: 'a', media: [] })).not.toBe(contentHash({ text: 'b', media: [] }))
  })

  test('changes when a media reference changes', () => {
    const one = contentHash({ text: 'a', media: [{ type: 'image', url: 'u1', handle: null }] })
    const two = contentHash({ text: 'a', media: [{ type: 'image', url: 'u2', handle: null }] })
    expect(one).not.toBe(two)
  })

  test('changes when media order changes', () => {
    const one = contentHash({ text: '', media: [{ type: 'image', url: 'u1', handle: null }, { type: 'image', url: 'u2', handle: null }] })
    const two = contentHash({ text: '', media: [{ type: 'image', url: 'u2', handle: null }, { type: 'image', url: 'u1', handle: null }] })
    expect(one).not.toBe(two)
  })
})

describe('eventKey and contentHash are separate', () => {
  test('two identical bodies with different ids have the same hash but different keys', () => {
    const a = contentHash({ text: '哈哈哈', media: [] })
    const b = contentHash({ text: '哈哈哈', media: [] })
    expect(a).toBe(b)
    expect(eventKey('onebot:1', 'm1')).not.toBe(eventKey('onebot:1', 'm2'))
  })

  test('one id with different bodies has the same key but a different hash', () => {
    expect(eventKey('onebot:1', 'm1')).toBe(eventKey('onebot:1', 'm1'))
    expect(contentHash({ text: 'a', media: [] })).not.toBe(contentHash({ text: 'b', media: [] }))
  })
})
