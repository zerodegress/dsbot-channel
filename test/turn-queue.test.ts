import { describe, expect, test } from 'vitest'
import { TurnQueue } from '../src/turn-queue.js'

const limits = { maxBatch: 3, maxChars: 100 }
const one = (key: string, chars = 1) => ({ eventKey: key, chars, value: key })

describe('the queue that feeds a merged turn', () => {
  test('keeps messages until the window closes', () => {
    const queue = new TurnQueue<string>(limits, 100)
    expect(queue.push(one('a'), 0)).toBeUndefined()
    expect(queue.push(one('b'), 10)).toBeUndefined()
    expect(queue.due(50)).toBeUndefined()
    expect(queue.due(100)?.map((item) => item.eventKey)).toEqual(['a', 'b'])
    expect(queue.pending).toBe(0)
  })

  test('flushes at once when the batch cap is reached', () => {
    const queue = new TurnQueue<string>(limits, 100)
    queue.push(one('a'), 0)
    queue.push(one('b'), 1)
    expect(queue.push(one('c'), 2)?.map((item) => item.eventKey)).toEqual(['a', 'b', 'c'])
    expect(queue.pending).toBe(0)
  })

  test('a batch that hits the character cap flushes and leaves the rest queued', () => {
    const queue = new TurnQueue<string>(limits, 100)
    queue.push(one('a', 60), 0)
    expect(queue.push(one('b', 60), 1)?.map((item) => item.eventKey)).toEqual(['a'])
    expect(queue.pending).toBe(1)
  })

  test('a single oversized message goes alone, and the rest wait for the next window', () => {
    const queue = new TurnQueue<string>(limits, 100)
    expect(queue.push(one('big', 300), 0)).toBeUndefined()
    expect(queue.push(one('next'), 1)?.map((item) => item.eventKey)).toEqual(['big'])
    expect(queue.pending).toBe(1)
    expect(queue.due(100)).toBeUndefined()
    expect(queue.due(101)?.map((item) => item.eventKey)).toEqual(['next'])
  })

  test('a zero window answers every message on its own', () => {
    const queue = new TurnQueue<string>({ maxBatch: 10, maxChars: 100 }, 0)
    expect(queue.push(one('a'), 0)?.map((item) => item.eventKey)).toEqual(['a'])
    expect(queue.pending).toBe(0)
  })
})
