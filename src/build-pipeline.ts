import type { BudgetLedger, LimitLevel } from './budget-ledger.js'
import { Pipeline } from './pipeline.js'
import { chanceBucket, chanceHits } from './chance.js'
import { compileMatch } from './match-spec.js'
import type { NodeContext, PipelineEvent, PipelineNode, PipelineOptions } from './pipeline.js'
import { DEFAULT_PIPELINE } from './pipeline-config.js'
import type { PipelineNodeSpec } from './pipeline-config.js'

export interface MatchRule {
  id: string
  reason: string
  matches: (event: PipelineEvent, context: NodeContext) => boolean
}

export interface JudgeVerdict {
  score: number
  reason?: string
}

export interface BudgetVerdict {
  state: LimitLevel
  triggeredBy: string[]
  /** How much of the capacity the busiest window has spent, 0 to 1 and above. */
  ratio: number
  /** The soft threshold that turns a normal state into a restrict; absent leaves it off. */
  restrictAt?: number | undefined
}

/** What a budget node reads: the busiest window's share of capacity and the soft threshold, if any. */
export function budgetVerdictOf(
  ledger: BudgetLedger,
  botId: string,
  session: string,
  restrictAt?: number,
): BudgetVerdict {
  const state = ledger.peek(botId, session)
  const spent = ledger.usage(botId, session)
  const ratio = Math.max(...Object.values(spent)) / ledger.limitsView().capacity
  return {
    state: state.aggregate,
    triggeredBy: state.triggeredBy,
    ratio,
    ...(restrictAt === undefined ? {} : { restrictAt }),
  }
}

export interface PipelineDeps {
  denyRules?: readonly MatchRule[] | undefined
  allowRules?: readonly MatchRule[] | undefined
  score?: ((context: NodeContext) => number | Promise<number>) | undefined
  judge?: ((event: PipelineEvent, context: NodeContext) => Promise<JudgeVerdict>) | undefined
  prepare?: ((context: NodeContext) => void) | undefined
  budget?: (() => BudgetVerdict) | undefined
}

export class BuildError extends Error {
  readonly nodeId: string
  readonly nodeType: string
  readonly needs: string | undefined

  constructor(nodeId: string, nodeType: string, needs?: string) {
    super(
      needs === undefined
        ? `node "${nodeId}" has unsupported type "${nodeType}"`
        : `node "${nodeId}" of type "${nodeType}" needs "${needs}" in the injected dependencies`,
    )
    this.name = 'BuildError'
    this.nodeId = nodeId
    this.nodeType = nodeType
    this.needs = needs
  }
}

function require<T>(nodeId: string, nodeType: string, needs: string, value: T | undefined): T {
  if (value === undefined) throw new BuildError(nodeId, nodeType, needs)
  return value
}

