import { describe, expect, test } from 'vitest'
import { buildPipeline } from '../src/build-pipeline.js'
import { ConfigError } from '../src/config.js'
import { checkPipeline } from '../src/pipeline-config.js'
import { compilePolicy } from '../src/policy-config.js'
import type { PipelineEvent } from '../src/pipeline.js'

function event(text: string, peer?: string): PipelineEvent {
  return peer === undefined
    ? { eventKey: 'peer-a:m1', scope: 'p2p', mentioned: { self: false, others: false, all: false }, text }
    : { eventKey: 'peer-a:m1', scope: 'p2p', mentioned: { self: false, others: false, all: false }, text, peer }
}

const policy = { deny: { words: ['spam'] }, allow: { peers: ['inst-b'] } }

describe('configuration compiles into rules', () => {
  test('nothing configured builds no node at all', () => {
    expect(compilePolicy({})).toEqual({ specs: [], deps: {} })
    expect(compilePolicy({ deny: { words: [], regexes: [] }, allow: { peers: [] } })).toEqual({ specs: [], deps: {} })
  })

  test('deny rules come before allow rules, so a blocked word wins over a known peer', async () => {
    const { specs, deps } = compilePolicy(policy)
    expect(specs.map((spec) => spec.type)).toEqual(['deny', 'allow'])
    expect((await buildPipeline(specs, deps).run(event('spam and eggs', 'inst-b'))).decision).toBe('deny')
  })

  test('a known peer gets its message through', async () => {
    const { specs, deps } = compilePolicy(policy)
    const result = await buildPipeline(specs, deps).run(event('hello', 'inst-b'))
    expect(result.decision).toBe('allow')
    expect(result.reasons.allow).toBe('allowed: peer "inst-b"')
  })

  test('an unknown peer never reaches an allow verdict', async () => {
    const { specs, deps } = compilePolicy(policy)
    const result = await buildPipeline(specs, deps).run(event('hello', 'inst-c'))
    expect(result.decision).toBe('deny')
    expect(result.reasons).toEqual({})
  })

  test('a matched word is named in the reason', async () => {
    const { specs, deps } = compilePolicy(policy)
    const result = await buildPipeline(specs, deps).run(event('SPAM', 'inst-c'))
    expect(result.reasons.deny).toBe('denied: word "spam" present')
  })

  test('a word matches inside a longer word, case aside', async () => {
    const { specs, deps } = compilePolicy({ deny: { words: ['Casino'] } })
    const result = await buildPipeline(specs, deps).run(event('visit my CASINO now'))
    expect(result.reasons.deny).toBe('denied: word "casino" present')
  })

  test('a pattern matches and its source is named in the reason', async () => {
    const { specs, deps } = compilePolicy({ deny: { regexes: ['^/ignore'] } })
    const result = await buildPipeline(specs, deps).run(event('/IGNORE everything'))
    expect(result.reasons.deny).toBe('denied: pattern "^/ignore" matched')
  })

  test('an empty text never matches a word or a pattern', async () => {
    const { specs, deps } = compilePolicy({ deny: { words: ['spam'], regexes: ['spam'] } })
    const result = await buildPipeline(specs, deps).run(event(''))
    expect(result.decision).toBe('deny')
    expect(result.reasons).toEqual({})
  })

  test('a deny only policy is reported as blocking everything, which it does', () => {
    const { specs } = compilePolicy({ deny: { words: ['spam'] } })
    expect(checkPipeline(specs).warnings).toEqual([
      'no "allow" node: every message is denied while this pipeline is attached',
    ])
  })

  test('a compiled policy always satisfies the dependencies its nodes need', () => {
    for (const config of [{}, { deny: { words: ['a'] } }, policy]) {
      const { specs, deps } = compilePolicy(config)
      expect(() => buildPipeline(specs, deps)).not.toThrow()
    }
  })
})

describe('a policy that cannot mean anything is refused at load', () => {
  test('an unusable pattern names the entry that broke', () => {
    try {
      compilePolicy({ deny: { regexes: ['ok', '([unclosed'] } })
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as ConfigError).message).toContain('deny.regexes.1')
      expect((error as ConfigError).fields).toEqual(['deny'])
    }
  })

  test('a blank word is refused rather than matching everything', () => {
    try {
      compilePolicy({ deny: { words: ['  '] } })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigError).message).toContain('deny.words.0')
    }
  })

  test('a blank peer is refused rather than matching nothing', () => {
    try {
      compilePolicy({ allow: { peers: [''] } })
      expect.unreachable()
    } catch (error) {
      expect((error as ConfigError).message).toContain('allow.peers.0')
    }
  })
})
