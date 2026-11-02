import { describe, expect, test } from 'vitest'
import { batchChars, joinBatch, takeBatch } from '../src/turn-batch.js'

const queue = (sizes: readonly number[]) => sizes.map((chars, index) => ({ eventKey: `e${index + 1}`, chars }))

describe('how many messages make one turn', () => {
  test('an empty queue takes nothing', () => {
    expect(takeBatch([], { maxBatch: 10, maxChars: 8000 })).toBe(0)
  })

  test('the batch cap cuts the queue at a fixed size', () => {
    expect(takeBatch(queue([1, 1, 1, 1, 1, 1, 1]), { maxBatch: 3, maxChars: 8000 })).toBe(3)
  })

  test('everything fits when both limits allow it', () => {
    expect(takeBatch(queue([10, 10, 10]), { maxBatch: 5, maxChars: 100 })).toBe(3)
  })

  test('a message that would overflow the characters waits for the next turn', () => {
    expect(takeBatch(queue([60, 60]), { maxBatch: 10, maxChars: 100 })).toBe(1)
  })

  test('a single message over the character limit still goes on its own', () => {
    expect(takeBatch(queue([300]), { maxBatch: 10, maxChars: 100 })).toBe(1)
    expect(takeBatch(queue([300, 10]), { maxBatch: 10, maxChars: 100 })).toBe(1)
  })

  test('a batch exactly at the character limit is taken', () => {
    expect(takeBatch(queue([50, 50, 1]), { maxBatch: 10, maxChars: 100 })).toBe(2)
  })
})

describe('the body one batch produces', () => {
  test('keeps every message, including two that read the same', () => {
    const joined = joinBatch(['[p2p from a] 好', '[p2p from b] 好'])
    expect(joined.split('\n')).toHaveLength(2)
    expect(joined.match(/好/g)).toHaveLength(2)
  })

  test('counts the separator each message brings, so the cap is really the cap', () => {
    const texts = ['abc', 'de']
    expect(joinBatch(texts).length).toBe(6)
    expect(batchChars(texts).reduce((sum, one) => sum + one, 0)).toBe(7)
    expect(joinBatch(texts).length).toBeLessThanOrEqual(batchChars(texts).reduce((sum, one) => sum + one, 0))
  })
})
