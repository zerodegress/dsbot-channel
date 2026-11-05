import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import systemOne from '../src/system-one.js'
import type { SystemOneConfig, SystemOneQuestion } from '../src/system-one.js'
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

function judgeOf(ctx: Context): (event: PipelineEvent, context?: unknown) => Promise<{ score: number; reason?: string }> {
  const service = ctx.get('dsbot-channel/judge') as {
    judge: (event: PipelineEvent, context?: unknown) => Promise<{ score: number; reason?: string }>
  }
  return service.judge
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

const noul: SystemOneQuestion = {
  type: 'noul',
  instructions: 'Is it worth answering?',
  criteria: { true: 'it asks something', false: 'it is noise' },
}

function config(url: string, question: SystemOneQuestion, extra: Partial<SystemOneConfig> = {}): Record<string, unknown> {
  return { credential: REF, baseUrl: `${url}/v1/systemone`, model: 'test/model', question, ...extra }
}

const opened: (() => Promise<void>)[] = []
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.()
})

describe('the system-one provider', () => {
  test('asks one question and reads a noul probability as the score', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: 0.42, confidence: 0.9 } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url, noul))

    const verdict = await judgeOf(ctx)(event())

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

  test('reads the boundaries 0 and 1 as scores', async () => {
    for (const value of [0, 1]) {
      const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: value } } } }))
      opened.push(server.close)
      const ctx = await mount(config(server.url, noul))
      await expect(judgeOf(ctx)(event())).resolves.toMatchObject({ score: value })
    }
  })

  test('takes a normalized score as it is and scales a raw one by min and max', async () => {
    const normalized = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 0.7 } } } }))
    opened.push(normalized.close)
    const first = await mount(config(normalized.url, { type: 'score', instructions: 'how good?', criteria: ['bad', 'good'] }))
    await expect(judgeOf(first)(event())).resolves.toMatchObject({ score: 0.7 })

    const raw = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(raw.close)
    const second = await mount(
      config(raw.url, { type: 'score', instructions: 'how good?', criteria: ['bad', 'good'], min: 0, max: 10 }),
    )
    await expect(judgeOf(second)(event())).resolves.toMatchObject({ score: 0.7 })
  })

  test('refuses a raw score it cannot scale', async () => {
    const one = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(one.close)
    const noScale = await mount(config(one.url, { type: 'score', instructions: 'q', criteria: ['a', 'b'] }))
    await expect(judgeOf(noScale)(event())).rejects.toThrow(/question\.min and question\.max/)

    const flat = await stub(() => ({ status: 200, payload: { answers: { judge: { score: 7 } } } }))
    opened.push(flat.close)
    const equal = await mount(config(flat.url, { type: 'score', instructions: 'q', criteria: ['a', 'b'], min: 5, max: 5 }))
    await expect(judgeOf(equal)(event())).rejects.toThrow(/min equals question\.max/)
  })

  test('reads a choice as the probability of the target option', async () => {
    const shape = { type: 'choice' as const, instructions: 'which?', options: ['a', 'b'], target: 'b' }
    const array = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: [0.2, 0.8] } } } }))
    opened.push(array.close)
    const byArray = await mount(config(array.url, shape))
    await expect(judgeOf(byArray)(event())).resolves.toMatchObject({ score: 0.8 })

    const object = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: { a: 0.2, b: 0.8 } } } } }))
    opened.push(object.close)
    const byObject = await mount(config(object.url, shape))
    await expect(judgeOf(byObject)(event())).resolves.toMatchObject({ score: 0.8 })

    const indexed = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'b', probabilities: { '0': 0.2, '1': 0.8 } } } } }))
    opened.push(indexed.close)
    const byIndex = await mount(config(indexed.url, shape))
    await expect(judgeOf(byIndex)(event())).resolves.toMatchObject({ score: 0.8 })
  })

  test('refuses a choice without a probability for the target', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { choice: 'a', probabilities: { a: 1 } } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url, { type: 'choice', instructions: 'which?', options: ['a', 'b'], target: 'b' }))
    await expect(judgeOf(ctx)(event())).rejects.toThrow(/target option/)
  })

  test('refuses a score outside the usable range or not a number', async () => {
    for (const value of [1.2, -0.1, Number.NaN, '0.4', undefined]) {
      const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: value } } } }))
      opened.push(server.close)
      const ctx = await mount(config(server.url, noul))
      await expect(judgeOf(ctx)(event())).rejects.toThrow(/no usable score/)
    }
  })

  test('repeats once on overload and takes the second answer', async () => {
    const server = await stub(() =>
      server.hits.length === 1 ? { status: 429, payload: { error: 'slow down' } } : { status: 200, payload: { answers: { judge: { noul: 0.5 } } } },
    )
    opened.push(server.close)
    const ctx = await mount(config(server.url, noul))
    await expect(judgeOf(ctx)(event())).resolves.toMatchObject({ score: 0.5 })
    expect(server.hits).toHaveLength(2)
  })

  test('refuses when the second answer is overloaded too', async () => {
    const server = await stub(() => ({ status: 529, payload: { error: 'overloaded' } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url, noul))
    await expect(judgeOf(ctx)(event())).rejects.toThrow(/529/)
    expect(server.hits).toHaveLength(2)
  })

  test('refuses to mount when another judge already answers', async () => {
    const server = await stub(() => ({ status: 200, payload: { answers: { judge: { noul: 0.5 } } } }))
    opened.push(server.close)
    const ctx = await mount(config(server.url, noul))
    await expect(ctx.plugin(systemOne as never, config(server.url, noul) as never)).rejects.toThrow(/one judge service/)
  })

  test('checks its own configuration at mount', async () => {
    await expect(mount({ ...config('http://127.0.0.1:1', noul), baseUrl: 'not-a-url' })).rejects.toThrow(/baseUrl/)
    await expect(mount({ ...config('http://127.0.0.1:1', noul), model: '' })).rejects.toThrow(/model/)
    await expect(mount(config('http://127.0.0.1:1', { ...noul, type: 'rating' as never }))).rejects.toThrow(/type/)
    await expect(
      mount(config('http://127.0.0.1:1', { type: 'choice', instructions: 'q', options: ['a', 'b'], target: 'c' })),
    ).rejects.toThrow(/target/)
    await expect(mount({ ...config('http://127.0.0.1:1', noul), surprise: true })).rejects.toThrow(/does not read/)
    await expect(
      mount(config('http://127.0.0.1:1', { ...noul, surprise: true } as never)),
    ).rejects.toThrow(/does not read/)
  })
})
