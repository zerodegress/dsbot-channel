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

export const name = 'dsbot-channel/system-one'

export const inject = ['credentials'] as const

export interface SystemOneQuestion {
  type: 'noul' | 'score' | 'choice'
  instructions: string
  /** noul: `{ true, false }`; score: an ordered array of 2 to 10 levels. */
  criteria?: unknown
  options?: string[]
  target?: string
  min?: number
  max?: number
}

export interface SystemOneConfig {
  credential: string
  baseUrl: string
  model: string
  maxChars?: number
  question: SystemOneQuestion
}

/** The one question a profile asks; every field is read once, at mount. */
export const Config = Schema.object({
  credential: Schema.string().required(),
  baseUrl: Schema.string().required(),
  model: Schema.string().required(),
  maxChars: Schema.number().default(2000),
  question: Schema.object({
    type: Schema.string().required(),
    instructions: Schema.string().required(),
    criteria: Schema.any(),
    options: Schema.array(Schema.string()),
    target: Schema.string(),
    min: Schema.number(),
    max: Schema.number(),
  }).required(),
})

type Question =
  | { type: 'noul'; instructions: string; criteria: { true: string; false: string } }
  | { type: 'score'; instructions: string; criteria: string[]; min?: number; max?: number }
  | { type: 'choice'; instructions: string; options: string[]; target: string }

function finiteOrUndefined(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('question.min and question.max must be finite numbers')
  return value
}

export function readQuestion(raw: SystemOneQuestion): Question {
  const type = raw.type
  if (type !== 'noul' && type !== 'score' && type !== 'choice') {
    throw new Error('judge.question.type must be noul, score or choice')
  }
  const instructions = checkText(raw.instructions, 'judge.question.instructions')
  if (type === 'noul') {
    const criteria = record(raw.criteria)
    if (criteria === undefined || typeof criteria.true !== 'string' || typeof criteria.false !== 'string') {
      throw new Error('judge.question.criteria for noul must name true and false')
    }
    return { type, instructions, criteria: { true: criteria.true, false: criteria.false } }
  }
  if (type === 'score') {
    if (!Array.isArray(raw.criteria) || raw.criteria.length < 2 || raw.criteria.length > 10) {
      throw new Error('judge.question.criteria for score must list 2 to 10 levels, low to high')
    }
    const criteria = raw.criteria.map((one) => checkText(one, 'judge.question.criteria[]'))
    const min = finiteOrUndefined(raw.min)
    const max = finiteOrUndefined(raw.max)
    return {
      type,
      instructions,
      criteria,
      ...(min === undefined ? {} : { min }),
      ...(max === undefined ? {} : { max }),
    }
  }
  if (!Array.isArray(raw.options) || raw.options.length < 2) {
    throw new Error('judge.question.options for choice must list at least two options')
  }
  const options = raw.options.map((one) => checkText(one, 'judge.question.options[]'))
  const target = checkText(raw.target, 'judge.question.target')
  if (!options.includes(target)) throw new Error('judge.question.target must be one of judge.question.options')
  return { type, instructions, options, target }
}

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
    throw new Error('the judge answered with a raw score and the profile set no question.min and question.max')
  }
  if (max === min) throw new Error('the judge cannot scale a score when question.min equals question.max')
  const value = (raw - min) / (max - min)
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function scoreFor(question: Question, answer: Record<string, unknown>): number {
  if (question.type === 'noul') return scoreOf(answer.noul)
  if (question.type === 'score') {
    const raw = answer.score
    if (typeof raw !== 'number' || !Number.isFinite(raw)) throw new Error('judge answer carried no usable score')
    if (raw >= 0 && raw <= 1) return raw
    return scaled(raw, question.min, question.max)
  }
  const probabilities = answer.probabilities
  if (Array.isArray(probabilities)) return scoreOf(probabilities[question.options.indexOf(question.target)])
  const byOption = record(probabilities)
  if (byOption !== undefined && question.target in byOption) return scoreOf(byOption[question.target])
  throw new Error('judge answer carried no probability for the target option')
}

export function apply(ctx: Context, config: SystemOneConfig): void {
  const credential = checkText(config.credential, 'judge.credential')
  const baseUrl = checkBaseUrl(checkText(config.baseUrl, 'judge.baseUrl'), 'judge')
  const model = checkText(config.model, 'judge.model')
  const maxChars = checkWhole(config.maxChars, 'judge.maxChars', 2000)
  const question = readQuestion(config.question)
  const token = credentialOf(ctx, credential)
  provideJudge(ctx, name, async (event: PipelineEvent): Promise<JudgeVerdictLike> => {
    const asked =
      question.type === 'noul'
        ? { type: question.type, instructions: question.instructions, criteria: question.criteria }
        : question.type === 'score'
          ? { type: question.type, instructions: question.instructions, criteria: question.criteria }
          : { type: question.type, instructions: question.instructions, options: question.options }
    const response = await sendJson(baseUrl, {
      model,
      state: truncate(event.text, maxChars),
      questions: { judge: asked },
    }, await token())
    const answer = pickAnswer(response)
    const score = scoreFor(question, answer)
    const confidence =
      typeof answer.confidence === 'number' && Number.isFinite(answer.confidence) ? answer.confidence : undefined
    const reason = `system-one ${question.type} score=${score}${confidence === undefined ? '' : ` confidence=${confidence}`}`
    return { score, reason: reasonOf(reason) }
  })
}

const plugin = { name, inject, Config, apply }

export default plugin
