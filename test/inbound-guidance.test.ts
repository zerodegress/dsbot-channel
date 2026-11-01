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

describe('the mode block', () => {
  test('is claimed when a conversation enters tool mode', () => {
    const ledger = new InjectionLedger()
    expect(ledger.claimMode('group:1', 'tool')).toBe(true)
    expect(ledger.claimMode('group:1', 'tool')).toBe(false)
  })

  test('auto clears the state so a later tool turn repeats the block', () => {
    const ledger = new InjectionLedger()
    ledger.claimMode('group:1', 'tool')
    expect(ledger.claimMode('group:1', 'auto')).toBe(false)
    expect(ledger.claimMode('group:1', 'tool')).toBe(true)
  })

  test('conversations do not share the state', () => {
    const ledger = new InjectionLedger()
    ledger.claimMode('group:1', 'tool')
    expect(ledger.claimMode('group:2', 'tool')).toBe(true)
  })
})
