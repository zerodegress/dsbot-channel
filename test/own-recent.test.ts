import { describe, expect, test } from 'vitest'
import { OwnRecent, OWN_RECENT_TTL_MS, OWN_RECENT_WINDOW } from '../src/own-recent.js'

const clock = (start = 1_000) => {
  let at = start
  return { now: () => at, advance: (by: number) => (at += by) }
}

describe('the window since the bot last spoke', () => {
  test('a fresh conversation counts as recent', () => {
    expect(new OwnRecent(clock().now).recent('p2p:a', 'group:1')).toBe(true)
  })

  test('the tenth message is no longer recent', () => {
    const own = new OwnRecent(clock().now)
    for (let index = 0; index < OWN_RECENT_WINDOW - 1; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
    own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
  })

  test('a reply restarts the window', () => {
    const own = new OwnRecent(clock().now)
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    own.reset('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
  })

  test('conversations and channels do not share a counter', () => {
    const own = new OwnRecent(clock().now)
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:b', 'group:1')).toBe(true)
    expect(own.recent('p2p:a', 'group:2')).toBe(true)
  })

  test('a quiet conversation forgets its count', () => {
    const time = clock()
    const own = new OwnRecent(time.now)
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
    time.advance(OWN_RECENT_TTL_MS + 1)
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
  })

  test('a send that names only the target restarts that conversation', () => {
    const own = new OwnRecent(clock().now)
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    own.resetTarget('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
    own.resetTarget('p2p:a', 'group:other')
    expect(own.recent('p2p:a', 'group:2')).toBe(true)
  })
})
