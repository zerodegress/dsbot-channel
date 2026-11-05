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
import type { JudgeQuestion } from './judge-question.js'
import type { PipelineEvent } from './pipeline.js'

export const name = 'dsbot-channel/system-one'

export const inject = ['credentials'] as const

export interface SystemOneConfig {
  credential: string
  baseUrl: string
  model: string
  maxChars?: number
}

/** The provider reads connection settings only; each judge node names what to ask. */
export const Config = Schema.object({
  credential: Schema.string().required(),
  baseUrl: Schema.string().required(),
  model: Schema.string().required(),
  maxChars: Schema.number().default(2000),
})

function pickAnswer(response: unknown): Record<string, unknown> {
  const body = record(response)
  if (body === undefined) throw new Error('the judge answered without an object')
  for (const key of ['answers', 'results'] as const) {
    const one = record(record(body[key])?.judge)
    if (one !== undefined) return one
  }
  const direct = record(body.judge)
  return direct ?? body
}

function scaled(raw: number, min: number | undefined, max: number | undefined): number {
  if (min === undefined || max === undefined) {
    throw new Error('the judge answered with a raw score and the node set no question.min and question.max')
  }
  if (max === min) throw new Error('the judge cannot scale a score when question.min equals question.max')
  const value = (raw - min) / (max - min)
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function scoreFor(question: JudgeQuestion, answer: Record<string, unknown>): number {
  if (question.type === 'noul') return scoreOf(answer.noul)
  if (question.type === 'score') {
    const raw = answer.score
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('judge answer carried no usable score')
    if (raw >= 0 && raw <= 1) return raw
    return scaled(raw, question.min, question.max)
  }
  const probabilities = answer.probabilities
  const index = (question.options ?? []).indexOf(question.target ?? '')
  if (Array.isArray(probabilities)) return scoreOf(probabilities[index])
  const byOption = record(probabilities)
  if (byOption !== undefined) {
    if (typeof byOption[String(index)] === 'number') return scoreOf(byOption[String(index)])
    if (question.target !== undefined && question.target in byOption) return scoreOf(byOption[question.target])
  }
  throw new Error('judge answer carried no probability for the target option')
}

/** The one question a node asks, in the shape the systemone request takes. */
export function askedOf(question: JudgeQuestion): Record<string, unknown> {
  const head = { type: question.type, instructions: question.instructions }
  if (question.type === 'noul') return { ...head, criteria: question.criteria }
  if (question.type === 'score') return { ...head, criteria: question.criteria }
  return { ...head, options: question.options }
}

export function apply(ctx: Context, config: SystemOneConfig): void {
  const credential = checkText(config.credential, 'judge.credential')
  const baseUrl = checkBaseUrl(checkText(config.baseUrl, 'judge.baseUrl'), 'judge')
  const model = checkText(config.model, 'judge.model')
  const maxChars = checkWhole(config.maxChars, 'judge.maxChars', 2000)
  const token = credentialOf(ctx, credential)
  provideJudge(ctx, name, async (event: PipelineEvent, node): Promise<JudgeVerdictLike> => {
    const question = node.question
    if (question === undefined) throw new Error('the judge node names no question')
    const response = await sendJson(baseUrl, {
      model,
      state: {
        scope: event.scope,
        author: event.authorId ?? 'unknown',
        mentioned: event.mentioned.self || event.mentioned.all,
        text: truncate(event.text, maxChars),
        ...(node.judgeContext === undefined ? {} : { context: node.judgeContext }),
      },
      questions: { judge: askedOf(question) },
    }, await token())
    const answer = pickAnswer(response)
    const score = scoreFor(question, answer)
    const confidence =
      typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : undefined
    const reason = `system-one ${question.type} score=${score}${confidence === undefined ? '' : ` confidence=${confidence}`}`
    return { score, reason: reasonOf(reason) }
  }, { needsQuestion: true, maxChars })
}

const FIELDS = new Set(['credential', 'baseUrl', 'model', 'maxChars'])

/** Refuses a key this provider never reads, so a typo cannot look configured. */
export function checkFields(config: SystemOneConfig): void {
  for (const key of Object.keys(config)) {
    if (!FIELDS.has(key)) throw new Error(`judge names a field this provider does not read: ${key}`)
  }
}

const plugin = { name, inject, Config, apply }

export default plugin
