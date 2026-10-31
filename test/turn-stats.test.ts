import { describe, expect, test } from 'vitest'
import { TurnStats } from '../src/turn-stats.js'

describe('what core counts about the turns it ran', () => {
  test('a fresh counter reports zeros, not missing fields', () => {
    const stats = new TurnStats(() => 1_000)

    expect(stats.snapshot()).toEqual({
      started: 0,
      replied: 0,
      empty: 0,
      pushed: 0,
      suppressed: 0,
      failed: 0,
      sendFailures: {},
      sampledAt: 1_000,
    })
  })

  test('each ending is counted where it happened', () => {
    const stats = new TurnStats(() => 1)
    stats.started()
    stats.replied()
    stats.started()
    stats.empty()
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
      pushed: 1,
      suppressed: 1,
      failed: 1,
      sendFailures: { timeout: 2, forbidden: 1 },
    })
  })
})
