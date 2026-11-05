import { describe, expect, test } from 'vitest'
import { checkPipeline } from '../src/pipeline-config.js'
import { buildPipeline } from '../src/build-pipeline.js'
import type { PipelineEvent } from '../src/pipeline.js'
import { resolvePipeline } from '../src/pipeline-scopes.js'
import { SessionPipelines } from '../src/session-pipeline.js'

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

describe('where a chance node may be declared', () => {
  test('a bot layer may insert or override one', () => {
    const inserted = resolvePipeline({
      global: [{ id: 'd', type: 'deny' }],
      bot: { insert: [{ id: 'c', type: 'chance', after: 'd', probability: 0.25, outcome: 'deny' }] },
    }).nodes
    expect(inserted.find((node) => node.id === 'c')).toMatchObject({ probability: 0.25, outcome: 'deny' })

    const overridden = resolvePipeline({
      global: [{ id: 'c', type: 'chance', probability: 0.5, outcome: 'allow' }],
      bot: { override: { c: { probability: 0.1 } } },
    }).nodes
    expect(overridden.find((node) => node.id === 'c')?.probability).toBe(0.1)
  })

  test('a session insert cannot carry the odds, but a session override can', () => {
    const bots = new Map([
      [
        'orca',
        {
          base: [{ id: 'c', type: 'chance', probability: 0.5, outcome: 'allow' } as never],
          denyRules: true,
          allowRules: true,
          prepare: false,
          peers: ['seal'],
        },
      ],
    ])
    const sessions = new SessionPipelines({ bots })
    expect(() =>
      sessions.forSession('orca', 'peer:u1', {
        insert: [{ id: 'c2', type: 'chance', after: 'c', probability: 0.5 } as never],
      }),
    ).toThrow(/no insert has/)
    sessions.forSession('orca', 'peer:u1', { override: { c: { probability: 1 } } })
    expect(sessions.pipelineFor('orca', 'peer:u1').find((node) => node.id === 'c')?.probability).toBe(1)
  })
})

describe('what a chance node decides', () => {
  test('the same event key always gets the same verdict', async () => {
    const decisions: string[] = []
    for (let round = 0; round < 100; round += 1) {
      const pipeline = buildPipeline([chance(0.5, 'allow')], {})
      const result = await pipeline.run(event('evt-1'))
      decisions.push(JSON.stringify({ decision: result.decision, reasons: result.reasons }))
    }
    expect(new Set(decisions).size).toBe(1)
  })

  test('a large sample follows the probability', async () => {
    const pipeline = buildPipeline([chance(0.3, 'deny')], {})
    let denied = 0
    const total = 10_000
    for (let index = 0; index < total; index += 1) {
      const result = await pipeline.run(event(`evt-${index}`))
      if (result.decision === 'deny' && Object.values(result.reasons).some((one) => one.startsWith('chance_deny'))) {
        denied += 1
      }
    }
    expect(denied / total).toBeGreaterThan(0.28)
    expect(denied / total).toBeLessThan(0.32)
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

  test('a hit allow skips what an allow node would skip and stops a judge', async () => {
    let judged = 0
    const pipeline = buildPipeline([chance(1, 'allow'), { id: 'j', type: 'judge' } as never], {
      judge: async () => {
        judged += 1
        return { score: 0.5 }
      },
    })
    const result = await pipeline.run(event('evt-skip'))
    expect(result.decision).toBe('allow')
    expect(result.skip.has('judge')).toBe(true)
    expect(result.skip.has('scoring')).toBe(true)
    expect(judged).toBe(0)
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
    const pipeline = buildPipeline([chance(0, 'allow')], {}, { onChance: (hit: string) => seen.push(hit) } as never)
    await pipeline.run(event('evt-4'))
    expect(seen).toEqual(['miss'])

    const hit = buildPipeline([chance(1, 'allow')], {}, { onChance: (one: string) => seen.push(one) } as never)
    await hit.run(event('evt-5'))
    expect(seen).toEqual(['miss', 'allow'])
  })
})
