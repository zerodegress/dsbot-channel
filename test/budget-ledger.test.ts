import { describe, expect, test } from 'vitest'
import { BudgetLedger, DEFAULT_BUDGET, sessionKeyFor } from '../src/budget-ledger.js'

const limits = { softLimit: 0.8, hardLimit: 1, capacity: 100 }

describe('points', () => {
  test('judge costs 1, an accepted bot call 20 and a rejected one 10', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    expect(ledger.pointsFor('judge')).toBe(1)
    expect(ledger.pointsFor('bot', 'accepted')).toBe(20)
    expect(ledger.pointsFor('bot', 'rejected')).toBe(10)
  })

  test('a push costs 5 by default and is configurable', () => {
    expect(new BudgetLedger(limits, DEFAULT_BUDGET).pointsFor('push')).toBe(5)
    const custom = new BudgetLedger(limits, { ...DEFAULT_BUDGET, points: { ...DEFAULT_BUDGET.points, push: 7 } })
    expect(custom.pointsFor('push')).toBe(7)
  })
})

describe('three dimensions', () => {
  test('charges global, bot and session together', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    const usage = ledger.settle(ledger.reserve('bot-a', 'group:1', 'bot', 20), 'accepted')
    expect(usage).toMatchObject({ global: 20, 'bot:bot-a': 20, 'group:1': 20 })
  })

  test('session keys follow the scope', () => {
    expect(sessionKeyFor({ scope: 'group', target: 'g1' })).toBe('group:g1')
    expect(sessionKeyFor({ scope: 'c2c', target: 'u1' })).toBe('peer:u1')
    expect(sessionKeyFor({ scope: 'p2p', target: 'peer-a' })).toBe('p2p:peer-a')
  })

  test('the session dimension aggregates every bot in it', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.settle(ledger.reserve('bot-a', 'group:1', 'bot', 20), 'accepted')
    const usage = ledger.settle(ledger.reserve('bot-b', 'group:1', 'bot', 20), 'accepted')
    expect(usage['group:1']).toBe(40)
    expect(usage.global).toBe(40)
    expect(usage['bot:bot-b']).toBe(20)
  })
})

describe('limit state', () => {
  test('is normal below the soft limit', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('turns soft at the soft limit and names the scope that tripped', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 4; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const state = ledger.check('b', 'group:1')
    expect(state.aggregate).toBe('soft')
    expect(state.triggeredBy.length).toBeGreaterThan(0)
  })

  test('turns hard at the hard limit', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
  })

  test('any hard beats any soft', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const state = ledger.check('b', 'group:2')
    expect(state.byScope.global).toBe('hard')
    expect(state.aggregate).toBe('hard')
  })

  test('one bot hitting its limit does not limit another', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('other', 'group:9').byScope['bot:other']).toBe('normal')
  })
})

describe('reserve, settle and refund', () => {
  test('a reservation counts before settlement', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.reserve('b', 'group:1', 'judge', 1)
    expect(ledger.usage('b', 'group:1').global).toBe(1)
  })

  test('settling a rejection drops the charge from 20 to 10', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    const usage = ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'rejected')
    expect(usage.global).toBe(10)
  })

  test('a refund removes the reservation', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.refund(ledger.reserve('b', 'group:1', 'bot', 20))
    expect(ledger.usage('b', 'group:1').global).toBe(0)
  })

  test('settling twice is rejected', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    const hold = ledger.reserve('b', 'group:1', 'bot', 20)
    ledger.settle(hold, 'accepted')
    expect(() => ledger.settle(hold, 'accepted')).toThrow()
  })
})

describe('check and charge are one synchronous step', () => {
  test('decide runs the callback and charges', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    const result = ledger.decide('b', 'group:1', 'judge', () => true)
    expect(result.allowed).toBe(true)
    expect(ledger.usage('b', 'group:1').global).toBe(1)
  })

  test('a denied decision charges nothing', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const before = ledger.usage('b', 'group:2').global
    const result = ledger.decide('b', 'group:2', 'bot', () => true)
    expect(result.allowed).toBe(false)
    expect(result.limitState).toBe('hard')
    expect(ledger.usage('b', 'group:2').global).toBe(before)
  })

  test('decide refuses an async predicate', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    expect(() => ledger.decide('b', 'group:1', 'bot', (async () => true) as never)).toThrow(/sync/)
  })
})

describe('hysteresis', () => {
  test('soft releases only below softLimit minus softRelease', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 4; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('soft')
    ledger.setUsage({ global: 79, 'bot:b': 79, 'group:1': 79 })
    expect(ledger.check('b', 'group:1').aggregate).toBe('soft')
    ledger.setUsage({ global: 74, 'bot:b': 74, 'group:1': 74 })
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('hard releases only after it stays below the threshold for the hold time', () => {
    let now = 0
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET, () => now)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
    ledger.setUsage({ global: 90, 'bot:b': 90, 'group:1': 90 })
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
    now = 30_000
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
    now = 61_000
    expect(ledger.check('b', 'group:1').aggregate).toBe('soft')
    ledger.setUsage({ global: 70, 'bot:b': 70, 'group:1': 70 })
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('a rebound during the hold restarts the timer', () => {
    let now = 0
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET, () => now)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
    ledger.setUsage({ global: 90, 'bot:b': 90, 'group:1': 90 })
    now = 40_000
    ledger.check('b', 'group:1')
    ledger.setUsage({ global: 99, 'bot:b': 99, 'group:1': 99 })
    ledger.check('b', 'group:1')
    ledger.setUsage({ global: 90, 'bot:b': 90, 'group:1': 90 })
    now = 60_000
    expect(ledger.check('b', 'group:1').aggregate).toBe('hard')
    now = 121_000
    expect(ledger.check('b', 'group:1').aggregate).toBe('soft')
    ledger.setUsage({ global: 70, 'bot:b': 70, 'group:1': 70 })
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('locks survive a snapshot and restore', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    ledger.check('b', 'group:1')
    const saved = ledger.snapshot()
    const restored = new BudgetLedger(limits, DEFAULT_BUDGET)
    restored.restore(saved)
    expect(restored.check('b', 'group:1').byScope.global).toBe('hard')
  })
})
