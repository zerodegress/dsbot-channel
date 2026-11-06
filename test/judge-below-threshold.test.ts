import { describe, expect, test } from 'vitest'
import { buildPipeline } from '../src/build-pipeline.js'
import type { PipelineDeps } from '../src/build-pipeline.js'
import { checkPipeline } from '../src/pipeline-config.js'

const event = { eventKey: 'peer-a:m1', scope: 'p2p' as const, mentioned: { self: false, others: false, all: false }, text: 'hello' }

const deps = (score: number, prepare: PipelineDeps['prepare'] = () => {}): PipelineDeps => ({
  denyRules: [{ id: 'noise', reason: 'system noise', matches: () => false }],
  allowRules: [{ id: 'addressed', reason: 'mentions me', matches: () => true }],
  score: () => 2,
  judge: async () => ({ score }),
  prepare,
})

describe('a judge below its threshold', () => {
  test('is denied by default', async () => {
    const pipeline = buildPipeline([{ id: 'j', type: 'judge', allowAtLeast: 0.5 }], deps(0.2))
    const result = await pipeline.run(event)
    expect(result.decision).toBe('deny')
    expect(result.reasons.j).toMatch(/judge_below_threshold/)
  })

  test('passes the chain on when belowThreshold is pass', async () => {
    const pipeline = buildPipeline(
      [
        { id: 'j', type: 'judge', allowAtLeast: 0.5, belowThreshold: 'pass' },
        { id: 'a', type: 'allow' },
      ],
      deps(0.2),
    )
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
    expect(result.matched).toEqual(['j', 'a'])
    expect(result.reasons.j).toBe('judge_below_threshold_pass')
  })

  test('still counts its score toward the running score', async () => {
    const seen: number[] = []
    const pipeline = buildPipeline(
      [
        { id: 'j', type: 'judge', allowAtLeast: 0.5, belowThreshold: 'pass' },
        { id: 'p', type: 'prepare' },
      ],
      deps(0.2, (context) => {
        seen.push(context.score)
      }),
    )
    await pipeline.run(event)
    expect(seen).toEqual([0.2])
  })

  test('at or above the threshold still allows', async () => {
    const pipeline = buildPipeline([{ id: 'j', type: 'judge', allowAtLeast: 0.5, belowThreshold: 'pass' }], deps(0.9))
    const result = await pipeline.run(event)
    expect(result.decision).toBe('allow')
  })
})

describe('declaring belowThreshold', () => {
  test('needs allowAtLeast', () => {
    const report = checkPipeline([{ id: 'j', type: 'judge', belowThreshold: 'pass' }])
    expect(report.fatal.join(' ')).toMatch(/belowThreshold needs allowAtLeast/)
  })

  test('belongs to a judge node', () => {
    const report = checkPipeline([
      { id: 'w', type: 'when', test: { scope: 'p2p' }, outcome: 'pass', belowThreshold: 'pass' } as never,
    ])
    expect(report.fatal.join(' ')).toMatch(/only a judge node may declare belowThreshold/)
  })

  test('takes deny or pass only', () => {
    const report = checkPipeline([{ id: 'j', type: 'judge', allowAtLeast: 0.5, belowThreshold: 'maybe' } as never])
    expect(report.fatal.join(' ')).toMatch(/belowThreshold must be deny or pass/)
  })
})
