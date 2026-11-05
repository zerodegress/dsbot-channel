/** What one judge node asks, in the provider's own vocabulary. */
export const JUDGE_QUESTION_TYPES = ['noul', 'score', 'choice'] as const
export type JudgeQuestionType = (typeof JUDGE_QUESTION_TYPES)[number]

export interface JudgeQuestion {
  type: JudgeQuestionType
  instructions: string
  /** noul: `{ true, false }`; score: an ordered array of 2 to 10 levels. */
  criteria?: string[] | { true: string; false: string } | undefined
  options?: string[] | undefined
  target?: string | undefined
  min?: number | undefined
  max?: number | undefined
}

/** Static material a profile hands to a judge: one text, or named texts. Never conversation history. */
export type JudgeContext = string | Readonly<Record<string, string>>

function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** Every problem a node question has; empty when it can be asked. */
export function questionProblems(raw: unknown): string[] {
  const body = record(raw)
  if (body === undefined) return ['question must be an object']
  const problems: string[] = []
  const type = body.type
  if (typeof type !== 'string' || !(JUDGE_QUESTION_TYPES as readonly string[]).includes(type)) {
    problems.push(`question.type must be one of ${JUDGE_QUESTION_TYPES.join(', ')}`)
    return problems
  }
  if (!text(body.instructions)) problems.push('question.instructions must be a non-empty string')
  if (type === 'noul') {
    const criteria = record(body.criteria)
    if (criteria === undefined || !text(criteria.true) || !text(criteria.false)) {
      problems.push('question.criteria for noul must name true and false')
    }
  }
  if (type === 'score') {
    const criteria = body.criteria
    if (!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10 || !criteria.every(text)) {
      problems.push('question.criteria for score must list 2 to 10 non-empty levels, low to high')
    }
    for (const field of ['min', 'max'] as const) {
      const value = body[field]
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
        problems.push(`question.${field} must be a finite number`)
      }
    }
  }
  if (type === 'choice') {
    const options = body.options
    if (!Array.isArray(options) || options.length < 2 || !options.every(text)) {
      problems.push('question.options for choice must list at least two non-empty options')
    } else if (!text(body.target)) {
      problems.push('question.target must name one of question.options')
    } else if (!options.includes(body.target)) {
      problems.push('question.target must name one of question.options')
    }
  }
  return problems
}

/** Code points the context costs, the same unit maxChars counts. */
export function contextSize(context: JudgeContext): number {
  if (typeof context === 'string') return Array.from(context).length
  let total = 0
  for (const [key, value] of Object.entries(context)) total += Array.from(key).length + Array.from(value).length
  return total
}

/** Every problem a node context has, within the size the provider reads. */
export function contextProblems(raw: unknown, maxChars: number): string[] {
  if (typeof raw === 'string') {
    if (raw.trim().length === 0) return ['context must not be empty']
    return Array.from(raw).length > maxChars ? [`context must fit in ${maxChars} code points`] : []
  }
  const body = record(raw)
  if (body === undefined) return ['context must be a string or a mapping of name to string']
  const problems: string[] = []
  for (const [key, value] of Object.entries(body)) {
    if (key.trim().length === 0) problems.push('context names must not be empty')
    if (typeof value !== 'string' || value.trim().length === 0) problems.push(`context.${key} must be a non-empty string`)
  }
  if (problems.length === 0 && contextSize(body as Record<string, string>) > maxChars) {
    problems.push(`context must fit in ${maxChars} code points`)
  }
  return problems
}
