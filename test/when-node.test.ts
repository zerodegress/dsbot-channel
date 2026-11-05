import { describe, expect, test } from 'vitest'
import { checkPipeline } from '../src/pipeline-config.js'
import { buildPipeline } from '../src/build-pipeline.js'
import type { PipelineEvent } from '../src/pipeline.js'
import { matchProblems } from '../src/match-spec.js'

const event = (overrides: Partial<PipelineEvent> = {}): PipelineEvent => ({
  eventKey: 'evt-1',
  scope: 'group',
  mentioned: { self: false, others: false, all: false },
  text: 'hello',
  peer: 'g-1',
  authorId: 'u-1',
  ...overrides,
})

const when = (test: unknown, outcome: unknown) => ({ id: 'w', type: 'when', test, outcome }) as never

describe('a matcher reads one fact or several', () => {
  test('each key alone can decide', async () => {
    const run = async (spec: unknown, one: PipelineEvent) =>
      (await buildPipeline([when(spec, 'deny')], {}).run(one)).decision
    expect(await run({ scope: 'group' }, event())).toBe('deny')
    expect(await run({ scope: 'c2c' }, event())).toBe('deny')
    expect(await run({ peer: 'g-1' }, event())).toBe('deny')
    expect(await run({ peer: { in: ['g-1', 'g-2'] } }, event())).toBe('deny')
    expect(await run({ peer: { notIn: ['g-9'] } }, event())).toBe('deny')
    expect(await run({ mentioned: true }, event({ mentioned: { self: true, others: false, all: false } }))).toBe('deny')
    expect(await run({ mentioned: true }, event({ mentioned: { self: false, others: false, all: true } }))).toBe('deny')
    expect(await run({ replyToMe: true }, event({ replyToMe: true }))).toBe('deny')
    expect(await run({ ownRecent: true }, event({ ownRecent: true }))).toBe('deny')
  })

  test('a missing peer counts as not in a list and not equal', () => {
    const noPeer = event()
    delete (noPeer as { peer?: string }).peer
    expect(matchProblems({ peer: { notIn: ['g-1'] } })).toEqual([])
    const denied = buildPipeline([when({ peer: { notIn: ['g-1'] } }, 'deny')], {})
    return expect(denied.run(noPeer).then((result) => result.decision)).resolves.toBe('deny')
  })

  test('keys combine with and', async () => {
    const both = buildPipeline([when({ scope: 'group', mentioned: true }, 'deny')], {})
    const quiet = await both.run(event({ mentioned: { self: false, others: true, all: false } }))
    expect(quiet.decision).toBe('deny')
    const mentioned = await both.run(event({ mentioned: { self: true, others: false, all: false } }))
    expect(mentioned.decision).toBe('deny')
  })
})

describe('what a when node decides', () => {
  test('allow ends the chain', async () => {
    let judged = 0
    const pipeline = buildPipeline(
      [when({ scope: 'group' }, 'allow'), { id: 'j', type: 'judge' }],
      {
        judge: async () => {
          judged += 1
          return { score: 0.5 }
        },
      },
    )
    const result = await pipeline.run(event())
    expect(result.decision).toBe('allow')
    expect(result.reasons.w).toBe('when_allow')
    expect(judged).toBe(0)
  })

  test('deny ends the chain and pass continues', async () => {
    const deny = await buildPipeline([when({ scope: 'group' }, 'deny')], {}).run(event())
    expect(deny.decision).toBe('deny')
    expect(deny.reasons.w).toBe('when_deny')

    const pass = buildPipeline(
      [when({ scope: 'group' }, 'pass'), { id: 'a', type: 'allow' }],
      { allowRules: [{ id: 'a', reason: 'ok', matches: () => true }] },
    )
    expect((await pass.run(event())).decision).toBe('allow')
  })

  test('an unmatched condition passes', async () => {
    const pipeline = buildPipeline([when({ scope: 'c2c' }, 'deny')], {})
    expect((await pipeline.run(event())).decision).toBe('deny')
    expect((await pipeline.run(event())).reasons.w).toBeUndefined()
  })

  test('a when node still runs under a scoring skip', async () => {
    const pipeline = buildPipeline(
      [
        { id: 'b', type: 'budget', mayRestrict: true, restrictSkip: ['scoring'] },
        when({ scope: 'group' }, 'deny'),
      ],
      { budget: () => ({ state: 'normal', triggeredBy: [], ratio: 1, restrictAt: 0.5 }) },
    )
    expect((await pipeline.run(event())).decision).toBe('deny')
  })
})

