import { describe, expect, test } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BudgetLedger, DEFAULT_BUDGET } from '../src/budget-ledger.js'
import { CHARGE_KINDS } from '../src/event-types.js'

const limits = { hardLimit: 1, capacity: 100 }

describe('points', () => {
  test('an accepted bot call costs 20 and a rejected one 10', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    expect(ledger.pointsFor('accepted')).toBe(20)
    expect(ledger.pointsFor('rejected')).toBe(10)
  })

  test('every point tier names a charge kind a caller can reach', () => {
    expect(Object.keys(DEFAULT_BUDGET.points).sort()).toEqual(['accepted', 'judge', 'rejected'])
    expect(CHARGE_KINDS).toEqual(['bot', 'judge'])
    expect(DEFAULT_BUDGET.points.judge).toBe(1)
  })
})

describe('three dimensions', () => {
  test('charges global, bot and session together', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    const usage = ledger.settle(ledger.reserve('bot-a', 'group:1', 'bot', 20), 'accepted')
    expect(usage).toMatchObject({ global: 20, 'bot:bot-a': 20, 'group:1': 20 })
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
  test('is normal below the hard limit', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('turns hard at the limit and names the scope that tripped', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const state = ledger.check('b', 'group:1')
    expect(state.aggregate).toBe('hard')
    expect(state.triggeredBy.length).toBeGreaterThan(0)
  })

  test('a hard in one scope is the aggregate', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const state = ledger.check('b', 'group:2')
    expect(state.byKey.global).toBe('hard')
    expect(state.aggregate).toBe('hard')
  })

  test('one bot hitting its limit does not limit another', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    expect(ledger.check('other', 'group:9').byKey['bot:other']).toBe('normal')
  })

  test('names each level by the dimension it belongs to', () => {
    const ledger = new BudgetLedger({ hardLimit: 0.9, capacity: 100 }, DEFAULT_BUDGET)
    ledger.setUsage({ global: 10, 'bot:b': 95, 'group:1': 20 })
    const state = ledger.check('b', 'group:1')
    expect(state.byDimension).toEqual({ global: 'normal', bot: 'hard', conversation: 'normal' })
    expect(state.triggeredBy).toEqual(['bot:b'])
    expect(state.aggregate).toBe('hard')
  })

  test('the dimension and the key name the same level at the same moment', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const state = ledger.check('b', 'group:1')
    expect(state.byDimension).toEqual({
      global: state.byKey.global,
      bot: state.byKey['bot:b'],
      conversation: state.byKey['group:1'],
    })
    expect(state.triggeredBy).toEqual(['global', 'bot:b', 'group:1'])
  })

  test('a peek reports the dimensions without locking anything', () => {
    const ledger = new BudgetLedger({ hardLimit: 0.9, capacity: 100 }, DEFAULT_BUDGET)
    ledger.setUsage({ global: 10, 'bot:b': 95, 'group:1': 20 })
    expect(ledger.peek('b', 'group:1').byDimension).toEqual({
      global: 'normal',
      bot: 'hard',
      conversation: 'normal',
    })
    expect(ledger.snapshot().locks).toHaveLength(0)
    expect(ledger.check('b', 'group:1').byDimension).toEqual(ledger.peek('b', 'group:1').byDimension)
  })
})

describe('reserve, settle and refund', () => {
  test('a reservation counts before settlement', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    ledger.reserve('b', 'group:1', 'bot', 1)
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
    const result = ledger.decide('b', 'group:1', () => true)
    expect(result.allowed).toBe(true)
    expect(ledger.usage('b', 'group:1').global).toBe(20)
  })

  test('a denied decision charges nothing', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    const before = ledger.usage('b', 'group:2').global
    const result = ledger.decide('b', 'group:2', () => true)
    expect(result.allowed).toBe(false)
    expect(result.limitState).toBe('hard')
    expect(ledger.usage('b', 'group:2').global).toBe(before)
  })

  test('decide refuses an async predicate', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    expect(() => ledger.decide('b', 'group:1', (async () => true) as never)).toThrow(/sync/)
  })
})

describe('hysteresis', () => {
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
    expect(ledger.check('b', 'group:1').aggregate).toBe('normal')
  })

  test('locks survive a snapshot and restore', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('b', 'group:1', 'bot', 20), 'accepted')
    ledger.check('b', 'group:1')
    const saved = ledger.snapshot()
    const restored = new BudgetLedger(limits, DEFAULT_BUDGET)
    restored.restore(saved)
    expect(restored.check('b', 'group:1').byKey.global).toBe('hard')
  })
})

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((found) => {
    const path = join(dir, found.name)
    if (found.isDirectory()) return sources(path)
    return found.name.endsWith('.ts') ? [path] : []
  })
}

describe('the point table has one reader', () => {
  test('only the ledger and the turn billing name a point value', () => {
    const root = join(import.meta.dirname, '..', 'src')
    const readers = new Set(['budget-ledger.ts', 'turn-billing.ts'])
    const offenders = sources(root)
      .filter((path) => !readers.has(path.slice(path.lastIndexOf('/') + 1)))
      .filter((path) => readFileSync(path, 'utf8').includes('pointsFor'))
    expect(offenders).toEqual([])
  })
})
