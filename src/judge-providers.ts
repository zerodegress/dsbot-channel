import type { Context } from '@deepseek-ai/cordis'
import type { NodeContext, PipelineEvent } from './pipeline.js'

/** The one host service a judge provider fills; core reads it under this name. */
export const JUDGE_SERVICE = 'dsbot-channel/judge'

export interface JudgeVerdictLike {
  score: number
  reason?: string
}

export type JudgeFn = (event: PipelineEvent, context: NodeContext) => Promise<JudgeVerdictLike>

/** A readable line about a decision, bounded and free of credentials. */
export const REASON_MAX = 200

export function reasonOf(text: string): string {
  return Array.from(text).slice(0, REASON_MAX).join('')
}

/** Refuses an endpoint that is not an absolute http(s) address. */
export function checkBaseUrl(baseUrl: string, where: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error(`${where}.baseUrl must be an absolute http(s) address`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${where}.baseUrl must be an absolute http(s) address`)
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`
}

export function checkText(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${where} must be a non-empty string`)
  }
  return value
}

export function checkWhole(value: unknown, where: string, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`${where} must be a whole number of at least 1`)
  }
  return value
}

/** The body a judge sees, cut to what the profile allows. */
export function truncate(text: string, max: number): string {
  return Array.from(text).slice(0, max).join('')
}

/** What every provider sends: the body, its scope, its author and whether the bot was named. */
export function renderInput(event: PipelineEvent, maxChars: number): string {
  return [
    `scope: ${event.scope}`,
    `author: ${event.authorId ?? 'unknown'}`,
    `mentioned: ${event.mentioned.self || event.mentioned.all ? 'yes' : 'no'}`,
    'message:',
    truncate(event.text, maxChars),
  ].join('\n')
}

/** A score core can use, or a refusal the pipeline reports as judge_failed. */
export function scoreOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('judge answer carried no usable score')
  }
  return value
}

/** What core has to know about a provider to check the nodes a profile declares. */
export interface JudgeServiceMeta {
  /** Whether every judge node must carry a question. */
  needsQuestion: boolean
  /** How many code points of context one node may carry, the same unit maxChars counts. */
  maxChars: number
}

/** Registers the one judge a context may hold; a second provider fails the mount. */
export function provideJudge(ctx: Context, provider: string, judge: JudgeFn, meta: JudgeServiceMeta): void {
  if (ctx.get(JUDGE_SERVICE) !== undefined) {
    throw new Error(`dsbot-channel: one judge service per instance; "${provider}" found another judge already mounted`)
  }
  ctx.provide(JUDGE_SERVICE)
  ctx.set(JUDGE_SERVICE, { judge, needsQuestion: meta.needsQuestion, maxChars: meta.maxChars })
}

/** Resolves the configured credential reference on every call, never at mount. */
export function credentialOf(ctx: Context, reference: string): () => Promise<string> {
  return async () => {
    const service = ctx.get('credentials') as { resolve?: (name: string) => Promise<{ value?: string } | undefined> } | undefined
    let found: { value?: string } | undefined
    try {
      found = await service?.resolve?.(reference)
    } catch {
      throw new Error(`judge credential "${reference}" could not be resolved`)
    }
    if (found?.value === undefined || found.value.length === 0) {
      throw new Error(`judge credential "${reference}" did not resolve`)
    }
    return found.value
  }
}

interface Answer {
  status: number
  text: string
}

async function once(url: string, body: unknown, token: string): Promise<Answer> {
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error('the judge could not be reached')
  }
  return { status: response.status, text: await response.text() }
}

/** Posts once, repeats once on overload, and answers with the parsed body. */
export async function sendJson(url: string, body: unknown, token: string): Promise<unknown> {
  let answer = await once(url, body, token)
  if (answer.status === 429 || answer.status === 529) {
    answer = await once(url, body, token)
  }
  if (answer.status < 200 || answer.status >= 300) {
    throw new Error(`the judge answered ${answer.status}`)
  }
  try {
    return JSON.parse(answer.text) as unknown
  } catch {
    throw new Error('the judge answered without json')
  }
}

export function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}
