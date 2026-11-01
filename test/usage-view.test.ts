import { describe, expect, test } from 'vitest'
import { BudgetLedger } from '../src/budget-ledger.js'
import { usageSnapshot } from '../src/usage-view.js'

const LIMITS = { softLimit: 0.8, hardLimit: 1, capacity: 40 }

describe('the quota a host may read', () => {
  test('reports one entry per bot, with its limits and its sessions', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 20, 'c1')
    const view = usageSnapshot([{ bot: 'bot-a', ledger }], () => 1_000)

    expect(view.sampledAt).toBe(1_000)
    expect(view.bots).toHaveLength(1)
    const bot = view.bots[0]!
    expect(bot.bot).toBe('bot-a')
    expect(bot.limits).toEqual({ capacity: 40, hardLimit: 1 })
    expect(bot.sessions.map((one) => one.sessionKey)).toEqual(['p2p:inst-b'])
    expect(bot.sessions[0]?.usage).toMatchObject({ global: 20, 'bot:bot-a': 20, 'p2p:inst-b': 20 })
    expect(bot.sessions[0]?.level).toBe('normal')
  })

  test('a bot without a budget is listed with no limits and no sessions', () => {
    const view = usageSnapshot([{ bot: 'bot-b', ledger: undefined }], () => 5)
    expect(view.bots[0]).toEqual({ bot: 'bot-b', limits: null, sessions: [] })
  })

  test('the session key is the same string a profile writes', () => {
    const ledger = new BudgetLedger(LIMITS)
    const key = 'group:12345'
    ledger.reserve('bot-a', key, 'bot', 10)
    const view = usageSnapshot([{ bot: 'bot-a', ledger }])
    expect(Object.keys(view.bots[0]!.sessions[0]!.usage)).toContain(key)
    expect(view.bots[0]!.sessions[0]!.sessionKey).toBe(key)
  })

  test('a reader that edits the copy cannot reach the ledger', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 20)
    const first = usageSnapshot([{ bot: 'bot-a', ledger }])
    first.bots[0]!.sessions[0]!.usage.global = 999
    first.bots[0]!.sessions[0]!.triggeredBy.push('fake')

    const second = usageSnapshot([{ bot: 'bot-a', ledger }])
    expect(second.bots[0]!.sessions[0]!.usage.global).toBe(20)
    expect(second.bots[0]!.sessions[0]!.triggeredBy).toEqual([])
  })

  test('reading changes nothing', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 20)
    const before = ledger.usage('bot-a', 'p2p:inst-b')
    usageSnapshot([{ bot: 'bot-a', ledger }])
    expect(ledger.usage('bot-a', 'p2p:inst-b')).toEqual(before)
  })

  test('the ledger hands out its sessions and limits as copies', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 20)
    expect(ledger.sessions()).toEqual(['p2p:inst-b'])
    const limits = ledger.limitsView()
    limits.capacity = 999
    expect(ledger.limitsView().capacity).toBe(40)
  })
})

describe('reading a snapshot leaves the ledger alone', () => {
  const T0 = 1_000_000

  /** Fills the window to the hard limit and lets the ledger record the lock. */
  function driveToHard(ledger: BudgetLedger): void {
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 40)
    expect(ledger.check('bot-a', 'p2p:inst-b').aggregate).toBe('hard')
  }

  /** Drops the window to half capacity, which is below the soft release point. */
  function dropToHalf(ledger: BudgetLedger): void {
    ledger.setUsage({ global: 20, 'bot:bot-a': 20, 'p2p:inst-b': 20 })
  }

  test('a read while the window is full does not extend the hard lock', () => {
    let now = T0
    const withoutReads = new BudgetLedger(LIMITS, undefined, () => now)
    const withReads = new BudgetLedger(LIMITS, undefined, () => now)
    driveToHard(withoutReads)
    driveToHard(withReads)

    // The reads happen while the window is still full, where a refreshing check would move the lock.
    now = T0 + 50_000
    for (let round = 0; round < 4; round += 1) {
      usageSnapshot([{ bot: 'bot-a', ledger: withReads }], () => now)
    }

    dropToHalf(withoutReads)
    dropToHalf(withReads)
    now = T0 + 100_000

    expect(withReads.check('bot-a', 'p2p:inst-b').aggregate).toBe(withoutReads.check('bot-a', 'p2p:inst-b').aggregate)
  })

  test('a snapshot neither creates windows nor changes what check reports', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 40)
    const before = ledger.check('bot-a', 'p2p:inst-b')
    usageSnapshot([{ bot: 'bot-a', ledger }])
    expect(ledger.check('bot-a', 'p2p:inst-b')).toEqual(before)
    expect(ledger.sessions()).toEqual(['p2p:inst-b'])
  })

  test('peek answers the same level as check without holding a lock', () => {
    const ledger = new BudgetLedger(LIMITS)
    ledger.reserve('bot-a', 'p2p:inst-b', 'bot', 40)
    expect(ledger.peek('bot-a', 'p2p:inst-b').aggregate).toBe(ledger.check('bot-a', 'p2p:inst-b').aggregate)
  })
})
