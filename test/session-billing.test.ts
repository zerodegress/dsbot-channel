import { describe, expect, test } from 'vitest'
import { BudgetLedger } from '../src/budget-ledger.js'
import { TurnBilling } from '../src/turn-billing.js'
import { InboundGate } from '../src/inbound-gate.js'
import { SessionPipelines } from '../src/session-pipeline.js'
import type { PipelineNodeSpec } from '../src/pipeline-config.js'

const templateNodes = (): PipelineNodeSpec[] => [
  { id: 'noise', type: 'deny' },
  { id: 'budget', type: 'budget' },
  { id: 'deny', type: 'deny' },
  { id: 'allow', type: 'allow' },
  { id: 'score', type: 'score' },
  { id: 'judge', type: 'judge' },
  { id: 'prepare', type: 'prepare' },
]
import type { PipelineEvent } from '../src/pipeline.js'

const LIMITS = { softLimit: 0.8, hardLimit: 1, capacity: 40 }

function ledger(): BudgetLedger {
  return new BudgetLedger(LIMITS)
}

const event: PipelineEvent = { eventKey: 'inst-a:m1', scope: 'p2p', mentioned: { self: false, others: false, all: false }, text: 'hello' }

describe('the pool one peer owns', () => {
  test('two turns of one peer land in one window, whatever host session ran them', () => {
    const budget = ledger()
    const billing = new TurnBilling({ ledger: budget })
    const key = 'p2p:inst-b'

    billing.accept(billing.begin('bot-a', key, 'e1'))
    billing.accept(billing.begin('bot-a', key, 'e2'))

    const usage = budget.usage('bot-a', key)
    expect(usage[key]).toBe(40)
    expect(Object.keys(usage)).not.toContain('session-1')
    expect(Object.keys(usage)).toEqual(['global', 'bot:bot-a', 'p2p:inst-b'])
  })

  test('a different peer has its own window', () => {
    const budget = ledger()
    const billing = new TurnBilling({ ledger: budget })

    billing.accept(billing.begin('bot-a', 'p2p:inst-b', 'e1'))
    billing.accept(billing.begin('bot-a', 'p2p:inst-c', 'e2'))

    expect(budget.usage('bot-a', 'p2p:inst-b')['p2p:inst-b']).toBe(20)
    expect(budget.usage('bot-a', 'p2p:inst-c')['p2p:inst-c']).toBe(20)
    expect(budget.usage('bot-a', 'p2p:inst-b').global).toBe(40)
  })

  test('the hard limit applies to the peer, so a second host session is refused too', async () => {
    const budget = ledger()
    const billing = new TurnBilling({ ledger: budget })
    const gate = new InboundGate({ ledger: budget })
    const key = 'p2p:inst-b'

    for (let round = 0; round < 2; round += 1) {
      billing.accept(billing.begin('bot-a', key, `e${round}`))
    }

    const first = await gate.admit({ event, peer: 'inst-b', botId: 'bot-a', author: 'person', session: key })
    expect(first).toMatchObject({ allow: false, reason: 'budget-hard' })
  })
})

describe('the key one message uses everywhere', () => {
  test('the session layer and the ledger take the same string', () => {
    const budget = ledger()
    const key = 'p2p:inst-b'
    const pipelines = new SessionPipelines({
      bots: new Map([['bot-a', { base: templateNodes(), denyRules: false, allowRules: true, prepare: false }]]),
    })

    pipelines.forSession('bot-a', key, { remove: ['allow'] })
    budget.reserve('bot-a', key, 'bot', 10, 'charge-1')

    expect(pipelines.pipelineFor('bot-a', key).map((node) => node.id)).not.toContain('allow')
    expect(budget.usage('bot-a', key)[key]).toBe(10)
  })

  test('a group key is billed under its own window, not the peer one', () => {
    const budget = ledger()
    const billing = new TurnBilling({ ledger: budget })

    billing.accept(billing.begin('bot-a', 'group:12345', 'e1'))

    expect(budget.usage('bot-a', 'group:12345')['group:12345']).toBe(20)
    expect(budget.usage('bot-a', 'group:12345')['p2p:inst-b']).toBeUndefined()
  })
})
