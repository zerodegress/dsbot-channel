import { describe, expect, test } from 'vitest'
import { LAYERS, LayerViolationError, declareLayer, derivedLayer, readDeclared, transportLayer } from '../src/event-layers.js'

describe('the transport layer copy', () => {
  test('copies the mention report instead of sharing the object', async () => {
    const { buildEvent } = await import('../src/event-build.js')
    const { transportLayer } = await import('../src/event-layers.js')
    const mentioned = { self: true, others: true, all: false }
    const event = buildEvent({
      source: { kind: 'p2p', instance: 'a', peer: null, scope: 'p2p' },
      author: { senderId: 'u', kind: 'person', personId: null },
      body: { text: 'hi', media: [], replyTo: null },
      transport: { messageId: 'm', timestamp: 1, mentioned, isReply: false, signature: null },
      declared: { nickname: '', avatar: '', claimedIdentity: null },
    })
    const layer = transportLayer(event.meta.transport) as { mentioned: { self: boolean } }
    mentioned.self = false
    expect(layer.mentioned.self).toBe(true)
    layer.mentioned.self = false
    expect(event.meta.transport.mentioned.self).toBe(true)
  })
})

describe('layers', () => {
  test('declares exactly the three layers', () => {
    expect(LAYERS.slice()).toEqual(['transport', 'derived', 'declared'])
  })
})

describe('transport layer', () => {
  test('is readable from a policy node', () => {
    const meta = transportLayer({ messageId: 'm1', timestamp: 1, mentioned: { self: false, others: false, all: false }, isReply: false, signature: null })
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
