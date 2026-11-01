import { describe, expect, test } from 'vitest'
import { DEFAULT_HARD_LIMIT, createLedger } from '../src/budget-config.js'

function spend(ledger: ReturnType<typeof createLedger>, points: number, session = 'p2p:peer-a'): void {
  ledger.reserve('bot-a', session, 'judge', points)
}

describe('an adapter builds its ledger from configuration', () => {
  test('without an explicit ratio the hard limit is the whole capacity', () => {
    expect(DEFAULT_HARD_LIMIT).toBe(1)
  })

  test('a hundred of a hundred points is the hard limit and below it nothing trips', () => {
    const ledger = createLedger({ capacity: 100 })
    spend(ledger, 99)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('normal')
    spend(ledger, 1)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
  })

  test('capacity is the denominator the ratios apply to', () => {
    const ledger = createLedger({ capacity: 10 })
    spend(ledger, 10)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
  })

  test('an explicit ratio replaces the default', () => {
    const ledger = createLedger({ capacity: 100, hardLimit: 0.75 })
    spend(ledger, 74)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('normal')
    spend(ledger, 1)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
  })

  test('the session key the gate passes names the peer', () => {
    const ledger = createLedger({ capacity: 100 })
    spend(ledger, 80, 'p2p:peer-a')
    expect(ledger.usage('bot-a', 'p2p:peer-a')['p2p:peer-a']).toBe(80)
    expect(ledger.usage('bot-a', 'p2p:peer-b')['p2p:peer-b']).toBe(0)
  })

  test('the time source can be handed in, so a window can be aged on purpose', () => {
    let now = 0
    const ledger = createLedger({ capacity: 100 }, { now: () => now })
    spend(ledger, 100)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
    now += 61 * 60_000
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('normal')
  })
})
