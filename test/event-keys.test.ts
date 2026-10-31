import { describe, expect, test } from 'vitest'
import { ChainGuard, KeyGuard } from '../src/event-keys.js'

describe('a key an adapter repeats', () => {
  test('the same key with the same content is not a conflict', () => {
    const guard = new KeyGuard()
    expect(guard.check('p2p:a:1', 'hello')).toBeUndefined()
    expect(guard.check('p2p:a:1', 'hello')).toBeUndefined()
  })

  test('the same key with different content is refused', () => {
    const guard = new KeyGuard()
    guard.check('p2p:a:1', 'hello')
    expect(guard.check('p2p:a:1', 'goodbye')).toMatch(/already named different content/)
  })

  test('a key it forgot after the window is free again', () => {
    let now = 1_000
    const guard = new KeyGuard({ ttlMs: 100, now: () => now })
    guard.check('p2p:a:1', 'hello')
    now += 100
    expect(guard.check('p2p:a:1', 'goodbye')).toBeUndefined()
  })

  test('the table stays bounded', () => {
    const guard = new KeyGuard({ limit: 3 })
    for (let index = 0; index < 10; index += 1) guard.check(`key-${index}`, 'x')
    expect(guard.size).toBeLessThanOrEqual(3)
  })
})

describe('the chain an event belongs to', () => {
  test('the same event in the same chain is not a conflict', () => {
    const guard = new ChainGuard()
    expect(guard.check('root-1', 'evt-1')).toBeUndefined()
    expect(guard.check('root-1', 'evt-1')).toBeUndefined()
  })

  test('an event already in one chain cannot move to another', () => {
    const guard = new ChainGuard()
    guard.check('root-1', 'evt-1')
    expect(guard.check('root-2', 'evt-1')).toMatch(/already belongs to chain "root-1"/)
  })

  test('a different event in the same chain is fine', () => {
    const guard = new ChainGuard()
    guard.check('root-1', 'evt-1')
    expect(guard.check('root-1', 'evt-2')).toBeUndefined()
    expect(guard.size).toBe(2)
  })
})
