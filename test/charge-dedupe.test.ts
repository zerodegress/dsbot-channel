import { describe, expect, test } from 'vitest'
import { BudgetLedger, DEFAULT_BUDGET } from '../src/budget-ledger.js'
import { TurnBilling } from '../src/turn-billing.js'
import { createLedger } from '../src/budget-config.js'

const limits = { softLimit: 0.8, hardLimit: 1, capacity: 1000 }
const KEY = 'e1|bot-a|bot'

describe('a charge key is recorded once', () => {
  test('reserving the same charge twice records it once', () => {
    const ledger = new BudgetLedger(limits)
    const first = ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)
    const again = ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)

    expect(first.duplicate).toBe(false)
    expect(again.duplicate).toBe(true)
    expect(again.amount).toBe(0)
    expect(ledger.usage('bot-a', 'p2p:b').global).toBe(20)
  })

  test('settling the duplicate adds nothing', () => {
    const ledger = new BudgetLedger(limits)
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)
    const again = ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)

    expect(ledger.settle(again, 'accepted').global).toBe(20)
  })

  test('refunding the duplicate adds nothing back', () => {
    const ledger = new BudgetLedger(limits)
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)
    const again = ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)
    ledger.refund(again)

    expect(ledger.usage('bot-a', 'p2p:b').global).toBe(20)
  })

  test('a refunded charge can be made again, because the turn never happened', () => {
    const ledger = new BudgetLedger(limits)
    ledger.refund(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY))
    const retry = ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)

    expect(retry.duplicate).toBe(false)
    expect(ledger.usage('bot-a', 'p2p:b').global).toBe(20)
  })

  test('the record expires with the replay window it was given', () => {
    let now = 1_000_000
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET, () => now, { ttlMs: 1000, limit: 10 })
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)

    now += 500
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY).duplicate).toBe(true)
    now += 600
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY).duplicate).toBe(false)
  })

  test('a refreshed record moves to the tail, so stale ones are dropped first', () => {
    let now = 0
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET, () => now, { ttlMs: 100, limit: 2 })
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'a')
    now = 10
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'b')
    now = 110
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'a').duplicate).toBe(false)

    now = 120
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'c')
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'a').duplicate).toBe(true)
  })

  test('a full table drops the oldest record instead of refusing a live turn', () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET, () => 1_000_000, { ttlMs: 60_000, limit: 2 })
    for (const key of ['a', 'b']) ledger.reserve('bot-a', 'p2p:b', 'bot', 20, key)
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'c')

    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'b').duplicate).toBe(true)
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, 'a').duplicate).toBe(false)
  })
})

describe('two bots on one event are charged apart', () => {
  test('each bot carries its own points and the global total is their sum', () => {
    const ledger = new BudgetLedger(limits)
    ledger.settle(ledger.reserve('bot-a', 'group:1', 'bot', 20, 'e1|bot-a|bot'), 'accepted')
    ledger.settle(ledger.reserve('bot-b', 'group:1', 'bot', 20, 'e1|bot-b|bot'), 'accepted')

    const first = ledger.usage('bot-a', 'group:1')
    const second = ledger.usage('bot-b', 'group:1')
    expect(first['bot:bot-a']).toBe(20)
    expect(second['bot:bot-b']).toBe(20)
    expect(first['group:1']).toBe(40)
    expect(first.global).toBe(40)
  })

  test('the same bot charged twice for one event is still one charge', () => {
    const ledger = new BudgetLedger(limits)
    ledger.settle(ledger.reserve('bot-a', 'group:1', 'bot', 20, 'e1|bot-a|bot'), 'accepted')
    const again = ledger.reserve('bot-a', 'group:1', 'bot', 20, 'e1|bot-a|bot')

    expect(ledger.settle(again, 'accepted')).toMatchObject({ global: 20, 'bot:bot-a': 20, 'group:1': 20 })
  })
})

describe('a turn hands its own charge key to the ledger', () => {
  test('one event key reserves one turn', () => {
    const ledger = new BudgetLedger(limits)
    const billing = new TurnBilling({ ledger })
    billing.begin('bot-a', 'p2p:peer-a', 'e1')
    const again = billing.begin('bot-a', 'p2p:peer-a', 'e1')

    expect(again?.duplicate).toBe(true)
    expect(ledger.usage('bot-a', 'p2p:peer-a').global).toBe(20)
  })

  test('the same event for two bots is two turns worth of points', () => {
    const ledger = new BudgetLedger(limits)
    const billing = new TurnBilling({ ledger })
    billing.begin('bot-a', 'p2p:peer-a', 'e1')
    billing.begin('bot-b', 'p2p:peer-a', 'e1')

    expect(ledger.usage('bot-a', 'p2p:peer-a')['bot:bot-a']).toBe(20)
    expect(ledger.usage('bot-b', 'p2p:peer-a')['bot:bot-b']).toBe(20)
    expect(ledger.usage('bot-a', 'p2p:peer-a').global).toBe(40)
  })

  test('a ledger built from config follows the replay window it is handed', () => {
    let now = 1_000_000
    const ledger = createLedger({ capacity: 1000 }, { now: () => now, charges: { ttlMs: 1000 } })
    ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY)

    now += 500
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY).duplicate).toBe(true)
    now += 600
    expect(ledger.reserve('bot-a', 'p2p:b', 'bot', 20, KEY).duplicate).toBe(false)
  })
})
