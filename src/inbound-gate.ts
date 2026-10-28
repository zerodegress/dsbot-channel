import type { BudgetLedger, LimitLevel } from './budget-ledger.js'
import type { Pipeline, PipelineEvent, PipelineResult } from './pipeline.js'

export const DEFAULT_LOOP_MAX_TURNS = 3
export const DEFAULT_LOOP_IDLE_RESET_MS = 300_000

export interface LoopConfig {
  /** Consecutive rounds with one peer; zero disables the ceiling. */
  maxTurns?: number
  /** Silence for this long clears the counter; zero disables the reset. */
  idleResetMs?: number
}

export interface GateOptions {
  loop?: LoopConfig | undefined
  pipeline?: Pipeline | undefined
  ledger?: BudgetLedger | undefined
  now?: (() => number) | undefined
}

export interface AdmitInput {
  event: PipelineEvent
  /** The peer this message came from. */
  peer: string
  botId: string
  session?: string | undefined
}

export type GateReason = 'allowed' | 'loop-limit' | 'pipeline-deny' | 'pipeline-restrict' | 'budget-hard'

export interface GateDecision {
  allow: boolean
  reason: GateReason
  detail?: string | undefined
  limitState?: LimitLevel | undefined
  triggeredBy?: string[] | undefined
  pipeline?: PipelineResult | undefined
}

/** Decides whether an inbound peer message may start a turn. */
export class InboundGate {
  private readonly rounds = new Map<string, { count: number; at: number }>()
  private readonly maxTurns: number
  private readonly idleResetMs: number
  private readonly now: () => number

  constructor(private readonly options: GateOptions = {}) {
    this.maxTurns = options.loop?.maxTurns ?? DEFAULT_LOOP_MAX_TURNS
    this.idleResetMs = options.loop?.idleResetMs ?? DEFAULT_LOOP_IDLE_RESET_MS
    this.now = options.now ?? Date.now
  }

  private key(botId: string, peer: string): string {
    return `${botId}|${peer}`
  }

  /** Counts one automatic reply so the next round can see the ceiling. */
  recordReply(botId: string, peer: string): void {
    const key = this.key(botId, peer)
    const entry = this.live(key)
    this.rounds.set(key, { count: (entry?.count ?? 0) + 1, at: this.now() })
  }

  private live(key: string): { count: number; at: number } | undefined {
    const entry = this.rounds.get(key)
    if (!entry) return undefined
    if (this.idleResetMs > 0 && this.now() - entry.at > this.idleResetMs) {
      this.rounds.delete(key)
      return undefined
    }
    return entry
  }

  /** A person speaking again clears the ceiling for that peer. */
  resetPeer(peer: string, botId?: string): void {
    if (botId !== undefined) {
      this.rounds.delete(this.key(botId, peer))
      return
    }
    for (const key of [...this.rounds.keys()]) {
      if (key.endsWith(`|${peer}`)) this.rounds.delete(key)
    }
  }

  roundsWith(botId: string, peer: string): number {
    return this.live(this.key(botId, peer))?.count ?? 0
  }

  async admit(input: AdmitInput): Promise<GateDecision> {
    const { event, botId, peer } = input
    const ledger = this.options.ledger
    const session = input.session ?? `p2p:${peer}`
    let limitState: LimitLevel | undefined
    let triggeredBy: string[] | undefined
    if (ledger) {
      const state = ledger.check(botId, session)
      limitState = state.aggregate
      triggeredBy = state.triggeredBy
      if (state.aggregate === 'hard') return { allow: false, reason: 'budget-hard', limitState, triggeredBy }
    }

    if (this.maxTurns > 0 && this.roundsWith(botId, peer) >= this.maxTurns) {
      return { allow: false, reason: 'loop-limit', detail: `${this.roundsWith(botId, peer)} rounds with ${peer}`, limitState }
    }

    if (this.options.pipeline) {
      const result = await this.options.pipeline.run(event)
      if (result.decision !== 'allow') {
        const reason = result.restricted ? 'pipeline-restrict' : 'pipeline-deny'
        return { allow: false, reason, pipeline: result, limitState, detail: Object.values(result.reasons)[0] }
      }
      return { allow: true, reason: 'allowed', pipeline: result, limitState }
    }

    return { allow: true, reason: 'allowed', limitState, triggeredBy }
  }
}
