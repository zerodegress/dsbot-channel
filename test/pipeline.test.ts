import { describe, expect, test } from 'vitest'
import { Pipeline } from '../src/pipeline.js'
import type { PipelineNode } from '../src/pipeline.js'
import { DEFAULT_PIPELINE, checkPipeline, defaultPipelineNodes } from '../src/pipeline-config.js'

const event = { eventKey: 'onebot:1:m1', scope: 'group' as const, mentioned: false, text: 'hello' }

function node(id: string, type: PipelineNode['type'], outcome: unknown, calls?: string[]): PipelineNode {
  return {
    id,
    type,
    run: () => {
      calls?.push(id)
      return outcome as never
    },
  }
}

describe('node outputs', () => {
  test('deny ends the pipeline and the event is not answered', async () => {
    const calls: string[] = []
    const pipeline = new Pipeline([node('n1', 'deny', { kind: 'deny', reason: 'noise' }, calls), node('n2', 'score', { kind: 'score', value: 1 }, calls)])
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(calls).toEqual(['n1'])
  })

  test('allow ends scoring and judge but still bills', async () => {
    const calls: string[] = []
    const pipeline = new Pipeline([
      node('a', 'allow', { kind: 'allow', reason: 'addressed' }, calls),
      node('s', 'score', { kind: 'score', value: 5 }, calls),
      node('j', 'judge', { kind: 'score', value: 5 }, calls),
    ])
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
    expect(result.matched).toEqual(['a'])
    expect(result.skip.has('scoring')).toBe(true)
    expect(calls).toEqual(['a'])
  })

  test('pass continues without deciding', async () => {
    const pipeline = new Pipeline([node('p', 'prepare', { kind: 'pass' }), node('a', 'allow', { kind: 'allow', reason: 'ok' })])
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
  })

  test('score accumulates and is reported', async () => {
    const pipeline = new Pipeline([node('s1', 'score', { kind: 'score', value: 3 }), node('s2', 'score', { kind: 'score', value: 4 })])
    const result = await pipeline.run(event)
    expect(result.score).toBe(7)
  })
})

describe('restrict', () => {
  test('skips scoring and judge and defaults to deny when nothing allows', async () => {
    const pipeline = new Pipeline([
      node('budget', 'budget', { kind: 'restrict', skip: ['scoring', 'judge'], reason: 'soft limit' }),
      node('s', 'score', { kind: 'score', value: 9 }),
    ])
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(result.restricted).toBe(true)
    expect(result.score).toBe(0)
  })

  test('an allow that ran before still wins', async () => {
    const pipeline = new Pipeline([node('a', 'allow', { kind: 'allow', reason: 'addressed' })])
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
  })

  test('skip is a closed set', async () => {
    const pipeline = new Pipeline([node('budget', 'budget', { kind: 'restrict', skip: ['billing' as never], reason: 'x' })])
    await expect(pipeline.run(event)).rejects.toThrow(/skip/)
  })

  test('only a budget node may return restrict', async () => {
    const pipeline = new Pipeline([node('s', 'score', { kind: 'restrict', skip: ['scoring'], reason: 'x' })])
    await expect(pipeline.run(event)).rejects.toThrow(/restrict/)
  })
})

describe('maxTurnMs', () => {
  test('defaults to 120 seconds', () => {
    expect(DEFAULT_PIPELINE.maxTurnMs).toBe(120_000)
  })

  test('a slow node ends the turn and counts as dropped timeout', async () => {
    const pipeline = new Pipeline([{ id: 'slow', type: 'judge', run: () => new Promise(() => {}) }], { maxTurnMs: 20 })
    const result = await pipeline.run(event)
    expect(result.dropped).toBe('timeout')
    expect(result.decision).toBe('deny')
  })

  test('judgeTimeoutMs is a subset of maxTurnMs', () => {
    expect(DEFAULT_PIPELINE.judgeTimeoutMs).toBe(8_000)
    expect(DEFAULT_PIPELINE.judgeTimeoutMs).toBeLessThan(DEFAULT_PIPELINE.maxTurnMs)
  })

  test('a timeout is not charged', async () => {
    let charged = 0
    const pipeline = new Pipeline([{ id: 'slow', type: 'judge', run: () => new Promise(() => {}) }], { maxTurnMs: 20, charge: () => { charged += 1 } })
    const result = await pipeline.run(event)
    expect(result.dropped).toBe('timeout')
    expect(charged).toBe(0)
  })
})

describe('load time checks', () => {
  test('the default template keeps the documented order', () => {
    expect(defaultPipelineNodes().map((item) => item.type)).toEqual(['deny', 'budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
    expect(defaultPipelineNodes().map((item) => item.id)).toEqual(['noise', 'budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
  })

  test('a judge before the budget is a warning, not a refusal', () => {
    const report = checkPipeline([{ id: 'j', type: 'judge' }, { id: 'b', type: 'budget' }])
    expect(report.fatal).toEqual([])
    expect(report.warnings.join(' ')).toMatch(/judge runs before budget/)
  })

  test('allow before the budget is a warning', () => {
    const report = checkPipeline([{ id: 'a', type: 'allow' }, { id: 'b', type: 'budget' }])
    expect(report.warnings.join(' ')).toMatch(/allow runs before budget/)
  })

  test('two nodes of the same type in a row is a warning', () => {
    const report = checkPipeline([{ id: 'b', type: 'budget' }, { id: 'd1', type: 'deny' }, { id: 'd2', type: 'deny' }])
    expect(report.warnings.join(' ')).toMatch(/consecutive/)
  })

  test('a prepare node before allow or judge is a warning', () => {
    const report = checkPipeline([{ id: 'p', type: 'prepare' }, { id: 'a', type: 'allow' }])
    expect(report.warnings.join(' ')).toMatch(/prepare/)
  })

  test('a pipeline without an allow node warns that nothing will get through', () => {
    const report = checkPipeline([{ id: 'd', type: 'deny' }])
    expect(report.fatal).toEqual([])
    expect(report.warnings).toEqual(['no "allow" node: every message is denied while this pipeline is attached'])
  })

  test('an empty node list means no pipeline at all, so it warns about nothing', () => {
    const report = checkPipeline([])
    expect(report.fatal).toEqual([])
    expect(report.warnings).toEqual([])
  })

  test('a pipeline with an allow node does not carry that warning', () => {
    const report = checkPipeline([{ id: 'd', type: 'deny' }, { id: 'a', type: 'allow' }])
    expect(report.warnings).not.toContain('no "allow" node: every message is denied while this pipeline is attached')
  })

  test('the shipped default template carries no such warning', () => {
    const report = checkPipeline(defaultPipelineNodes())
    expect(report.fatal).toEqual([])
    expect(report.warnings).not.toContain('no "allow" node: every message is denied while this pipeline is attached')
  })

  test('an illegal skip value refuses to load', () => {
    const report = checkPipeline([{ id: 'b', type: 'budget', restrictSkip: ['billing' as never] }])
    expect(report.fatal.join(' ')).toMatch(/skip/)
  })

  test('a non budget node declaring restrict refuses to load', () => {
    const report = checkPipeline([{ id: 's', type: 'score', mayRestrict: true }])
    expect(report.fatal.join(' ')).toMatch(/restrict/)
  })
})
