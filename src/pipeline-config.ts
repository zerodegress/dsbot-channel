import type { NodeType, SkipTarget } from './pipeline.js'
import type { JudgeContext, JudgeQuestion } from './judge-question.js'
import { matchProblems } from './match-spec.js'
import type { MatchSpec } from './match-spec.js'
import { questionProblems } from './judge-question.js'
import { DEFAULT_MAX_TURN_MS, NODE_TYPES, SKIP_TARGETS } from './pipeline.js'

export interface PipelineNodeSpec {
  id: string
  type: NodeType
  restrictSkip?: readonly SkipTarget[]
  mayRestrict?: boolean
  /** A judge at or above this score allows the message, below it denies; absent keeps it a scorer. */
  allowAtLeast?: number
  /** What this judge node asks; the provider no longer carries one. */
  question?: JudgeQuestion
  /** Static material for this judge node; never conversation history. */
  context?: JudgeContext
  /** A chance node: the probability its outcome fires, 0 to 1. */
  probability?: number
  /** A `when` node's condition, or the guard a `chance` node rolls behind. */
  test?: MatchSpec
  /** `when`: allow, deny or pass; `chance`: allow or deny. */
  outcome?: 'allow' | 'deny' | 'pass'
  /** A `chance` node: the condition it rolls behind; absent rolls always. */
  when?: MatchSpec
}

export const CHANCE_OUTCOMES = ['allow', 'deny'] as const

export interface PipelineSettings {
  maxTurnMs: number
  judgeTimeoutMs: number
  /** Points one judge verdict costs; zero turns the charge off. */
  judgePoints: number
}

export const DEFAULT_PIPELINE: PipelineSettings = { maxTurnMs: DEFAULT_MAX_TURN_MS, judgeTimeoutMs: 8_000, judgePoints: 1 }

export interface CheckReport {
  fatal: string[]
  warnings: string[]
}


/** Load time checks: illegal declarations refuse to load, odd orders only warn. */
export function checkPipeline(nodes: readonly PipelineNodeSpec[]): CheckReport {
  const fatal: string[] = []
  const warnings: string[] = []
  const index = (type: NodeType) => nodes.findIndex((node) => node.type === type)

  for (const node of nodes) {
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) {
      fatal.push(`node "${node.id}": unknown type "${node.type}"`)
      continue
    }
    if (node.restrictSkip) {
      for (const target of node.restrictSkip) {
        if (!(SKIP_TARGETS as readonly string[]).includes(target)) {
          fatal.push(`node "${node.id}": illegal skip value "${target}"`)
        }
      }
      if (node.type !== 'budget') fatal.push(`node "${node.id}": only a budget node may declare restrict`)
    }
    if (node.mayRestrict && node.type !== 'budget') {
      fatal.push(`node "${node.id}": only a budget node may return restrict`)
    }
    if (node.question !== undefined) {
      if (node.type !== 'judge') {
        fatal.push(`node "${node.id}": only a judge node may declare question`)
      } else {
        for (const problem of questionProblems(node.question)) fatal.push(`node "${node.id}": ${problem}`)
      }
    }
    if (node.context !== undefined) {
      if (node.type !== 'judge') {
        fatal.push(`node "${node.id}": only a judge node may declare context`)
      } else if (typeof node.context !== 'string') {
        const body = node.context as Record<string, unknown>
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          fatal.push(`node "${node.id}": context must be a string or a mapping of name to string`)
        } else {
          for (const [key, value] of Object.entries(body)) {
            if (key.trim().length === 0) fatal.push(`node "${node.id}": context names must not be empty`)
            if (typeof value !== 'string') fatal.push(`node "${node.id}": context.${key} must be a string`)
          }
        }
      }
    }
    if (node.type === 'chance' || node.type === 'when') {
      if (node.type === 'chance') {
        if (typeof node.probability !== 'number' || !Number.isFinite(node.probability) || node.probability < 0 || node.probability > 1) {
          fatal.push(`node "${node.id}": chance needs probability between 0 and 1`)
        }
        if (node.outcome === undefined || !(CHANCE_OUTCOMES as readonly string[]).includes(node.outcome)) {
          fatal.push(`node "${node.id}": chance needs outcome allow or deny`)
        }
        if (node.test !== undefined) fatal.push(`node "${node.id}": only a when node may declare test`)
        if (node.when !== undefined) {
          for (const problem of matchProblems(node.when)) fatal.push(`node "${node.id}": when ${problem}`)
        }
      } else {
        if (node.test === undefined) fatal.push(`node "${node.id}": when needs a test`)
        else for (const problem of matchProblems(node.test)) fatal.push(`node "${node.id}": test ${problem}`)
        if (node.outcome === undefined || !(['allow', 'deny', 'pass'] as readonly string[]).includes(node.outcome)) {
          fatal.push(`node "${node.id}": when needs outcome allow, deny or pass`)
        }
        if (node.when !== undefined) fatal.push(`node "${node.id}": only a chance node may declare when`)
        if (node.probability !== undefined) fatal.push(`node "${node.id}": only a chance node may declare probability`)
      }
    } else {
      if (node.probability !== undefined) fatal.push(`node "${node.id}": only a chance node may declare probability`)
      if (node.test !== undefined) fatal.push(`node "${node.id}": only a when node may declare test`)
      if (node.when !== undefined) fatal.push(`node "${node.id}": only a chance node may declare when`)
    }
    if (node.allowAtLeast !== undefined) {
      if (node.type !== 'judge') {
        fatal.push(`node "${node.id}": only a judge node may declare allowAtLeast`)
      } else if (
        typeof node.allowAtLeast !== 'number' ||
        !Number.isFinite(node.allowAtLeast) ||
        node.allowAtLeast < 0 ||
        node.allowAtLeast > 1
      ) {
        fatal.push(`node "${node.id}": allowAtLeast must be between 0 and 1: ${String(node.allowAtLeast)}`)
      }
    }
  }

  const budget = index('budget')
  if (budget >= 0) {
    const judge = index('judge')
    if (judge >= 0 && judge < budget) warnings.push('judge runs before budget')
    const allow = index('allow')
    if (allow >= 0 && allow < budget) warnings.push('allow runs before budget')
  }
  const deny = index('deny')
  const allow = index('allow')
  const judgeAllows = nodes.some((node) => node.type === 'judge' && node.allowAtLeast !== undefined)
  if (nodes.length > 0 && allow < 0 && !judgeAllows) {
    warnings.push('no "allow" node: every message is denied while this pipeline is attached')
  }
  if (deny >= 0 && allow >= 0 && allow < deny) warnings.push('allow runs before deny')

  const score = index('score')
  const judge = index('judge')
  if (score >= 0 && judge >= 0 && judge < score) warnings.push('judge runs before score')

  nodes.forEach((node, position) => {
    if (node.type !== 'prepare') return
    const later = nodes.slice(position + 1)
    if (later.some((item) => item.type === 'allow' || item.type === 'judge')) {
      warnings.push('prepare does not run after every allow and judge')
    }
  })

  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i]!.type === nodes[i - 1]!.type) warnings.push(`consecutive nodes of type "${nodes[i]!.type}"`)
  }

  return { fatal, warnings }
}
