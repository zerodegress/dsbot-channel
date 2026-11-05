import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { JudgeVerdictLike } from './judge-providers.js'
import {
  checkBaseUrl,
  checkText,
  checkWhole,
  credentialOf,
  provideJudge,
  reasonOf,
  record,
  scoreOf,
  sendJson,
  truncate,
} from './judge-providers.js'
import type { PipelineEvent } from './pipeline.js'

export const name = 'dsbot-channel/llm'

export const inject = ['credentials'] as const

export interface LlmConfig {
  credential: string
  baseUrl: string
  model: string
  maxChars?: number
}

/** One model, one prompt, no history and no tools. */
export const Config = Schema.object({
  credential: Schema.string().required(),
  baseUrl: Schema.string().required(),
  model: Schema.string().required(),
  maxChars: Schema.number().default(6000),
})

export const VERDICT_PROMPT =
  'Judge one chat message. Reply with only a JSON object: {"score": <number from 0 to 1>, "reason": "<short reason>"}. ' +
  'No markdown, no code fences, no extra text.'

/** What the model sees: the message, where it came from, and whether the bot was named. */
export function renderMessage(event: PipelineEvent, maxChars: number): string {
  return [
    `scope: ${event.scope}`,
    `mentioned: ${event.mentioned.self || event.mentioned.all ? 'yes' : 'no'}`,
    `peer: ${event.peer ?? 'unknown'}`,
    'message:',
    truncate(event.text, maxChars),
  ].join('\n')
}

/** A bare JSON object with a usable score; anything else is a refusal the pipeline reports as judge_failed. */
export function parseVerdict(content: string): JudgeVerdictLike {
  const text = content.trim()
  if (text.startsWith('```') || text.endsWith('```')) throw new Error('the judge answered with markdown')
  let parsed: unknown
  try {
    parsed = JSON.parse(text) as unknown
  } catch {
    throw new Error('the judge answered without json')
  }
  const body = record(parsed)
  if (body === undefined) throw new Error('the judge answered without an object')
  const score = scoreOf(body.score)
  const reason = typeof body.reason === 'string' && body.reason.trim().length > 0 ? reasonOf(body.reason.trim()) : undefined
  return { score, ...(reason === undefined ? {} : { reason }) }
}

const FIELDS = new Set(['credential', 'baseUrl', 'model', 'maxChars'])

/** Refuses a key this provider never reads, so a typo cannot look configured. */
export function checkFields(config: LlmConfig): void {
  for (const key of Object.keys(config)) {
    if (!FIELDS.has(key)) throw new Error(`judge names a field this provider does not read: ${key}`)
  }
}

export function apply(ctx: Context, config: LlmConfig): void {
  checkFields(config)
  const credential = checkText(config.credential, 'judge.credential')
  const baseUrl = checkBaseUrl(checkText(config.baseUrl, 'judge.baseUrl'), 'judge')
  const model = checkText(config.model, 'judge.model')
  const maxChars = checkWhole(config.maxChars, 'judge.maxChars', 6000)
  const token = credentialOf(ctx, credential)
  provideJudge(ctx, name, async (event: PipelineEvent): Promise<JudgeVerdictLike> => {
    const response = await sendJson(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: VERDICT_PROMPT },
          { role: 'user', content: renderMessage(event, maxChars) },
        ],
      },
      await token(),
    )
    const choices = record(response)?.choices
    if (!Array.isArray(choices) || choices.length === 0) throw new Error('the judge answered without choices')
    const content = record(record(choices[0])?.message)?.content
    if (typeof content !== 'string') throw new Error('the judge answered without text')
    return parseVerdict(content)
  })
}

const plugin = { name, inject, Config, apply }

export default plugin
