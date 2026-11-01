import type { BudgetLedger, LimitLevel, Usage } from './budget-ledger.js'

/** The quota a bot runs under; absent when the profile declares no budget. */
export interface BotLimits {
  capacity: number
  hardLimit: number
}

export interface SessionUsage {
  /** The key the adapter supplied, which is also the key in `usage`. */
  sessionKey: string
  usage: Usage
  level: LimitLevel
  triggeredBy: string[]
}

export interface BotUsage {
  bot: string
  limits: BotLimits | null
  sessions: SessionUsage[]
}

export interface UsageSnapshot {
  sampledAt: number
  bots: BotUsage[]
}

export interface BotLedger {
  bot: string
  ledger: BudgetLedger | undefined
}

function copyUsage(usage: Usage): Usage {
  return { ...usage }
}

/** Reads what each bot has spent, without touching a decision path. */
export function usageSnapshot(bots: readonly BotLedger[], now: () => number = Date.now): UsageSnapshot {
  return {
    sampledAt: now(),
    bots: bots.map(({ bot, ledger }) => {
      if (ledger === undefined) return { bot, limits: null, sessions: [] }
      const limits = ledger.limitsView()
      return {
        bot,
        limits: { capacity: limits.capacity, hardLimit: limits.hardLimit },
        sessions: ledger.sessions().map((sessionKey) => {
          const state = ledger.check(bot, sessionKey)
          return {
            sessionKey,
            usage: copyUsage(ledger.usage(bot, sessionKey)),
            level: state.aggregate,
            triggeredBy: [...state.triggeredBy],
          }
        }),
      }
    }),
  }
}