/** Turns node specs into runnable nodes; every effect comes from the injected dependencies. */
export function buildPipeline(
  specs: readonly PipelineNodeSpec[],
  deps: PipelineDeps,
  options: PipelineOptions = DEFAULT_PIPELINE,
): Pipeline {
  const nodes: PipelineNode[] = specs.map((spec) => {
    switch (spec.type) {
      case 'deny': {
        const rules = require(spec.id, 'deny', 'denyRules', deps.denyRules)
        return {
          id: spec.id,
          type: 'deny',
          run: (context) => {
            const hit = rules.find((rule) => rule.matches(context.event, context))
            return hit ? { kind: 'deny', reason: hit.reason } : { kind: 'pass' }
          },
        }
      }
      case 'allow': {
        const rules = require(spec.id, 'allow', 'allowRules', deps.allowRules)
        return {
          id: spec.id,
          type: 'allow',
          run: (context) => {
            const hit = rules.find((rule) => rule.matches(context.event, context))
            return hit ? { kind: 'allow', reason: hit.reason } : { kind: 'pass' }
          },
        }
      }
      case 'score': {
        const scorer = require(spec.id, 'score', 'score', deps.score)
        return {
          id: spec.id,
          type: 'score',
          run: async (context) => {
            let value: number
            try {
              value = await scorer(context)
            } catch {
              return { kind: 'deny', reason: 'score_failed' }
            }
            if (typeof value !== 'number' || !Number.isFinite(value)) return { kind: 'deny', reason: 'score_failed' }
            return { kind: 'score', value }
          },
        }
      }
      case 'judge': {
        const judge = require(spec.id, 'judge', 'judge', deps.judge)
        const threshold = spec.allowAtLeast
        const below = spec.belowThreshold ?? 'deny'
        return {
          id: spec.id,
          type: 'judge',
          run: async (context) => {
            const verdict = await judge(context.event, {
              ...context,
              ...(spec.question === undefined ? {} : { question: spec.question }),
              ...(spec.context === undefined ? {} : { judgeContext: spec.context }),
            })
            const score = verdict.score
            if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) {
              throw new Error(`judge returned a score outside 0..1: ${String(score)}`)
            }
            if (threshold !== undefined) {
              if (verdict.score >= threshold) {
                return { kind: 'allow', reason: verdict.reason ?? 'judge_above_threshold' }
              }
              if (below === 'pass') {
                return { kind: 'score', value: verdict.score, reason: 'judge_below_threshold_pass' }
              }
              return { kind: 'deny', reason: `judge_below_threshold (score ${verdict.score})` }
            }
            return verdict.reason === undefined
              ? { kind: 'score', value: verdict.score }
              : { kind: 'score', value: verdict.score, reason: verdict.reason }
          },
        }
      }
      case 'prepare': {
        const prepare = require(spec.id, 'prepare', 'prepare', deps.prepare)
        return {
          id: spec.id,
          type: 'prepare',
          run: (context) => {
            prepare(context)
            return { kind: 'pass' }
          },
        }
      }
      case 'budget': {
        const budget = require(spec.id, 'budget', 'budget', deps.budget)
        const mayRestrict = spec.mayRestrict === true
        const skip = spec.restrictSkip ?? []
        return {
          id: spec.id,
          type: 'budget',
          run: () => {
            const verdict = budget()
            if (verdict.state === 'hard') return { kind: 'deny', reason: `hard limit: ${verdict.triggeredBy.join(', ')}` }
            if (mayRestrict && verdict.restrictAt !== undefined && verdict.ratio >= verdict.restrictAt) {
              const by = verdict.triggeredBy.length === 0 ? 'soft limit' : verdict.triggeredBy.join(', ')
              return { kind: 'restrict', skip, reason: `budget restrict: ${by}` }
            }
            return { kind: 'pass' }
          },
        }
      }
      case 'when': {
        const matches = compileMatch(spec.test ?? {})
        const outcome = spec.outcome ?? 'pass'
        return {
          id: spec.id,
          type: 'when',
          run: (context) => {
            if (!matches(context.event)) return { kind: 'pass' }
            if (outcome === 'pass') return { kind: 'pass' }
            return outcome === 'allow' ? { kind: 'allow', reason: 'when_allow' } : { kind: 'deny', reason: 'when_deny' }
          },
        }
      }
      case 'chance': {
        const probability = spec.probability ?? 0
        const outcome = spec.outcome === 'allow' ? 'allow' : 'deny'
        const guard = spec.when === undefined ? undefined : compileMatch(spec.when)
        return {
          id: spec.id,
          type: 'chance',
          run: (context) => {
            if (guard !== undefined && !guard(context.event)) return { kind: 'pass' }
            const hit = chanceHits(chanceBucket(context.event.eventKey, spec.id), probability)
            options.onChance?.(hit ? outcome : 'miss', spec.id, context.event)
            const reason = `chance_${hit ? outcome : 'miss'} (p=${probability})`
            if (!hit) return { kind: 'pass', reason }
            return outcome === 'allow' ? { kind: 'allow', reason } : { kind: 'deny', reason }
          },
        }
      }
      default:
        throw new BuildError(spec.id, String(spec.type))
    }
  })
  return new Pipeline(nodes, options)
}
