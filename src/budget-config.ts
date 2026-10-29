import { BudgetLedger } from './budget-ledger.js'

export const DEFAULT_SOFT_LIMIT = 0.8
export const DEFAULT_HARD_LIMIT = 1

export interface BudgetConfig {
  /** Points one window may spend before the ratios apply. */
  capacity: number
  softLimit?: number | undefined
  hardLimit?: number | undefined
}

export interface LedgerOptions {
  now?: (() => number) | undefined
}

/** Builds the ledger an adapter charges; no capacity, no ledger. */
export function createLedger(config: BudgetConfig, options: LedgerOptions = {}): BudgetLedger {
  return new BudgetLedger(
    {
      capacity: config.capacity,
      softLimit: config.softLimit ?? DEFAULT_SOFT_LIMIT,
      hardLimit: config.hardLimit ?? DEFAULT_HARD_LIMIT,
    },
    undefined,
    options.now,
  )
}
