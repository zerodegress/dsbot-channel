import type { BudgetLedger, LimitLevel } from './budget-ledger.js'
import { ConfigError } from './config.js'
import type { AuthorKind } from './event-types.js'
import type { Pipeline, PipelineEvent, PipelineResult } from './pipeline.js'

export const DEFAULT_LOOP_MAX_TURNS = 3
export const DEFAULT_LOOP_IDLE_RESET_MS = 300_000

/** How a bot's message in a group is treated, decided before any mention rule runs. */
export const GROUP_BOT_POLICIES = ['whenMentioned', 'silent', 'answer'] as const
export type GroupBotPolicy = (typeof GROUP_BOT_POLICIES)[number]

export interface LoopConfig {
  /** Consecutive rounds with one peer before the ceiling stops the next one. */
  relayLimit?: number
  /** Silence for this long clears the counter. */
  relayResetMs?: number
}

export interface GateOptions {
  loop?: LoopConfig | undefined
  /** Refuse a group message that named neither this bot nor everyone. */
  requireMention?: boolean | undefined
  /** How a bot's group message is treated: only when it names this bot, never, or like a person. */
  groupBots?: GroupBotPolicy | undefined
  pipeline?: Pipeline | undefined
  ledger?: BudgetLedger | undefined
  now?: (() => number) | undefined
}

export interface AdmitInput {
  event: PipelineEvent
  /** The peer this message came from. */
  peer: string
  botId: string
  /** Who sent it: the adapter reports this and core never derives it from the peer. */
  author: AuthorKind
  /** The key the adapter supplied; core never derives one from the peer. */
  session: string
  /** The pipeline this turn runs, when the caller resolves one per session. */
  pipeline?: Pipeline | undefined
}

export type GateReason =
  | 'allowed'
  | 'loop-limit'
  | 'not_addressed'
  | 'bot-speaker'
  | 'pipeline-deny'
  | 'pipeline-restrict'
  | 'budget-hard'

export interface GateDecision {
  allow: boolean
  reason: GateReason
  detail?: string | undefined
  limitState?: LimitLevel | undefined
  triggeredBy?: string[] | undefined
  pipeline?: PipelineResult | undefined
}

function checkLimit(field: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${field} must be a whole number of at least 1`, ['loop', field], [field])
  }
  return value
}

/** Decides whether an inbound peer message may start a turn. */
export class InboundGate {
  private readonly rounds = new Map<string, { count: number; at: number }>()
  private readonly maxTurns: number
  private readonly idleResetMs: number
  private readonly now: () => number

  constructor(private readonly options: GateOptions = {}) {
    this.maxTurns = checkLimit('relayLimit', options.loop?.relayLimit, DEFAULT_LOOP_MAX_TURNS)
    this.idleResetMs = checkLimit('relayResetMs', options.loop?.relayResetMs, DEFAULT_LOOP_IDLE_RESET_MS)
    this.now = options.now ?? Date.now
  }

  /** The one place a round is keyed: the bot and the conversation, never a second spelling of it. */
  private roundKey(botId: string, session: string): string {
    return `${botId}|${session}`
  }

  /** Counts one automatic reply so the next round can see the ceiling. */
  recordReply(botId: string, session: string): void {
    const key = this.roundKey(botId, session)
    const entry = this.live(key)
    this.rounds.set(key, { count: (entry?.count ?? 0) + 1, at: this.now() })
  }

  private live(key: string): { count: number; at: number } | undefined {
    const entry = this.rounds.get(key)
    if (!entry) return undefined
    if (this.now() - entry.at > this.idleResetMs) {
      this.rounds.delete(key)
      return undefined
    }
    return entry
  }

  /** A person speaking again clears the ceiling for that conversation. */
  resetPeer(session: string, botId?: string): void {
    if (botId !== undefined) {
      this.rounds.delete(this.roundKey(botId, session))
      return
    }
    for (const key of [...this.rounds.keys()]) {
      if (key.endsWith(`|${session}`)) this.rounds.delete(key)
    }
  }

  roundsWith(botId: string, session: string): number {
    return this.live(this.roundKey(botId, session))?.count ?? 0
  }

  async admit(input: AdmitInput): Promise<GateDecision> {
    const { event, botId } = input
    if (event.scope === 'group' && input.author === 'bot') {
      const mode = this.options.groupBots ?? 'whenMentioned'
      if (mode === 'silent') {
        return { allow: false, reason: 'bot-speaker', detail: 'groupBots=silent' }
      }
      if (mode === 'whenMentioned' && !event.mentioned.self && !event.mentioned.all) {
        return {
          allow: false,
          reason: 'bot-speaker',
          detail: `groupBots=whenMentioned; self=${event.mentioned.self} others=${event.mentioned.others} all=${event.mentioned.all}`,
        }
      }
    }
    if (this.options.requireMention === true && event.scope === 'group' && !event.mentioned.self && !event.mentioned.all) {
      return {
        allow: false,
        reason: 'not_addressed',
        detail: `self=${event.mentioned.self} others=${event.mentioned.others} all=${event.mentioned.all}`,
      }
    }
    const ledger = this.options.ledger
    const session = input.session
    let limitState: LimitLevel | undefined
    let triggeredBy: string[] = []
    if (ledger) {
      const state = ledger.check(botId, session)
      limitState = state.aggregate
      triggeredBy = state.triggeredBy
      if (state.aggregate === 'hard') return { allow: false, reason: 'budget-hard', limitState, triggeredBy }
    }

    if (this.roundsWith(botId, session) >= this.maxTurns) {
      return {
        allow: false,
        reason: 'loop-limit',
        detail: `${this.roundsWith(botId, session)} rounds in ${session}`,
        limitState,
        triggeredBy,
      }
    }

    const pipeline = input.pipeline ?? this.options.pipeline
    if (pipeline) {
      const result = await pipeline.run(event)
      if (result.decision !== 'allow') {
        const reason = result.restricted ? 'pipeline-restrict' : 'pipeline-deny'
        return { allow: false, reason, pipeline: result, limitState, triggeredBy, detail: Object.values(result.reasons)[0] }
      }
      return { allow: true, reason: 'allowed', pipeline: result, limitState, triggeredBy }
    }

    return { allow: true, reason: 'allowed', limitState, triggeredBy }
  }
}
