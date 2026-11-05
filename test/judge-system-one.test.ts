import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import systemOne, { checkFields } from '../src/system-one.js'
import type { JudgeQuestion } from '../src/judge-question.js'
import type { PipelineEvent } from '../src/pipeline.js'

const REF = '{{SECRET_judge}}'
const SECRET = 'judge-secret-value'

interface Hit {
  body: Record<string, unknown>
  headers: IncomingHttpHeaders
  url: string
}

async function stub(answer: (hit: Hit) => { status: number; payload: unknown }): Promise<{
  url: string
  hits: Hit[]
  close: () => Promise<void>
}> {
  const hits: Hit[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk: string) => {
      raw += chunk
    })
    request.on('end', () => {
      const hit = {
        body: raw.length === 0 ? {} : (JSON.parse(raw) as Record<string, unknown>),
        headers: request.headers,
        url: request.url ?? '',
      }
      hits.push(hit)
      const result = answer(hit)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(result.payload))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function mount(config: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({
    name: 'judge-credentials',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', {
        resolve: (reference: string) => Promise.resolve(reference === REF ? { value: SECRET } : undefined),
      })
    },
  })
  await ctx.plugin(systemOne as never, config as never)
  return ctx
}

function judgeOf(
  ctx: Context,
  question?: JudgeQuestion,
  judgeContext?: unknown,
): (event: PipelineEvent) => Promise<{ score: number; reason?: string }> {
  const service = ctx.get('dsbot-channel/judge') as {
    judge: (event: PipelineEvent, context: unknown) => Promise<{ score: number; reason?: string }>
  }
  return (event) => service.judge(event, { ...(question === undefined ? {} : { question }), ...(judgeContext === undefined ? {} : { judgeContext }) })
}

function event(overrides: Partial<PipelineEvent> = {}): PipelineEvent {
  return {
    eventKey: 'e1',
    scope: 'group',
    mentioned: { self: false, others: false, all: false },
    text: 'hello there',
    peer: 'peer-a',
    authorId: '20002',
    ...overrides,
  }
}

const noul: JudgeQuestion = {
  type: 'noul',
  instructions: 'Is it worth answering?',
  criteria: { true: 'it asks something', false: 'it is noise' },
}
const score: JudgeQuestion = { type: 'score', instructions: 'how good?', criteria: ['bad', 'good'] }
const choice: JudgeQuestion = { type: 'choice', instructions: 'which?', options: ['a', 'b'], target: 'b' }

function config(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { credential: REF, baseUrl: `${url}/v1/systemone`, model: 'test/model', ...extra }
}

const opened: (() => Promise<void>)[] = []
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.()
})

