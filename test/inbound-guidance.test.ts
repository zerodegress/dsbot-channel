import { describe, expect, test } from 'vitest'
import { InjectionLedger } from '../src/inbound-guidance.js'

describe('what a session is told about answering', () => {
  test('the same session is told once, so a run of messages is not repeated', () => {
    const ledger = new InjectionLedger()

    expect(ledger.claim('session-1')).toBe(true)
    expect(ledger.claim('session-1')).toBe(false)
    expect(ledger.claim('session-2')).toBe(true)
  })

  test('clearing forgets every session', () => {
    const ledger = new InjectionLedger()
    ledger.claim('session-1')
    ledger.clear()
    expect(ledger.size).toBe(0)
    expect(ledger.claim('session-1')).toBe(true)
  })
})
