import { describe, expect, test, vi } from 'vitest'
import { buildPipeline, BuildError } from '../src/build-pipeline.js'
import type { PipelineDeps } from '../src/build-pipeline.js'
import { DEFAULT_PIPELINE } from '../src/pipeline-config.js'

const event = { eventKey: 'peer-a:m1', scope: 'p2p' as const, mentioned: { self: false, others: false, all: false }, text: 'hello' }

const deps = (): PipelineDeps => ({
  denyRules: [{ id: 'noise', reason: 'system noise', matches: () => false }],
  allowRules: [{ id: 'addressed', reason: 'mentions me', matches: () => true }],
  score: () => 2,
  judge: async () => ({ score: 7, reason: 'looks relevant' }),
  prepare: () => {},
})

describe('building from specs', () => {
  test('a deny node refuses when a rule matches', async () => {
    const pipeline = buildPipeline([{ id: 'noise', type: 'deny' }], {
      ...deps(),
      denyRules: [{ id: 'noise', reason: 'system noise', matches: () => true }],
    })
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(result.reasons.noise).toBe('system noise')
  })

  test('a deny node passes when no rule matches', async () => {
    const pipeline = buildPipeline([{ id: 'noise', type: 'deny' }, { id: 'a', type: 'allow' }], deps())
    expect((await pipeline.run(event)).decision).toBe('allow')
  })

  test('an allow node allows when a rule matches', async () => {
    const pipeline = buildPipeline([{ id: 'a', type: 'allow' }], deps())
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
    expect(result.reasons.a).toBe('mentions me')
  })

  test('a score node adds what the scorer returns', async () => {
    const pipeline = buildPipeline([{ id: 's', type: 'score' }, { id: 'a', type: 'allow' }], deps())
    expect((await pipeline.run(event)).score).toBe(2)
  })

  test('a judge node uses the injected model call', async () => {
    const pipeline = buildPipeline([{ id: 'j', type: 'judge' }], deps())
    const result = await pipeline.run(event)
    expect(result.score).toBe(7)
    expect(result.reasons.j).toBe('looks relevant')
  })

  test('a prepare node calls the injected step', async () => {
    let called = 0
    const pipeline = buildPipeline([{ id: 'p', type: 'prepare' }], { ...deps(), prepare: () => { called += 1 } })
    await pipeline.run(event)
    expect(called).toBe(1)
  })

  test('the spec order is the run order', async () => {
    const order: string[] = []
    const pipeline = buildPipeline([{ id: 's1', type: 'score' }, { id: 's2', type: 'score' }], {
      ...deps(),
      score: (context) => {
        order.push(context.event.eventKey)
        return 1
      },
    })
    await pipeline.run(event)
    expect(order.length).toBe(2)
  })
})

describe('a node without its dependency cannot be built', () => {
  test('a deny node needs deny rules', () => {
    expect(() => buildPipeline([{ id: 'd', type: 'deny' }], { ...deps(), denyRules: undefined })).toThrow(BuildError)
  })

  test('an allow node needs allow rules', () => {
    expect(() => buildPipeline([{ id: 'a', type: 'allow' }], { ...deps(), allowRules: undefined })).toThrow(/allow/)
  })

  test('a score node needs a scorer', () => {
    expect(() => buildPipeline([{ id: 's', type: 'score' }], { ...deps(), score: undefined })).toThrow(/score/)
  })

  test('a judge node needs a model call', () => {
    expect(() => buildPipeline([{ id: 'j', type: 'judge' }], { ...deps(), judge: undefined })).toThrow(/judge/)
  })

  test('a prepare node needs a step', () => {
    expect(() => buildPipeline([{ id: 'p', type: 'prepare' }], { ...deps(), prepare: undefined })).toThrow(/prepare/)
  })

  test('a budget node needs a limit check', () => {
    expect(() => buildPipeline([{ id: 'b', type: 'budget' }], { ...deps(), budget: undefined })).toThrow(/budget/)
  })

  test('the build error names the node, its type and what it lacks', () => {
    try {
      buildPipeline([{ id: 'my-deny', type: 'deny' }], { ...deps(), denyRules: undefined })
      expect.unreachable()
    } catch (error) {
      expect((error as BuildError).nodeId).toBe('my-deny')
      expect((error as BuildError).nodeType).toBe('deny')
      expect((error as BuildError).needs).toBe('denyRules')
      expect((error as BuildError).message).toBe(
        'node "my-deny" of type "deny" needs "denyRules" in the injected dependencies',
      )
    }
  })

  test('an unsupported node type is reported without naming a dependency', () => {
    try {
      buildPipeline([{ id: 'x', type: 'nope' as never }], deps())
      expect.unreachable()
    } catch (error) {
      expect((error as BuildError).nodeType).toBe('nope')
      expect((error as BuildError).needs).toBeUndefined()
      expect((error as BuildError).message).toBe('node "x" has unsupported type "nope"')
    }
  })

  test('an empty spec list builds a chain that denies every message', async () => {
    const pipeline = buildPipeline([], deps())
    expect((await pipeline.run(event)).decision).toBe('deny')
  })
})

describe('the budget node reports what the ledger says', () => {
  test('a hard limit denies', async () => {
    const pipeline = buildPipeline([{ id: 'b', type: 'budget' }], {
      ...deps(),
      budget: () => ({ state: 'hard', triggeredBy: ['bot:a'] }),
    })
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
  })

  test('a normal state passes', async () => {
    const pipeline = buildPipeline([{ id: 'b', type: 'budget' }, { id: 'a', type: 'allow' }], {
      ...deps(),
      budget: () => ({ state: 'normal', triggeredBy: [] }),
    })
    expect((await pipeline.run(event)).decision).toBe('allow')
  })
})

describe('the options a host passes', () => {
  const hung = (): PipelineDeps => ({ judge: () => new Promise(() => {}) })

  test('maxTurnMs bounds a judge timeout', async () => {
    const pipeline = buildPipeline([{ id: 'j', type: 'judge' }], hung(), { maxTurnMs: 20 })
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(result.reasons.j).toBe('judge_timeout')
  })

  test('judgeTimeoutMs refuses a hung judge as judge_timeout before the ceiling', async () => {
    const started = Date.now()
    const failures: string[] = []
    const pipeline = buildPipeline([{ id: 'j', type: 'judge' }], hung(), {
      maxTurnMs: 60_000,
      judgeTimeoutMs: 20,
      onJudgeFailure: (code) => failures.push(code),
    })
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(result.reasons.j).toBe('judge_timeout')
    expect(failures).toEqual(['judge_timeout'])
    expect(Date.now() - started).toBeLessThan(1_000)
  })

  test('DEFAULT_PIPELINE is the fallback when a host passes no options', async () => {
    vi.useFakeTimers()
    try {
      const pipeline = buildPipeline([{ id: 'j', type: 'judge' }], hung())
      const running = pipeline.run(event)
      await vi.advanceTimersByTimeAsync(DEFAULT_PIPELINE.judgeTimeoutMs - 1)
      const stillWaiting = await Promise.race([running.then(() => 'finished'), Promise.resolve('pending')])
      expect(stillWaiting).toBe('pending')
      await vi.advanceTimersByTimeAsync(1)
      const result = await running
      expect(result.decision).toBe('deny')
      expect(result.reasons.j).toBe('judge_timeout')
    } finally {
      vi.useRealTimers()
    }
  })
})
