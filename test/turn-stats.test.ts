import { describe, expect, test } from 'vitest'
import { TurnStats } from '../src/turn-stats.js'

describe('what core counts about the turns it ran', () => {
  test('a fresh counter reports zeros, not missing fields', () => {
    const stats = new TurnStats({ now: () => 1_000 })

    expect(stats.snapshot()).toEqual({
      started: 0,
      replied: 0,
      empty: 0,
      dropped: 0,
      pushed: 0,
      suppressed: 0,
      failed: 0,
      sendFailures: {},
      sampledAt: 1_000,
      recent: [],
    })
  })

  test('each ending is counted where it happened', () => {
    const stats = new TurnStats({ now: () => 1 })
    stats.started()
    stats.replied()
    stats.started()
    stats.empty()
    stats.dropped()
    stats.started()
    stats.pushed()
    stats.started()
    stats.suppressed()
    stats.started()
    stats.failed()
    stats.sendFailed('timeout')
    stats.sendFailed('timeout')
    stats.sendFailed('forbidden')

    expect(stats.snapshot()).toMatchObject({
      started: 5,
      replied: 1,
      empty: 1,
      dropped: 1,
      pushed: 1,
      suppressed: 1,
      failed: 1,
      sendFailures: { timeout: 2, forbidden: 1 },
    })
  })
})

describe('the turns a host may read back', () => {
  test('a finished turn carries its window, outcome and duration', () => {
    let now = 1_000
    const stats = new TurnStats({ now: () => now })
    stats.open('inst-a:m1')
    now = 1_250
    stats.close({ eventKey: 'inst-a:m1', bot: 'bot-a', channel: 'p2p:a', sessionKey: 'p2p:inst-b', outcome: 'replied' })

    const record = stats.snapshot().recent[0]!
    expect(record).toEqual({
      eventKey: 'inst-a:m1',
      bot: 'bot-a',
      channel: 'p2p:a',
      sessionKey: 'p2p:inst-b',
      startedAt: 1_000,
      endedAt: 1_250,
      durationMs: 250,
      outcome: 'replied',
    })
  })

  test('a failure keeps the code it ended with', () => {
    const stats = new TurnStats({ now: () => 7 })
    stats.close({ eventKey: 'e1', bot: 'b', channel: 'c', sessionKey: 's', outcome: 'failed', code: 'timeout' })
    expect(stats.snapshot().recent[0]).toMatchObject({ outcome: 'failed', code: 'timeout' })
  })

  test('the records stay bounded, oldest first', () => {
    const stats = new TurnStats({ now: () => 1, limit: 2 })
    for (const key of ['e1', 'e2', 'e3']) {
      stats.close({ eventKey: key, bot: 'b', channel: 'c', sessionKey: 's', outcome: 'replied' })
    }
    expect(stats.snapshot().recent.map((one) => one.eventKey)).toEqual(['e2', 'e3'])
  })

  test('a reader cannot edit the records it got', () => {
    const stats = new TurnStats({ now: () => 1 })
    stats.close({ eventKey: 'e1', bot: 'b', channel: 'c', sessionKey: 's', outcome: 'replied' })
    const first = stats.snapshot().recent
    first[0]!.outcome = 'failed'
    expect(stats.snapshot().recent[0]?.outcome).toBe('replied')
  })

  test('reading the snapshot changes no counter', () => {
    const stats = new TurnStats({ now: () => 1 })
    stats.started()
    const before = stats.snapshot()
    stats.snapshot()
    expect(stats.snapshot()).toEqual(before)
  })
})
