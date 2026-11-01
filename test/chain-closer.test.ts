import { describe, expect, test } from 'vitest'
import { CHAIN_TTL_MS, ClosedChains } from '../src/chain-closer.js'

describe('a closed chain', () => {
  test('stays closed for every later message on the same chain', () => {
    const chains = new ClosedChains()
    chains.close('probe-1')

    expect(chains.isClosed('probe-1')).toBe(true)
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

  test('sweeps expired chains when another is closed, not only when read', () => {
    let now = 1_000
    const chains = new ClosedChains({ now: () => now })
    chains.close('probe-1')
    chains.close('probe-2')
    now += CHAIN_TTL_MS
    chains.close('probe-3')

    expect(chains.size).toBe(1)
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