describe('a chance node rolls only behind its guard', () => {
  test('a guard that does not hold passes without rolling', async () => {
    const seen: string[] = []
    const pipeline = buildPipeline(
      [{ id: 'c', type: 'chance', probability: 1, outcome: 'deny', when: { scope: 'c2c' } }],
      {},
      { onChance: (hit: string) => seen.push(hit) },
    )
    const result = await pipeline.run(event())
    expect(result.decision).toBe('deny')
    expect(seen).toEqual([])
    expect(Object.values(result.reasons)).toEqual([])
  })

  test('a guard that holds rolls the probability', async () => {
    const seen: string[] = []
    const pipeline = buildPipeline(
      [{ id: 'c', type: 'chance', probability: 1, outcome: 'deny', when: { scope: 'group' } }],
      {},
      { onChance: (hit: string) => seen.push(hit) },
    )
    const result = await pipeline.run(event())
    expect(result.decision).toBe('deny')
    expect(seen).toEqual(['deny'])
  })
})

describe('the declaration is checked at mount', () => {
  test('a when node needs a test and an outcome', () => {
    expect(checkPipeline([{ id: 'w', type: 'when' } as never]).fatal.join(' ')).toMatch(/needs a test/)
    expect(checkPipeline([{ id: 'w', type: 'when', test: { scope: 'group' } } as never]).fatal.join(' ')).toMatch(/needs outcome/)
  })

  test('a bad matcher is named', () => {
    for (const test of [{}, { scope: 'room' }, { peer: { in: [], notIn: [] } }, { mentioned: 'yes' }, { bogus: 1 }]) {
      expect(checkPipeline([when(test, 'deny')]).fatal.length).toBeGreaterThan(0)
    }
  })

  test('test belongs to when and when belongs to chance', () => {
    expect(checkPipeline([{ id: 'c', type: 'chance', probability: 0.5, outcome: 'allow', test: { scope: 'group' } } as never]).fatal.join(' ')).toMatch(/only a when node/)
    expect(checkPipeline([{ id: 'd', type: 'deny', when: { scope: 'group' } } as never]).fatal.join(' ')).toMatch(/only a chance node/)
    expect(checkPipeline([{ id: 'd', type: 'deny', test: { scope: 'group' } } as never]).fatal.join(' ')).toMatch(/only a when node/)
  })

  test('a chance guard is checked like a matcher', () => {
    expect(checkPipeline([{ id: 'c', type: 'chance', probability: 0.5, outcome: 'allow', when: { scope: 'x' } } as never]).fatal.length).toBeGreaterThan(0)
    expect(checkPipeline([{ id: 'c', type: 'chance', probability: 0.5, outcome: 'allow', when: { scope: 'group' } } as never]).fatal).toEqual([])
  })

  test('a when node may not carry another type field', () => {
    expect(checkPipeline([{ id: 'w', type: 'when', test: { scope: 'group' }, outcome: 'pass', probability: 0.5 } as never]).fatal.join(' ')).toMatch(/only a chance node may declare probability/)
    expect(checkPipeline([{ id: 'w', type: 'when', test: { scope: 'group' }, outcome: 'pass', allowAtLeast: 0.5 } as never]).fatal.join(' ')).toMatch(/only a judge node/)
  })
})
