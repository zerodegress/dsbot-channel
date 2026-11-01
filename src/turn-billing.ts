import type { BudgetLedger, Hold } from './budget-ledger.js'
import { chargeKey } from './event-build.js'
import type { ChargeKind } from './event-types.js'

export interface TurnBillingOptions {
  ledger?: BudgetLedger | undefined
  chargeKind?: ChargeKind | undefined
}

/** Reserves what a turn may cost before it starts, settles it once it ends. */
export class TurnBilling {
  constructor(private readonly options: TurnBillingOptions = {}) {}

  /** `session` is the key the adapter supplied, never the host's session id. */
  begin(botId: string, session: string, eventKey?: string): Hold | undefined {
    const ledger = this.options.ledger
    if (!ledger) return undefined
    const kind = this.options.chargeKind ?? 'bot'
    const chargeId = eventKey === undefined ? undefined : chargeKey(eventKey, botId, kind)
    return ledger.reserve(botId, session, kind, ledger.pointsFor(kind, 'accepted'), chargeId)
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
