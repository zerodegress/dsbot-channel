import { describe, expect, test } from 'vitest'
import { OwnRecent, OWN_RECENT_TTL_MS, OWN_RECENT_WINDOW } from '../src/own-recent.js'

const clock = (start = 1_000) => {
  let at = start
  return { now: () => at, advance: (by: number) => (at += by) }
}

describe('the window since the bot last spoke', () => {
  test('a conversation the bot never spoke in is not recent', () => {
    const own = new OwnRecent(clock().now)
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
    own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
  })

  test('a reply makes the conversation recent until ten messages arrive', () => {
    const own = new OwnRecent(clock().now)
    own.reset('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
    for (let index = 1; index < OWN_RECENT_WINDOW; index += 1) {
      own.touch('p2p:a', 'group:1')
      expect(own.recent('p2p:a', 'group:1')).toBe(true)
    }
    own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
  })

  test('a later reply restarts the window', () => {
    const own = new OwnRecent(clock().now)
    own.reset('p2p:a', 'group:1')
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
    own.reset('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
  })

  test('conversations and channels do not share a counter', () => {
    const own = new OwnRecent(clock().now)
    own.reset('p2p:a', 'group:1')
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:b', 'group:1')).toBe(false)
    expect(own.recent('p2p:a', 'group:2')).toBe(false)
  })

  test('ten quiet minutes end the window', () => {
    const time = clock()
    const own = new OwnRecent(time.now)
    own.reset('p2p:a', 'group:1')
    time.advance(OWN_RECENT_TTL_MS)
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
    time.advance(1)
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
  })

  test('a send that names only the target restarts that conversation', () => {
    const own = new OwnRecent(clock().now)
    own.reset('p2p:a', 'group:1')
    for (let index = 0; index < OWN_RECENT_WINDOW; index += 1) own.touch('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(false)
    own.resetTarget('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
    expect(own.recent('p2p:a', 'group:2')).toBe(false)
  })

  test('a target send marks a conversation that had no reading yet', () => {
    const own = new OwnRecent(clock().now)
    own.resetTarget('p2p:a', 'group:1')
    expect(own.recent('p2p:a', 'group:1')).toBe(true)
  })
})
