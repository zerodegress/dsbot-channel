import { describe, expect, test } from 'vitest'
import { DEFAULT_HARD_LIMIT, DEFAULT_SOFT_LIMIT, createLedger } from '../src/budget-config.js'

function spend(ledger: ReturnType<typeof createLedger>, points: number, session = 'p2p:peer-a'): void {
  ledger.reserve('bot-a', session, 'judge', points)
}

describe('an adapter builds its ledger from configuration', () => {
  test('without explicit ratios it softens at four fifths of capacity', () => {
    expect([DEFAULT_SOFT_LIMIT, DEFAULT_HARD_LIMIT]).toEqual([0.8, 1])
  })

  test('eighty of a hundred points is the soft limit and a hundred is the hard one', () => {
    const ledger = createLedger({ capacity: 100 })
    spend(ledger, 79)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('normal')
    spend(ledger, 1)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('soft')
    spend(ledger, 20)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
  })

  test('capacity is the denominator the ratios apply to', () => {
    const ledger = createLedger({ capacity: 10 })
    spend(ledger, 10)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('hard')
  })

  test('explicit ratios replace the defaults', () => {
    const ledger = createLedger({ capacity: 100, softLimit: 0.5, hardLimit: 0.75 })
    spend(ledger, 50)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('soft')
    spend(ledger, 25)
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
    spend(ledger, 80)
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('soft')
    now += 61 * 60_000
    expect(ledger.check('bot-a', 'p2p:peer-a').aggregate).toBe('normal')
  })
})
