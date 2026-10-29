import { describe, expect, test } from 'vitest'
import { BudgetLedger, DEFAULT_BUDGET, sessionKeyFor } from '../src/budget-ledger.js'
import { TurnBilling } from '../src/turn-billing.js'

function ledger(capacity = 100, now?: () => number): BudgetLedger {
  return new BudgetLedger({ capacity, softLimit: 0.8, hardLimit: 1 }, DEFAULT_BUDGET, now)
}

function spent(instance: BudgetLedger, peer = 'peer-a', botId = 'bot-a'): number {
  const key = sessionKeyFor({ scope: 'p2p', target: peer })
  return instance.usage(botId, key)[key]!
}

describe('a turn reserves the most it could cost before it starts', () => {
  test('the reservation is visible while the turn runs', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    const hold = billing.begin('bot-a', 'peer-a')
    expect(hold?.amount).toBe(20)
    expect(spent(instance)).toBe(20)
  })

  test('an accepted turn keeps the reservation', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    billing.accept(billing.begin('bot-a', 'peer-a'))
    expect(spent(instance)).toBe(20)
  })

  test('a rejected turn gives back the difference between accepted and rejected', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    billing.reject(billing.begin('bot-a', 'peer-a'))
    expect(spent(instance)).toBe(10)
  })

  test('a turn that never happened costs nothing', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    billing.refund(billing.begin('bot-a', 'peer-a'))
    expect(spent(instance)).toBe(0)
  })
})

describe('the ledger is optional, and its absence is not an error', () => {
  test('without a ledger every step is a no-op', () => {
    const billing = new TurnBilling()
    const hold = billing.begin('bot-a', 'peer-a')
    expect(hold).toBeUndefined()
    expect(() => billing.accept(hold)).not.toThrow()
    expect(() => billing.reject(hold)).not.toThrow()
    expect(() => billing.refund(hold)).not.toThrow()
  })
})

describe('charges follow the session the gate checks', () => {
  test('a peer is charged against its own session bucket', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    billing.begin('bot-a', 'peer-a')
    expect(spent(instance, 'peer-a')).toBe(20)
    expect(spent(instance, 'peer-b')).toBe(0)
  })

  test('two turns with one peer stack up', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    billing.accept(billing.begin('bot-a', 'peer-a'))
    billing.accept(billing.begin('bot-a', 'peer-a'))
    expect(spent(instance)).toBe(40)
  })

  test('a judge turn is charged the judge price, not the bot price', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance, chargeKind: 'judge' })
    billing.accept(billing.begin('bot-a', 'peer-a'))
    expect(spent(instance)).toBe(1)
  })
})

describe('a hold is settled once', () => {
  test('settling twice is refused instead of charging twice', () => {
    const instance = ledger()
    const billing = new TurnBilling({ ledger: instance })
    const hold = billing.begin('bot-a', 'peer-a')
    billing.accept(hold)
    expect(() => billing.reject(hold)).toThrow(/already settled/)
    expect(spent(instance)).toBe(20)
  })
})

describe('a full window stops the next turn at the gate', () => {
  test('twenty accepted turns of twenty points reach the hard limit', () => {
    const instance = ledger(400)
    const billing = new TurnBilling({ ledger: instance })
    for (let round = 0; round < 20; round += 1) billing.accept(billing.begin('bot-a', 'peer-a'))
    expect(instance.check('bot-a', sessionKeyFor({ scope: 'p2p', target: 'peer-a' })).aggregate).toBe('hard')
  })
})
