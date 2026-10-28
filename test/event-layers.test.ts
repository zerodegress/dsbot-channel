import { describe, expect, test } from 'vitest'
import { LAYERS, LayerViolationError, declareLayer, derivedLayer, readDeclared, transportLayer } from '../src/event-layers.js'

describe('layers', () => {
  test('declares exactly the three layers', () => {
    expect(LAYERS.slice()).toEqual(['transport', 'derived', 'declared'])
  })
})

describe('transport layer', () => {
  test('is readable from a policy node', () => {
    const meta = transportLayer({ messageId: 'm1', timestamp: 1, mentioned: false, isReply: false, signature: null })
    expect(meta.messageId).toBe('m1')
    expect(meta.timestamp).toBe(1)
  })
})

describe('derived layer', () => {
  test('is readable from a policy node', () => {
    const meta = derivedLayer({ eventKey: 'a:m1', contentHash: 'f'.repeat(64) })
    expect(meta.eventKey).toBe('a:m1')
  })
})

describe('declared layer', () => {
  test('cannot be read from a policy node', () => {
    const declared = declareLayer({ nickname: 'someone', avatar: 'https://example.invalid/a.png', claimedIdentity: 'admin' })
    expect(() => readDeclared(declared, 'nickname')).toThrow(LayerViolationError)
  })

  test('the violation reports the offending field', () => {
    const declared = declareLayer({ nickname: 'someone', avatar: '', claimedIdentity: null })
    try {
      readDeclared(declared, 'avatar')
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(LayerViolationError)
      expect((error as LayerViolationError).field).toBe('avatar')
      expect((error as LayerViolationError).layer).toBe('declared')
    }
  })

  test('does not carry the raw values as plain properties', () => {
    const declared = declareLayer({ nickname: 'someone', avatar: 'a', claimedIdentity: 'admin' })
    expect(Object.keys(declared)).toEqual([])
  })
})
