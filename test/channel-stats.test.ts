import { describe, expect, test } from 'vitest'
import { ChannelStats } from '../src/channel-stats.js'

function stats(start = 1_000): { stats: ChannelStats; clock: (value: number) => void } {
  let now = start
  return {
    stats: new ChannelStats(() => now),
    clock: (value: number) => {
      now = value
    },
  }
}

describe('a channel reports its own state', () => {
  test('it starts as starting and knows nothing yet', () => {
    expect(stats().stats.snapshot()).toEqual({
      state: 'starting',
      boundPort: null,
      lastAuthenticatedAt: null,
      lastFailure: null,
      inFlight: 0,
      underruns: 0,
      sampledAt: 1_000,
    })
  })

  test('listening records the bound port, which is the one the OS gave', () => {
    const { stats: channel } = stats()
    channel.listening(18_101)
    expect(channel.snapshot()).toMatchObject({ state: 'listening', boundPort: 18_101 })
  })

  test('a failed start keeps the reason and drops the port', () => {
    const { stats: channel, clock } = stats()
    channel.listening(18_101)
    clock(2_000)
    channel.failed('EADDRINUSE')
    expect(channel.snapshot()).toMatchObject({
      state: 'failed',
      boundPort: null,
      lastFailure: { at: 2_000, reason: 'EADDRINUSE' },
    })
  })

  test('closing clears the port but keeps what was already learned', () => {
    const { stats: channel } = stats()
    channel.listening(18_101)
    channel.authenticated()
    channel.closed()
    expect(channel.snapshot()).toMatchObject({
      state: 'closed',
      boundPort: null,
      lastAuthenticatedAt: 1_000,
    })
  })
})

describe('authentication is timestamped, refusals are remembered', () => {
  test('a successful verification records when it happened', () => {
    const { stats: channel, clock } = stats()
    clock(5_000)
    channel.authenticated()
    expect(channel.snapshot().lastAuthenticatedAt).toBe(5_000)
  })

  test('a refusal never moves the authentication time', () => {
    const { stats: channel, clock } = stats()
    clock(5_000)
    channel.authenticated()
    clock(6_000)
    channel.rejected('bad signature')
    const snapshot = channel.snapshot()
    expect(snapshot.lastAuthenticatedAt).toBe(5_000)
    expect(snapshot.lastFailure).toEqual({ at: 6_000, reason: 'bad signature' })
  })

  test('the newest refusal wins', () => {
    const { stats: channel, clock } = stats()
    clock(1_000)
    channel.rejected('bad signature')
    clock(2_000)
    channel.rejected('stale_sent_at')
    expect(channel.snapshot().lastFailure).toEqual({ at: 2_000, reason: 'stale_sent_at' })
  })
})

describe('deliveries in flight are counted, and an unbalanced end is loud', () => {
  test('two deliveries in flight are reported as two', () => {
    const { stats: channel } = stats()
    channel.beginDelivery()
    channel.beginDelivery()
    expect(channel.snapshot().inFlight).toBe(2)
    channel.endDelivery()
    expect(channel.snapshot().inFlight).toBe(1)
  })

  test('a balanced pair leaves nothing behind', () => {
    const { stats: channel } = stats()
    channel.beginDelivery()
    channel.endDelivery()
    expect(channel.snapshot()).toMatchObject({ inFlight: 0, underruns: 0 })
  })

  test('ending a delivery that never began is counted instead of hidden', () => {
    const { stats: channel } = stats()
    channel.endDelivery()
    expect(channel.snapshot()).toMatchObject({ inFlight: 0, underruns: 1 })
  })
})

describe('a snapshot is a copy', () => {
  test('changing the snapshot does not change the channel', () => {
    const { stats: channel } = stats()
    channel.failed('EADDRINUSE')
    const snapshot = channel.snapshot()
    snapshot.lastFailure!.reason = 'tampered'
    snapshot.state = 'listening'
    expect(channel.snapshot()).toMatchObject({ state: 'failed', lastFailure: { reason: 'EADDRINUSE' } })
  })
})
