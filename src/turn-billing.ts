import type { BudgetLedger, Hold } from './budget-ledger.js'
import { chargeKey } from './event-build.js'

export interface TurnBillingOptions {
  ledger?: BudgetLedger | undefined
}

/** Reserves what a turn may cost before it starts, settles it once it ends. */
export class TurnBilling {
  constructor(private readonly options: TurnBillingOptions = {}) {}

  /** `session` is the key the adapter supplied, never the host's session id. */
  begin(botId: string, session: string, eventKey?: string): Hold | undefined {
    const ledger = this.options.ledger
    if (!ledger) return undefined
    const chargeId = eventKey === undefined ? undefined : chargeKey(eventKey, botId, 'bot')
    return ledger.reserve(botId, session, 'bot', ledger.pointsFor('accepted'), chargeId)
  }

  /** Charges one judge call for this event; a replayed event is charged once. */
  judge(botId: string, session: string, eventKey: string): void {
    const ledger = this.options.ledger
    if (!ledger) return
    ledger.reserve(botId, session, 'judge', ledger.pointsFor('judge'), chargeKey(eventKey, botId, 'judge'))
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
