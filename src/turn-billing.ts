import type { BudgetLedger, Hold } from './budget-ledger.js'
import { sessionKeyFor } from './budget-ledger.js'
import type { ChargeKind } from './event-types.js'

export interface TurnBillingOptions {
  ledger?: BudgetLedger | undefined
  chargeKind?: ChargeKind | undefined
}

/** Reserves what a turn may cost before it starts, settles it once it ends. */
export class TurnBilling {
  constructor(private readonly options: TurnBillingOptions = {}) {}

  begin(botId: string, peer: string, session = sessionKeyFor({ scope: 'p2p', target: peer })): Hold | undefined {
    const ledger = this.options.ledger
    if (!ledger) return undefined
    const kind = this.options.chargeKind ?? 'bot'
    return ledger.reserve(botId, session, kind, ledger.pointsFor(kind, 'accepted'))
  }

  accept(hold: Hold | undefined): void {
    if (hold) this.options.ledger?.settle(hold, 'accepted')
  }

  reject(hold: Hold | undefined): void {
    if (hold) this.options.ledger?.settle(hold, 'rejected')
  }

  refund(hold: Hold | undefined): void {
    if (hold) this.options.ledger?.refund(hold)
  }
}
