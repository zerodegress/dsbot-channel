import { describe, expect, test } from 'vitest'
import { defaultPipelineNodes } from '../src/pipeline-config.js'
import { resolveAndCheck, resolvePipeline } from '../src/pipeline-scopes.js'

const ids = (nodes: readonly { id: string }[]): string[] => nodes.map((node) => node.id)

describe('three layers decide which pipeline a session runs', () => {
  test('neither layer: the global pipeline runs as written', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes() })

    expect(ids(merged.nodes)).toEqual(['noise', 'budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
    expect(merged.fatal).toEqual([])
  })

  test('a bot layer alone lands on top of global', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { remove: ['noise'] },
    })

    expect(ids(merged.nodes)).not.toContain('noise')
    expect(ids(merged.nodes)).toContain('budget')
  })

  test('a session layer alone lands on top of global', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      session: { remove: ['score'] },
    })

    expect(ids(merged.nodes)).not.toContain('score')
  })

  test('both layers: the session sees the bot pipeline, not the global one', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { remove: ['noise'] },
      session: { remove: ['score'] },
    })

    expect(ids(merged.nodes)).toEqual(['budget', 'deny', 'allow', 'judge', 'prepare'])
  })

  test('a session that inherits global skips the bot layer', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { remove: ['noise'] },
      session: { inherit: 'global', remove: ['score'] },
    })

    expect(ids(merged.nodes)).toContain('noise')
    expect(ids(merged.nodes)).not.toContain('score')
  })
})

describe('a layer is a difference, not a replacement', () => {
  test('remove takes one node out', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes(), bot: { remove: ['judge'] } })

    expect(ids(merged.nodes)).toEqual(['noise', 'budget', 'deny', 'allow', 'score', 'prepare'])
  })

  test('insert places a node after its anchor', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'topic', type: 'deny', after: 'score' }] },
    })

    expect(ids(merged.nodes)).toEqual(['noise', 'budget', 'deny', 'allow', 'score', 'topic', 'judge', 'prepare'])
  })

  test('insert places a node before its anchor', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'topic', type: 'deny', before: 'budget' }] },
    })

    expect(ids(merged.nodes)).toEqual(['noise', 'topic', 'budget', 'deny', 'allow', 'score', 'judge', 'prepare'])
  })

  test('override changes only the fields it names', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { override: { budget: { restrictSkip: ['scoring'] } } },
    })

    const budget = merged.nodes.find((node) => node.id === 'budget')
    expect(budget?.restrictSkip).toEqual(['scoring'])
    expect(budget?.type).toBe('budget')
    expect(merged.nodes).toHaveLength(7)
  })
})

describe('the merged pipeline is checked, and the report names the layer', () => {
  test('a node inserted with an unknown type is refused', () => {
    const checked = resolveAndCheck({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'topic', type: 'nonsense', after: 'score' }] },
    })

    expect(checked.fatal).toEqual(['bot: node "topic": unknown type "nonsense"'])
  })

  test('an order the bot layer introduced is reported against the bot layer', () => {
    const checked = resolveAndCheck({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'early-allow', type: 'allow', before: 'budget' }] },
    })

    expect(checked.fatal).toEqual([])
    expect(checked.warnings).toContain('bot: allow runs before budget')
  })

  test('an order the session layer introduced is reported against the session layer', () => {
    const checked = resolveAndCheck({
      global: defaultPipelineNodes(),
      session: { insert: [{ id: 'early-allow', type: 'allow', before: 'budget' }] },
    })

    expect(checked.warnings).toContain('session: allow runs before budget')
    expect(checked.warnings.some((line) => line.startsWith('bot: '))).toBe(false)
  })

  test('a problem the global layer already had is reported once, against global', () => {
    const broken = defaultPipelineNodes()
    broken.splice(1, 0, { id: 'early-allow', type: 'allow' })

    const checked = resolveAndCheck({ global: broken, bot: { remove: ['noise'] } })

    const hits = checked.warnings.filter((line) => line.endsWith('allow runs before budget'))
    expect(hits).toEqual(['global: allow runs before budget'])
  })
})

describe('a difference that cannot be applied refuses the load', () => {
  test('inherit must name a layer that exists below it', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes(), bot: { inherit: 'session' } })

    expect(merged.fatal).toEqual(['bot: inherit must be one of global, not "session"'])
  })

  test('remove must name a node that exists', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes(), bot: { remove: ['ghost'] } })

    expect(merged.fatal).toEqual(['bot: remove names a node that does not exist: "ghost"'])
  })

  test('override must name a node that exists', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes(), bot: { override: { ghost: {} } } })

    expect(merged.fatal).toEqual(['bot: override names a node that does not exist: "ghost"'])
  })

  test('insert must not reuse an id', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'budget', type: 'budget', after: 'noise' }] },
    })

    expect(merged.fatal).toEqual(['bot: insert reuses the node id "budget"'])
  })

  test('insert must name an anchor that exists', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'topic', type: 'deny', after: 'ghost' }] },
    })

    expect(merged.fatal).toEqual(['bot: insert "topic" names an anchor that does not exist: "ghost"'])
  })

  test('insert must name exactly one anchor', () => {
    const merged = resolvePipeline({
      global: defaultPipelineNodes(),
      bot: { insert: [{ id: 'topic', type: 'deny' }] },
    })

    expect(merged.fatal).toEqual(['bot: insert "topic" must name exactly one of after or before'])
  })

  test('the session layer is checked by the same rules', () => {
    const merged = resolvePipeline({ global: defaultPipelineNodes(), session: { remove: ['ghost'] } })

    expect(merged.fatal).toEqual(['session: remove names a node that does not exist: "ghost"'])
  })
})
