import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { checkPipeline } from '../src/pipeline-config.js'
import { buildPipeline } from '../src/build-pipeline.js'
import { registryPlugin } from '../src/registry-plugin.js'
import entry from '../src/index.js'
import systemOne from '../src/system-one.js'
import llm from '../src/llm.js'
import type { PipelineEvent } from '../src/pipeline.js'

const REF = '{{SECRET_judge_question}}'
const question = {
  type: 'noul',
  instructions: 'Is it spam?',
  criteria: { true: 'it is spam', false: 'it is not' },
}
const event: PipelineEvent = {
  eventKey: 'e1',
  scope: 'group',
  mentioned: { self: false, others: false, all: false },
  text: 'hello',
  authorId: '20002',
}

function services(ctx: Context): void {
  void ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', { resolve: (reference: string) => Promise.resolve(reference === REF ? { value: 'secret' } : undefined) })
      scope.provide('sessionController')
      scope.set('sessionController', { create: () => Promise.resolve({ sessionId: 's' }), prompt: () => Promise.resolve({ accepted: true }) })
    },
  })
}

async function mount(pipeline: Record<string, unknown>, provider: unknown, providerConfig: Record<string, unknown>): Promise<void> {
  const ctx = new Context()
  services(ctx)
  await ctx.plugin(registryPlugin)
  await ctx.plugin(provider as never, providerConfig as never)
  await ctx.plugin(entry, { pipeline, adapters: [] })
}

const one = { credential: REF, baseUrl: 'http://127.0.0.1:1', model: 'test/model' }

describe('a judge node carries what to ask', () => {
  test('question and context belong to the node', () => {
    expect(checkPipeline([{ id: 'j', type: 'judge', question, context: 'be strict' } as never]).fatal).toEqual([])
  })

  test('no other node type takes them', () => {
    expect(checkPipeline([{ id: 'd', type: 'deny', question } as never]).fatal).toHaveLength(1)
    expect(checkPipeline([{ id: 'd', type: 'deny', context: 'x' } as never]).fatal).toHaveLength(1)
  })

  test('a malformed question is refused', () => {
    expect(checkPipeline([{ id: 'j', type: 'judge', question: { type: 'rating', instructions: 'x' } } as never]).fatal.length).toBeGreaterThan(0)
    expect(
      checkPipeline([{ id: 'j', type: 'judge', question: { type: 'choice', instructions: 'x', options: ['a'], target: 'b' } } as never]).fatal.length,
    ).toBeGreaterThan(0)
  })

  test('a context that is not text or a text map is refused', () => {
    expect(checkPipeline([{ id: 'j', type: 'judge', question, context: 42 } as never]).fatal.length).toBeGreaterThan(0)
    expect(checkPipeline([{ id: 'j', type: 'judge', question, context: { a: 1 } } as never]).fatal.length).toBeGreaterThan(0)
  })

  test('the pipeline hands both to the judge', async () => {
    const seen: { question?: unknown; context?: unknown }[] = []
    const pipeline = buildPipeline([{ id: 'j', type: 'judge', question, context: 'be strict' } as never, { id: 'a', type: 'allow' }], {
      judge: async (_event, context) => {
        seen.push({ question: (context as { question?: unknown }).question, context: (context as { judgeContext?: unknown }).judgeContext })
        return { score: 0.8 }
      },
    })
    await pipeline.run(event)
    expect(seen[0]?.question).toEqual(question)
    expect(seen[0]?.context).toEqual('be strict')
  })
})

describe('the provider reads the node, not its own block', () => {
  test('a system-one provider needs no question of its own', async () => {
    await expect(mount({ global: [{ id: 'j', type: 'judge', question, context: 'be strict' }] }, systemOne, one)).resolves.toBeUndefined()
  })

  test('a system-one node without a question fails the mount', async () => {
    await expect(mount({ global: [{ id: 'j', type: 'judge' }] }, systemOne, one)).rejects.toThrow(/question/)
  })

  test('an llm node with a question fails the mount', async () => {
    await expect(mount({ global: [{ id: 'j', type: 'judge', question }] }, llm, one)).rejects.toThrow(/question/)
  })

  test('a context longer than the provider reads fails the mount', async () => {
    await expect(
      mount({ global: [{ id: 'j', type: 'judge', question, context: 'x'.repeat(2001) }] }, systemOne, { ...one, maxChars: 2000 }),
    ).rejects.toThrow(/context/)
  })
})
