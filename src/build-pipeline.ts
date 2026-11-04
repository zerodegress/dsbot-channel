import type { LimitLevel } from './budget-ledger.js'
import { Pipeline } from './pipeline.js'
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
}

export interface PipelineDeps {
  denyRules?: readonly MatchRule[] | undefined
  allowRules?: readonly MatchRule[] | undefined
  score?: ((context: NodeContext) => number) | undefined
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
        return { id: spec.id, type: 'score', run: (context) => ({ kind: 'score', value: scorer(context) }) }
      }
      case 'judge': {
        const judge = require(spec.id, 'judge', 'judge', deps.judge)
        const threshold = spec.allowAtLeast
        return {
          id: spec.id,
          type: 'judge',
          run: async (context) => {
            const verdict = await judge(context.event, context)
            if (threshold !== undefined) {
              if (verdict.score >= threshold) {
                return { kind: 'allow', reason: verdict.reason ?? 'judge_above_threshold' }
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
        return {
          id: spec.id,
          type: 'budget',
          run: () => {
            const verdict = budget()
            if (verdict.state === 'hard') return { kind: 'deny', reason: `hard limit: ${verdict.triggeredBy.join(', ')}` }
            return { kind: 'pass' }
          },
        }
      }
      default:
        throw new BuildError(spec.id, String(spec.type))
    }
  })
  return new Pipeline(nodes, options)
}
