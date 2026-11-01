import { describe, expect, test } from 'vitest'
import { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from '../src/inbound-gate.js'
import { Pipeline } from '../src/pipeline.js'
import type { PipelineNode } from '../src/pipeline.js'
import { BudgetLedger, DEFAULT_BUDGET } from '../src/budget-ledger.js'
import { ConfigError } from '../src/config.js'

const event = { eventKey: 'peer-a:m1', scope: 'p2p' as const, mentioned: false, text: 'hello', peer: 'peer-a' }

describe('loop guard', () => {
  test('the default ceiling is three rounds', () => {
    expect(DEFAULT_LOOP_MAX_TURNS).toBe(3)
  })

  test('the first rounds are allowed and the ceiling stops the next one', async () => {
    const gate = new InboundGate({})
    for (let round = 1; round <= 3; round += 1) {
      expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).allow).toBe(true)
      gate.recordReply('bot', 'peer-a')
    }
    const stopped = await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })
    expect(stopped.allow).toBe(false)
    expect(stopped.reason).toBe('loop-limit')
  })

  test('counters are per peer, so one runaway peer does not silence another', async () => {
    const gate = new InboundGate({})
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).reason).toBe('loop-limit')
    expect((await gate.admit({ event: { ...event, eventKey: 'peer-b:m9' }, peer: 'peer-b', botId: 'bot', session: 'p2p:peer-b' })).allow).toBe(true)
  })

  test('a person speaking resets the peer counter', async () => {
    const gate = new InboundGate({})
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    gate.resetPeer('peer-a')
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).allow).toBe(true)
  })

  test('the ceiling is configurable', async () => {
    const gate = new InboundGate({ loop: { relayLimit: 1 } })
    gate.recordReply('bot', 'peer-a')
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).reason).toBe('loop-limit')
  })

  test('silence for the idle window clears the counter', async () => {
    let now = 0
    const gate = new InboundGate({ now: () => now })
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).reason).toBe('loop-limit')
    now += DEFAULT_LOOP_IDLE_RESET_MS + 1
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).allow).toBe(true)
  })

  test('a short pause does not clear the counter', async () => {
    let now = 0
    const gate = new InboundGate({ now: () => now })
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    now += DEFAULT_LOOP_IDLE_RESET_MS - 1
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).reason).toBe('loop-limit')
  })

  test('the scope that tripped the budget is reported on every refusal', async () => {
    const gate = new InboundGate({})
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })
    expect(decision.reason).toBe('loop-limit')
    expect(decision.triggeredBy).toBeDefined()
  })

  test('the idle window is configurable', async () => {
    let now = 0
    const gate = new InboundGate({ loop: { relayResetMs: 60_000 }, now: () => now })
    for (let round = 0; round < 3; round += 1) gate.recordReply('bot', 'peer-a')
    now += 10 * 60_000
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).allow).toBe(true)
  })

  test.each([0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'a ceiling of %s is refused instead of read as no ceiling',
    (value) => {
      expect(() => new InboundGate({ loop: { relayLimit: value } })).toThrow(ConfigError)
    },
  )

  test.each([0, -1, 1500.5, Number.NaN])('a reset window of %s is refused', (value) => {
    expect(() => new InboundGate({ loop: { relayResetMs: value } })).toThrow(ConfigError)
  })

  test('the refusal names the field an operator has to fix', () => {
    try {
      new InboundGate({ loop: { relayLimit: 0 } })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigError).message).toContain('loop.relayLimit')
      expect((error as ConfigError).fields).toEqual(['relayLimit'])
    }
  })
})

describe('the pipeline decides first when one is configured', () => {
  const node = (type: PipelineNode['type'], output: unknown): PipelineNode => ({ id: type, type, run: () => output as never })

  test('a deny node stops the turn and says why', async () => {
    const pipeline = new Pipeline([node('deny', { kind: 'deny', reason: 'noise' })])
    const gate = new InboundGate({ pipeline })
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })
    expect(decision).toMatchObject({ allow: false, reason: 'pipeline-deny', detail: 'noise' })
  })

  test('an allow node lets it through', async () => {
    const pipeline = new Pipeline([node('allow', { kind: 'allow', reason: 'addressed' })])
    const gate = new InboundGate({ pipeline })
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })).allow).toBe(true)
  })

  test('a restrict without an allow counts as do-not-reply', async () => {
    const pipeline = new Pipeline([node('budget', { kind: 'restrict', skip: ['scoring', 'judge'], reason: 'soft' })])
    const gate = new InboundGate({ pipeline })
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot' , session: 'p2p:peer-a' })
    expect(decision).toMatchObject({ allow: false, reason: 'pipeline-restrict' })
  })

  test('the pipeline a caller passes with the turn wins over the configured one', async () => {
    const configured = new Pipeline([node('allow', { kind: 'allow', reason: 'configured' })])
    const session = new Pipeline([node('deny', { kind: 'deny', reason: 'this session refuses' })])
    const gate = new InboundGate({ pipeline: configured })
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot', pipeline: session , session: 'p2p:peer-a' })
    expect(decision).toMatchObject({ allow: false, reason: 'pipeline-deny', detail: 'this session refuses' })
  })

  test('without a pipeline the event is allowed on its own', async () => {
    expect((await new InboundGate({}).admit({ event, peer: 'peer-a', botId: 'bot', session: 'p2p:peer-a' })).reason).toBe('allowed')
  })
})

describe('the budget is consulted before a turn starts', () => {
  const limits = { softLimit: 0.8, hardLimit: 1, capacity: 100 }

  test('a hard limit refuses the turn and names the scope', async () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('bot', 'p2p:peer-a', 'bot', 20), 'accepted')
    const gate = new InboundGate({ ledger })
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot', session: 'p2p:peer-a' })
    expect(decision.allow).toBe(false)
    expect(decision.reason).toBe('budget-hard')
    expect(decision.triggeredBy?.length).toBeGreaterThan(0)
  })

  test('a hard limit refuses before the loop counter is consulted', async () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('bot', 'p2p:peer-a', 'bot', 20), 'accepted')
    const gate = new InboundGate({ ledger })
    expect((await gate.admit({ event, peer: 'peer-a', botId: 'bot', session: 'p2p:peer-a' })).reason).toBe('budget-hard')
  })

  test('a soft limit still allows the turn but reports it', async () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 4; i += 1) ledger.settle(ledger.reserve('bot', 'p2p:peer-a', 'bot', 20), 'accepted')
    const gate = new InboundGate({ ledger })
    const decision = await gate.admit({ event, peer: 'peer-a', botId: 'bot', session: 'p2p:peer-a' })
    expect(decision.allow).toBe(true)
    expect(decision.limitState).toBe('soft')
  })

  test('a refused turn is not charged', async () => {
    const ledger = new BudgetLedger(limits, DEFAULT_BUDGET)
    for (let i = 0; i < 5; i += 1) ledger.settle(ledger.reserve('bot', 'p2p:peer-a', 'bot', 20), 'accepted')
    const before = ledger.usage('bot', 'p2p:peer-a').global
    await new InboundGate({ ledger }).admit({ event, peer: 'peer-a', botId: 'bot', session: 'p2p:peer-a' })
    expect(ledger.usage('bot', 'p2p:peer-a').global).toBe(before)
  })
})
