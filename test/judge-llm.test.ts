import { afterEach, describe, expect, test } from 'vitest'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Context } from '@deepseek-ai/cordis'
import llm from '../src/llm.js'
import type { PipelineEvent } from '../src/pipeline.js'

const REF = '{{SECRET_llm_judge}}'
const SECRET = 'llm-secret-value'

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
  await ctx.plugin(llm as never, config as never)
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

function config(url: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { credential: REF, baseUrl: url, model: 'vendor/model', ...extra }
}

function answer(content: string): { status: number; payload: unknown } {
  return { status: 200, payload: { choices: [{ message: { content } }] } }
}

const opened: (() => Promise<void>)[] = []
afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.()
})

describe('the llm provider', () => {
  test('sends one system prompt and one message, and reads a bare json verdict', async () => {
    const server = await stub(() => answer('{"score": 0.25, "reason": "not worth it"}'))
    opened.push(server.close)
    const ctx = await mount(config(server.url))

    const verdict = await judgeOf(ctx)(event())
    expect(verdict).toEqual({ score: 0.25, reason: 'not worth it' })

    const hit = server.hits[0]!
    expect(hit.url).toBe('/chat/completions')
    expect(hit.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(hit.body.model).toBe('vendor/model')
    const messages = hit.body.messages as { role: string; content: string }[]
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('system')
    expect(messages[0]!.content).toContain('JSON')
    expect(messages[1]!.role).toBe('user')
    expect(messages[1]!.content).toContain('scope: group')
    expect(messages[1]!.content).toContain('mentioned: no')
    expect(messages[1]!.content).toContain('author: 20002')
    expect(messages[1]!.content).toContain('hello there')
    expect(hit.body).not.toHaveProperty('tools')
  })

  test('refuses a fenced, malformed, nested or out of range answer', async () => {
    for (const content of [
      '```json\n{"score": 0.5}\n```',
      'not json',
      '{"verdict": {"score": 0.5}}',
      '{"score": 1.5}',
      '{"reason": "no score"}',
    ]) {
      const server = await stub(() => answer(content))
      opened.push(server.close)
      const ctx = await mount(config(server.url))
      await expect(judgeOf(ctx)(event())).rejects.toThrow()
    }
  })

  test('repeats once on overload and not on a plain refusal', async () => {
    const retried = await stub(() =>
      retried.hits.length === 1 ? { status: 429, payload: {} } : answer('{"score": 0.5}'),
    )
    opened.push(retried.close)
    await expect(judgeOf(await mount(config(retried.url)))(event())).resolves.toMatchObject({ score: 0.5 })
    expect(retried.hits).toHaveLength(2)

    const refused = await stub(() => ({ status: 400, payload: { error: 'bad request' } }))
    opened.push(refused.close)
    await expect(judgeOf(await mount(config(refused.url)))(event())).rejects.toThrow(/400/)
    expect(refused.hits).toHaveLength(1)
  })

  test('cuts the body it sends to maxChars', async () => {
    const server = await stub(() => answer('{"score": 0.5}'))
    opened.push(server.close)
    const ctx = await mount(config(server.url, { maxChars: 5 }))

    await judgeOf(ctx)(event({ text: 'abcdefgh' }))
    const messages = server.hits[0]!.body.messages as { role: string; content: string }[]
    expect(messages[1]!.content).toContain('message:\nabcde')
    expect(messages[1]!.content).not.toContain('abcdefgh')
  })

  test('refuses to mount when another judge already answers', async () => {
    const server = await stub(() => answer('{"score": 0.5}'))
    opened.push(server.close)
    const ctx = await mount(config(server.url))
    await expect(ctx.plugin(llm as never, config(server.url) as never)).rejects.toThrow(/one judge service/)
  })

  test('checks its own configuration at mount', async () => {
    await expect(mount({ ...config('http://127.0.0.1:1'), baseUrl: 'ftp://x' })).rejects.toThrow(/baseUrl/)
    await expect(mount({ ...config('http://127.0.0.1:1'), credential: '' })).rejects.toThrow(/credential/)
    await expect(mount({ ...config('http://127.0.0.1:1'), surprise: true })).rejects.toThrow(/does not read/)
  })
})
