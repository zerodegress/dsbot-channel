import { DEFAULT_BUDGET, BudgetLedger, DEFAULT_CHARGE_WINDOW } from './budget-ledger.js'
import type { ChargeWindow } from './budget-ledger.js'

export const DEFAULT_HARD_LIMIT = 1

export interface BudgetConfig {
  /** Points one window may spend before the ratios apply. */
  capacity: number
  hardLimit?: number | undefined
}

export interface LedgerOptions {
  now?: (() => number) | undefined
  charges?: Partial<ChargeWindow> | undefined
  points?: { judge?: number | undefined } | undefined
}

/** Builds the ledger an adapter charges; no capacity, no ledger. */
export function createLedger(config: BudgetConfig, options: LedgerOptions = {}): BudgetLedger {
  return new BudgetLedger(
    {
      capacity: config.capacity,
      hardLimit: config.hardLimit ?? DEFAULT_HARD_LIMIT,
    },
    options.points?.judge === undefined
      ? undefined
      : { ...DEFAULT_BUDGET, points: { ...DEFAULT_BUDGET.points, judge: options.points.judge } },
    options.now,
    {
      ...DEFAULT_CHARGE_WINDOW,
      ...(options.charges?.ttlMs === undefined ? {} : { ttlMs: options.charges.ttlMs }),
      ...(options.charges?.limit === undefined ? {} : { limit: options.charges.limit }),
    },
  )
}