describe('the system-one provider', () => {
  test('asks the question the node carries and reads a noul probability as the score', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: 0.42, confidence: 0.9 } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url))

    const verdict = await judgeOf(ctx, noul)(event())

    expect(verdict.score).toBe(0.42)
    expect(verdict.reason).toContain('confidence=0.9')
    expect(server.hits).toHaveLength(1)
    expect(server.hits[0]!.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(server.hits[0]!.url).toBe('/v1/systemone')
    const body = server.hits[0]!.body
    expect(body.model).toBe('test/model')
    expect(body.state).toEqual({ scope: 'group', author: '20002', mentioned: false, text: 'hello there' })
    expect(body.questions).toEqual({
      judge: { type: 'noul', instructions: 'Is it worth answering?', criteria: { true: 'it asks something', false: 'it is noise' } },
    })
  })

  test('puts the node context into the request state', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: 0.5 } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url))

    await judgeOf(ctx, noul, { tone: 'be strict' })(event())
    expect((server.hits[0]!.body.state as Record<string, unknown>).context).toEqual({ tone: 'be strict' })
  })

  test('reads the boundaries 0 and 1 as scores', async () => {
    for (const value of [0, 1]) {
      const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: value } } } }))
      opened.push(server.close)
      const ctx = await mount(config(server.url))
      await expect(judgeOf(ctx, noul)(event())).resolves.toMatchObject({ score: value })
    }
  })

  test('takes a normalized score as it is and scales a raw one by min and max', async () => {
    const normalized = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 0.7 } } } }))
    opened.push(normalized.close)
    const first = await mount(config(normalized.url))
    await expect(judgeOf(first, score)(event())).resolves.toMatchObject({ score: 0.7 })

    const raw = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(raw.close)
    const second = await mount(config(raw.url))
    await expect(judgeOf(second, { ...score, min: 0, max: 10 })(event())).resolves.toMatchObject({ score: 0.7 })
  })

  test('refuses a raw score it cannot scale', async () => {
    const one = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(one.close)
    const noScale = await mount(config(one.url))
    await expect(judgeOf(noScale, score)(event())).rejects.toThrow(/question\.min and question\.max/)

    const flat = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(flat.close)
    const equal = await mount(config(flat.url))
    await expect(judgeOf(equal, { ...score, min: 5, max: 5 })(event())).rejects.toThrow(/min equals question\.max/)
  })

  test('reads a choice as the probability of the target option', async () => {
    const array = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: [0.2, 0.8] } } } }))
    opened.push(array.close)
    const byArray = await mount(config(array.url))
    await expect(judgeOf(byArray, choice)(event())).resolves.toMatchObject({ score: 0.8 })

    const object = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: { a: 0.2, b: 0.8 } } } } }))
    opened.push(object.close)
    const byObject = await mount(config(object.url))
    await expect(judgeOf(byObject, choice)(event())).resolves.toMatchObject({ score: 0.8 })

    const indexed = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: { '0': 0.2, '1': 0.8 } } } } }))
    opened.push(indexed.close)
    const byIndex = await mount(config(indexed.url))
    await expect(judgeOf(byIndex, choice)(event())).resolves.toMatchObject({ score: 0.8 })
  })

  test('refuses a choice without a probability for the target', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'a', probabilities: { a: 1 } } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url))
    await expect(judgeOf(ctx, choice)(event())).rejects.toThrow(/target option/)
  })

  test('refuses a score outside the usable range or not a number', async () => {
    for (const value of [1.2, -0.1, Number.NaN, '0.4', undefined]) {
      const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: value } } } }))
      opened.push(server.close)
      const ctx = await mount(config(server.url))
      await expect(judgeOf(ctx, noul)(event())).rejects.toThrow(/no usable score/)
    }
  })

  test('repeats once on overload and takes the second answer', async () => {
    const server = await stub(() =>
      server.hits.length === 1 ? { status: 429, payload: { error: 'slow down' } } : { status: 200, payload: { answers: { judge: { noul: 0.5 } } } },
    )
    opened.push(server.close)
    const ctx = await mount(config(server.url))
    await expect(judgeOf(ctx, noul)(event())).resolves.toMatchObject({ score: 0.5 })
    expect(server.hits).toHaveLength(2)
  })

  test('refuses when the second answer is overloaded too', async () => {
    const server = await stub(() => ({ status: 529, payload: { error: 'overloaded' } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url))
    await expect(judgeOf(ctx, noul)(event())).rejects.toThrow(/529/)
    expect(server.hits).toHaveLength(2)
  })

  test('refuses to mount when another judge already answers', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: 0.5 } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url))
    await expect(ctx.plugin(systemOne as never, config(server.url) as never)).rejects.toThrow(/one judge service/)
  })

  test('refuses a provider block that still carries a question', async () => {
    await expect(mount({ ...config('http://127.0.0.1:1'), question: noul })).rejects.toThrow(/does not read: question/)
  })

  test('checks its own configuration at mount', async () => {
    await expect(mount({ ...config('http://127.0.0.1:1'), baseUrl: 'not-a-url' })).rejects.toThrow(/baseUrl/)
    await expect(mount({ ...config('http://127.0.0.1:1'), model: '' })).rejects.toThrow(/model/)
    expect(() =>
      checkFields({ credential: REF, baseUrl: 'http://127.0.0.1:1', model: 'm', surprise: true } as never),
    ).toThrow(/does not read: surprise/)
    expect(() =>
      checkFields({ credential: REF, baseUrl: 'http://127.0.0.1:1', model: 'm', question: noul } as never),
    ).toThrow(/does not read: question/)
  })
})
