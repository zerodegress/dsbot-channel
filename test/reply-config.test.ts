import { describe, expect, test } from 'vitest'
import { compileReply } from '../src/reply-config.js'
import type { ReplyFacts } from '../src/reply-config.js'
import { ConfigError } from '../src/config.js'

function facts(overrides: Partial<ReplyFacts> = {}): ReplyFacts {
  return {
    source: { kind: 'p2p', instance: 'a', peer: 'b', scope: 'p2p' },
    author: { kind: 'bot', senderId: 'bot-b' },
    transport: { mentioned: { self: false, others: false, all: false }, isReply: false },
    body: { text: 'hello', media: [] },
    ...overrides,
  }
}

describe('the reply block a profile writes', () => {
  test('an absent block answers like a person: auto, never tool', () => {
    const plan = compileReply(undefined)
    expect(plan.possibleTool).toBe(false)
    expect(plan.modeFor(facts())).toBe('auto')
  })

  test('an empty block is the same as none', () => {
    expect(compileReply({}).modeFor(facts())).toBe('auto')
  })

  test('an unknown mode is refused with its path', () => {
    expect(() => compileReply({ default: 'chatty' })).toThrow(ConfigError)
    expect(() => compileReply({ default: 'chatty' })).toThrow(/reply\.default/)
  })

  test('a byScope key outside the three scopes is refused', () => {
    expect(() => compileReply({ byScope: { channel: 'tool' } })).toThrow(/unknown field: channel/)
  })

  test('a rule needs both a when and a mode', () => {
    expect(() => compileReply({ rules: [{ mode: 'tool' }] })).toThrow(/needs a when/)
    expect(() => compileReply({ rules: [{ when: {} }] })).toThrow(/needs a mode/)
  })

  test('an empty any list is refused', () => {
    expect(() => compileReply({ rules: [{ when: { any: [] }, mode: 'tool' }] })).toThrow(/list at least one when/)
  })

  test('a when nests no deeper than four', () => {
    const when = { any: [{ any: [{ any: [{ any: [{}] }] }] }] }
    expect(() => compileReply({ rules: [{ when, mode: 'tool' }] })).toThrow(/nests deeper than 4/)
  })

  test('an invalid regex names the rule and the pattern', () => {
    expect(() =>
      compileReply({ rules: [{ when: { body: { text: { regexes: ['('] } } }, mode: 'tool' }] }),
    ).toThrow(/reply\.rules\.0\.when\.body\.text\.regexes\.0/)
  })

  test('an unknown field deep inside a when is refused', () => {
    expect(() => compileReply({ rules: [{ when: { source: { channel: 'x' } }, mode: 'tool' }] })).toThrow(
      /reply\.rules\.0\.when\.source/,
    )
  })
})

describe('choosing a mode', () => {
  test('the first matching rule wins, so order matters', () => {
    const first = compileReply({
      rules: [
        { when: { source: { kind: 'p2p' } }, mode: 'tool' },
        { when: {}, mode: 'auto' },
      ],
    })
    const second = compileReply({
      rules: [
        { when: {}, mode: 'auto' },
        { when: { source: { kind: 'p2p' } }, mode: 'tool' },
      ],
    })
    expect(first.modeFor(facts())).toBe('tool')
    expect(second.modeFor(facts())).toBe('auto')
  })

  test('byScope answers when no rule matches, then default', () => {
    const plan = compileReply({ default: 'auto', byScope: { group: 'tool' } })
    expect(plan.modeFor(facts({ source: { ...facts().source, scope: 'group' } }))).toBe('tool')
    expect(plan.modeFor(facts())).toBe('auto')
    expect(plan.possibleTool).toBe(true)
  })

  test('an empty when matches everything', () => {
    const plan = compileReply({ rules: [{ when: {}, mode: 'tool' }] })
    expect(plan.modeFor(facts())).toBe('tool')
  })

  test('any is an OR and not inverts', () => {
    const plan = compileReply({
      rules: [
        {
          when: {
            any: [{ source: { scope: 'c2c' } }, { any: [{ source: { scope: 'group' } }] }],
          },
          mode: 'tool',
        },
        { when: { not: { author: { kind: 'person' } } }, mode: 'auto' },
      ],
    })
    expect(plan.modeFor(facts({ source: { ...facts().source, scope: 'c2c' } }))).toBe('tool')
    expect(plan.modeFor(facts({ source: { ...facts().source, scope: 'group' } }))).toBe('tool')
    expect(plan.modeFor(facts({ source: { ...facts().source, scope: 'p2p' } }))).toBe('auto')
  })

  test('when fields combine with AND', () => {
    const plan = compileReply({
      rules: [{ when: { source: { kind: 'p2p' }, body: { text: { words: ['ping'] } } }, mode: 'tool' }],
    })
    expect(plan.modeFor(facts({ body: { text: 'ping now', media: [] } }))).toBe('tool')
    expect(plan.modeFor(facts({ body: { text: 'pong', media: [] } }))).toBe('auto')
  })

  test('body media distinguishes any from none', () => {
    const withMedia = facts({ body: { text: 'x', media: [{ type: 'image', url: 'u', handle: null, owner: { kind: 'p2p', instance: 'inst-a' } }] } })
    const anyPlan = compileReply({ rules: [{ when: { body: { media: 'any' } }, mode: 'tool' }] })
    const nonePlan = compileReply({ rules: [{ when: { body: { media: 'none' } }, mode: 'tool' }] })
    expect(anyPlan.modeFor(withMedia)).toBe('tool')
    expect(nonePlan.modeFor(withMedia)).toBe('auto')
  })

  test('deciding is pure: same input, same answer, and inputs are not written', () => {
    const plan = compileReply({ rules: [{ when: { source: { kind: 'p2p' } }, mode: 'tool' }] })
    const input = facts()
    const frozen = JSON.stringify(input)
    expect(plan.modeFor(input)).toBe('tool')
    expect(plan.modeFor(input)).toBe('tool')
    expect(JSON.stringify(input)).toBe(frozen)
  })
})
