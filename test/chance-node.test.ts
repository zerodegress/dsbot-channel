import { describe, expect, test } from 'vitest'
import { checkPipeline } from '../src/pipeline-config.js'
import { buildPipeline } from '../src/build-pipeline.js'
import type { PipelineEvent } from '../src/pipeline.js'

function event(eventKey: string): PipelineEvent {
  return {
    eventKey,
    scope: 'group',
    mentioned: { self: false, others: false, all: false },
    text: 'hello',
    authorId: '20002',
  }
}

const chance = (probability: number, outcome: 'allow' | 'deny', id = 'c') =>
  ({ id, type: 'chance', probability, outcome }) as never

describe('the chance node declaration', () => {
  test('takes a probability and an outcome', () => {
    expect(checkPipeline([chance(0.3, 'allow')]).fatal).toEqual([])
    expect(checkPipeline([chance(0, 'deny')]).fatal).toEqual([])
    expect(checkPipeline([chance(1, 'allow')]).fatal).toEqual([])
  })

  test('refuses a probability outside 0..1 or missing', () => {
    for (const probability of [-0.1, 1.1, Number.NaN, '0.5', undefined]) {
      expect(checkPipeline([chance(probability as never, 'allow')]).fatal.length).toBeGreaterThan(0)
    }
  })

  test('refuses an outcome that is not allow or deny', () => {
    expect(checkPipeline([chance(0.5, 'skip' as never)]).fatal.length).toBeGreaterThan(0)
    expect(checkPipeline([{ id: 'c', type: 'chance', probability: 0.5 } as never]).fatal.length).toBeGreaterThan(0)
  })

  test('only a chance node may declare them', () => {
    expect(checkPipeline([{ id: 'd', type: 'deny', probability: 0.5, outcome: 'allow' } as never]).fatal.length).toBeGreaterThan(0)
  })
})

describe('what a chance node decides', () => {
  test('the same event key always gets the same verdict', async () => {
    const decisions: string[] = []
    for (let round = 0; round < 5; round += 1) {
      const pipeline = buildPipeline([chance(0.5, 'allow')], {})
      const result = await pipeline.run(event('evt-1'))
      decisions.push(JSON.stringify({ decision: result.decision, reasons: result.reasons }))
    }
    expect(new Set(decisions).size).toBe(1)
  })

  test('a large sample follows the probability', async () => {
    const pipeline = buildPipeline([chance(0.3, 'deny')], {})
    let denied = 0
    const total = 5000
    for (let index = 0; index < total; index += 1) {
      const result = await pipeline.run(event(`evt-${index}`))
      if (result.decision === 'deny' && Object.values(result.reasons).some((one) => one.startsWith('chance_deny'))) {
        denied += 1
      }
    }
    expect(denied / total).toBeGreaterThan(0.27)
    expect(denied / total).toBeLessThan(0.33)
  })

  test('two nodes on one message take independent buckets', async () => {
    const first = buildPipeline([chance(0.5, 'allow', 'a')], {})
    const second = buildPipeline([chance(0.5, 'allow', 'b')], {})
    let differed = false
    for (let index = 0; index < 30; index += 1) {
      const key = `evt-salt-${index}`
      const one = await first.run(event(key))
      const two = await second.run(event(key))
      if (one.decision !== two.decision) differed = true
    }
    expect(differed).toBe(true)
  })

  test('a miss leaves its own reason in the result', async () => {
    const pipeline = buildPipeline([chance(0, 'allow')], {})
    const result = await pipeline.run(event('evt-miss'))
    expect(result.matched).toContain('c')
    expect(result.reasons.c).toMatch(/^chance_miss \(p=0\)$/)
  })

  test('a miss passes the chain on and a hit ends it', async () => {
    const miss = buildPipeline([chance(0, 'allow'), { id: 'a', type: 'allow' } as never], {
      allowRules: [{ id: 'a', reason: 'allowed_by_rule', matches: () => true }],
    })
    await expect(miss.run(event('evt-2'))).resolves.toMatchObject({ decision: 'allow' })
    const missReasons = Object.values((await miss.run(event('evt-2'))).reasons)
    expect(missReasons).toContain('allowed_by_rule')
    expect(missReasons.some((one) => one.startsWith('chance_allow'))).toBe(false)

    const hit = buildPipeline([chance(1, 'deny'), { id: 'a', type: 'allow' } as never], {
      allowRules: [{ id: 'a', reason: 'allowed_by_rule', matches: () => true }],
    })
    const result = await hit.run(event('evt-3'))
    expect(result.decision).toBe('deny')
    expect(Object.values(result.reasons).some((one) => one.startsWith('chance_deny'))).toBe(true)
  })

  test('counts each outcome it takes', async () => {
    const seen: string[] = []
    const pipeline = buildPipeline([chance(0, 'allow')], {}, { onChance: (hit) => seen.push(hit) } as never)
    await pipeline.run(event('evt-4'))
    expect(seen).toEqual(['pass'])

    const hit = buildPipeline([chance(1, 'allow')], {}, { onChance: (one) => seen.push(one) } as never)
    await hit.run(event('evt-5'))
    expect(seen).toEqual(['pass', 'allow'])
  })
})
