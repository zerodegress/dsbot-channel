import { describe, expect, test } from 'vitest'
import { TurnWindows } from '../src/turn-window.js'

interface Timer {
  callback: () => void
}

function harness(windowMs: number, limits = { maxBatch: 10, maxChars: 8_000 }) {
  let now = 0
  const timers: Timer[] = []
  const flushed: string[][] = []
  const windows = new TurnWindows<string>(
    {
      now: () => now,
      setTimer: (callback) => {
        const timer: Timer = { callback }
        timers.push(timer)
        return timer
      },
      clearTimer: (handle) => {
        const at = timers.indexOf(handle as Timer)
        if (at >= 0) timers.splice(at, 1)
      },
    },
    { limits, windowMs },
  )
  const offer = (key: string, eventKey: string, chars = 1): void => {
    windows.offer(key, { eventKey, chars, value: eventKey }, (batch) => flushed.push([...batch]))
  }
  const advance = (ms: number): void => {
    now += ms
    for (const timer of [...timers]) {
      timers.splice(timers.indexOf(timer), 1)
      timer.callback()
    }
  }
  return { windows, offer, advance, flushed, timers }
}

describe('the window a batch waits in', () => {
  test('a full batch leaves the rest with a window of their own', () => {
    const { offer, advance, flushed } = harness(100, { maxBatch: 2, maxChars: 8_000 })
    offer('k', 'a')
    offer('k', 'b')
    expect(flushed).toEqual([['a', 'b']])
    offer('k', 'c')
    advance(100)
    expect(flushed).toEqual([['a', 'b'], ['c']])
  })

  test('what a character cap splits off also gets a window', () => {
    const { offer, advance, flushed } = harness(100, { maxBatch: 10, maxChars: 100 })
    offer('k', 'first', 60)
    offer('k', 'second', 60)
    expect(flushed).toEqual([['first']])
    advance(100)
    expect(flushed).toEqual([['first'], ['second']])
  })

  test('stopping clears every window, so nothing fires afterwards', () => {
    const { windows, offer, advance, flushed, timers } = harness(100)
    offer('k', 'a')
    expect(timers).toHaveLength(1)
    windows.clear()
    expect(timers).toHaveLength(0)
    advance(1_000)
    expect(flushed).toEqual([])
  })

  test('a zero window answers each message on its own and never opens one', () => {
    const { offer, flushed, timers } = harness(0)
    offer('k', 'a')
    offer('k', 'b')
    expect(flushed).toEqual([['a'], ['b']])
    expect(timers).toHaveLength(0)
  })
})
