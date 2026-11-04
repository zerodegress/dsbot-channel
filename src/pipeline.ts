import type { Mentioned, Scope } from './event-types.js'

export const NODE_TYPES = ['deny', 'budget', 'allow', 'score', 'judge', 'prepare'] as const
export type NodeType = (typeof NODE_TYPES)[number]

/** What a node may ask the chain to skip; no built-in node produces a restrict in this version. */
export const SKIP_TARGETS = ['scoring', 'judge'] as const
export type SkipTarget = (typeof SKIP_TARGETS)[number]

export type Decision = 'allow' | 'deny'

export interface PipelineEvent {
  eventKey: string
  scope: Scope
  mentioned: Mentioned
  /** What the rules match on; empty when the adapter carries no text. */
  text: string
  /** The identity that admitted the message, when the adapter has one. */
  peer?: string
}

export interface DenyOutput {
  kind: 'deny'
  reason: string
}

export interface AllowOutput {
  kind: 'allow'
  reason: string
}

export interface RestrictOutput {
  kind: 'restrict'
  skip: readonly SkipTarget[]
  reason: string
}

export interface ScoreOutput {
  kind: 'score'
  value: number
  reason?: string
}

export interface PassOutput {
  kind: 'pass'
}

export type NodeOutput = DenyOutput | AllowOutput | RestrictOutput | ScoreOutput | PassOutput

export interface RuntimeView {
  consumed: number
  remaining: number
  limitState: 'normal' | 'hard'
}

export interface NodeContext {
  event: PipelineEvent
  runtime: RuntimeView
  score: number
  skip: ReadonlySet<SkipTarget>
}

export interface PipelineNode {
  id: string
  type: NodeType
  run: (context: NodeContext) => NodeOutput | Promise<NodeOutput>
}

export type JudgeFailure = 'judge_timeout' | 'judge_failed'

export interface PipelineOptions {
  maxTurnMs?: number
  judgeTimeoutMs?: number
  charge?: (context: { nodeId: string; event: PipelineEvent }) => void
  /** Called once per judge that timed out or threw, before the deny it ends in. */
  onJudgeFailure?: ((code: JudgeFailure, event: PipelineEvent) => void) | undefined
}

export interface PipelineResult {
  decision: Decision
  score: number
  matched: string[]
  reasons: Record<string, string>
  restricted: boolean
  skip: ReadonlySet<SkipTarget>
  dropped?: 'timeout'
}

export const DEFAULT_MAX_TURN_MS = 120_000

class TurnTimeout extends Error {}

function assertSkip(skip: readonly string[]): asserts skip is readonly SkipTarget[] {
  for (const item of skip) {
    if (!(SKIP_TARGETS as readonly string[]).includes(item)) {
      throw new Error(`skip must be one of ${SKIP_TARGETS.join(', ')}, got "${item}"`)
    }
  }
}

/** Runs the node chain. A restrict with no earlier allow ends as deny. */
export class Pipeline {
  constructor(
    private readonly nodes: readonly PipelineNode[],
    private readonly options: PipelineOptions = {},
  ) {}

  async run(event: PipelineEvent, runtime: RuntimeView = { consumed: 0, remaining: 0, limitState: 'normal' }): Promise<PipelineResult> {
    const maxTurnMs = this.options.maxTurnMs ?? DEFAULT_MAX_TURN_MS
    let score = 0
    let restricted = false
    const skip = new Set<SkipTarget>()
    const matched: string[] = []
    const reasons: Record<string, string> = {}
    const context = (): NodeContext => ({ event, runtime, score, skip: new Set(skip) })

    for (const node of this.nodes) {
      if (skip.has('scoring') && (node.type === 'score' || node.type === 'judge')) continue
      const output = await this.withTimeout(node, context(), maxTurnMs)
      if (output === null) {
        return { decision: 'deny', score, matched, reasons, restricted, skip, dropped: 'timeout' }
      }
      matched.push(node.id)
      switch (output.kind) {
        case 'deny':
          if (output.reason) reasons[node.id] = output.reason
          this.options.charge?.({ nodeId: node.id, event })
          return { decision: 'deny', score, matched, reasons, restricted, skip }
        case 'allow':
          if (output.reason) reasons[node.id] = output.reason
          skip.add('scoring')
          skip.add('judge')
          this.options.charge?.({ nodeId: node.id, event })
          return { decision: 'allow', score, matched, reasons, restricted, skip }
        case 'restrict':
          if (node.type !== 'budget') throw new Error(`only a budget node may return restrict, got "${node.type}"`)
          assertSkip(output.skip)
          for (const target of output.skip) skip.add(target)
          restricted = true
          if (output.reason) reasons[node.id] = output.reason
          break
        case 'score':
          score += output.value
          if (output.reason) reasons[node.id] = output.reason
          break
        case 'pass':
          break
        default:
          throw new Error(`unknown node output`)
      }
    }
    return { decision: 'deny', score, matched, reasons, restricted, skip }
  }

  private async withTimeout(node: PipelineNode, context: NodeContext, maxTurnMs: number): Promise<NodeOutput | null> {
    const limit = node.type === 'judge' && this.options.judgeTimeoutMs ? Math.min(this.options.judgeTimeoutMs, maxTurnMs) : maxTurnMs
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new TurnTimeout('turn timed out')), limit)
      })
      return await Promise.race([Promise.resolve(node.run(context)), timeout])
    } catch (error) {
      if (node.type === 'judge') {
        const code: JudgeFailure = error instanceof TurnTimeout ? 'judge_timeout' : 'judge_failed'
        this.options.onJudgeFailure?.(code, context.event)
        return { kind: 'deny', reason: code }
      }
      if (error instanceof TurnTimeout) return null
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
