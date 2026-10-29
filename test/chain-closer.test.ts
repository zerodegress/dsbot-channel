import { describe, expect, test } from 'vitest'
import { CHAIN_TTL_MS, ClosedChains, baseEventId } from '../src/chain-closer.js'

describe('the key one conversation is known by', () => {
  test('strips every reply marker a relay adds', () => {
    expect(baseEventId('probe-1')).toBe('probe-1')
    expect(baseEventId('reply:probe-1')).toBe('probe-1')
    expect(baseEventId('reply:reply:reply:reply:probe-1')).toBe('probe-1')
  })

  test('keeps a bare reply marker from collapsing to nothing', () => {
    expect(baseEventId('reply:')).toBe('reply:')
  })
})

describe('a closed chain', () => {
  test('stays closed for every later message on the same chain', () => {
    const chains = new ClosedChains()
    chains.close('reply:probe-1')

    expect(chains.isClosed('probe-1')).toBe(true)
    expect(chains.isClosed('reply:reply:probe-1')).toBe(true)
    expect(chains.isClosed('probe-2')).toBe(false)
  })

  test('opens again once the hour is over', () => {
    let now = 1_000
    const chains = new ClosedChains({ now: () => now })
    chains.close('probe-1')
    now += CHAIN_TTL_MS - 1
    expect(chains.isClosed('probe-1')).toBe(true)
    now += 1
    expect(chains.isClosed('probe-1')).toBe(false)
  })

  test('forgets a chain it was asked about after expiry, so the map does not grow forever', () => {
    let now = 1_000
    const chains = new ClosedChains({ now: () => now })
    chains.close('probe-1')
    now += CHAIN_TTL_MS
    chains.isClosed('probe-1')

    expect(chains.size).toBe(0)
  })
})
