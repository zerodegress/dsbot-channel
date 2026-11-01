import type { ChargeKind } from './event-types.js'

export type LimitLevel = 'normal' | 'soft' | 'hard'

export interface BudgetPoints {
  judge: number
  accepted: number
  rejected: number
  push: number
}

export interface Hysteresis {
  softRelease: number
  hardReleaseBelow: number
  hardHoldMs: number
}

export interface BudgetSettings {
  points: BudgetPoints
  hysteresis: Hysteresis
}

export const DEFAULT_BUDGET: BudgetSettings = {
  points: { judge: 1, accepted: 20, rejected: 10, push: 5 },
  hysteresis: { softRelease: 0.05, hardReleaseBelow: 0.95, hardHoldMs: 60_000 },
}

export interface BudgetLimits {
  softLimit: number
  hardLimit: number
  capacity: number
}

export interface ChargeWindow {
  ttlMs: number
  limit: number
}

export const DEFAULT_CHARGE_WINDOW: ChargeWindow = { ttlMs: 300_000, limit: 100_000 }

export interface Hold {
  readonly botId: string
  readonly sessionKey: string
  readonly chargeKind: ChargeKind
  readonly amount: number
  readonly chargeId?: string | undefined
  /** A charge the ledger already recorded, so settling it must not add points again. */
  readonly duplicate: boolean
  settled: boolean
}

export interface Usage {
  global: number
  [key: string]: number
}

export interface LimitState {
  byScope: Record<string, LimitLevel>
  aggregate: LimitLevel
  triggeredBy: string[]
}

export interface Decision {
  allowed: boolean
  limitState: LimitLevel
  triggeredBy: string[]
}

export interface LedgerSnapshot {
  locks: [string, { level: LimitLevel; since: number }][]
}

const GLOBAL = 'global'
const BUCKET_MS = 60_000
const BUCKET_COUNT = 60

/** One hour window made of sixty one minute buckets. */
class Window {
  private readonly buckets = new Map<number, number>()

  add(points: number, at: number): void {
    const bucket = Math.floor(at / BUCKET_MS)
    this.buckets.set(bucket, (this.buckets.get(bucket) ?? 0) + points)
  }

  sum(at: number): number {
    const newest = Math.floor(at / BUCKET_MS)
    let total = 0
    for (const [bucket, value] of this.buckets) {
      if (bucket > newest - BUCKET_COUNT) total += value
    }
    return total
  }
}

export class BudgetLedger {
  private readonly windows = new Map<string, Window>()
  private readonly locks = new Map<string, { level: LimitLevel; since: number }>()
  private readonly charged = new Map<string, number>()
  private readonly now: () => number

  constructor(
    private readonly limits: BudgetLimits,
    private readonly settings: BudgetSettings = DEFAULT_BUDGET,
    now: () => number = Date.now,
    private readonly charges: ChargeWindow = DEFAULT_CHARGE_WINDOW,
  ) {
    this.now = now
  }

  pointsFor(kind: ChargeKind, outcome: 'accepted' | 'rejected' = 'accepted'): number {
    if (kind === 'judge') return this.settings.points.judge
    if (kind === 'push') return this.settings.points.push
    return this.settings.points[outcome]
  }

  private window(key: string): Window {
    let window = this.windows.get(key)
    if (!window) {
      window = new Window()
      this.windows.set(key, window)
    }
    return window
  }

  private keysFor(botId: string, session: string): string[] {
    return [GLOBAL, `bot:${botId}`, session]
  }

  private charge(keys: readonly string[], points: number): void {
    const at = this.now()
    for (const key of keys) this.window(key).add(points, at)
  }

  /** The limits this ledger enforces, as a copy, for a read-only view. */
  limitsView(): BudgetLimits {
    return { ...this.limits }
  }

  /** Every session key this ledger has charged, in the order it first saw them. */
  sessions(): string[] {
    const keys: string[] = []
    for (const key of this.windows.keys()) {
      if (key === GLOBAL || key.startsWith('bot:')) continue
      keys.push(key)
    }
    return keys
  }

  usage(botId: string, session: string): Usage {
    const at = this.now()
    const usage: Usage = { global: this.window(GLOBAL).sum(at) }
    for (const key of [`bot:${botId}`, session]) usage[key] = this.window(key).sum(at)
    return usage
  }

  /** The level the current windows and locks imply, computed without writing anything. */
  private levelFor(key: string, ratio: number, at: number): LimitLevel {
    const { softLimit, hardLimit } = this.limits
    const { softRelease, hardReleaseBelow, hardHoldMs } = this.settings.hysteresis
    const lock = this.locks.get(key)
    if (lock?.level === 'hard') {
      if (ratio >= hardReleaseBelow) return 'hard'
      if (at - lock.since < hardHoldMs) return 'hard'
      return ratio >= softLimit ? 'soft' : 'normal'
    }
    if (lock?.level === 'soft') {
      if (ratio >= hardLimit) return 'hard'
      if (ratio < softLimit - softRelease) return 'normal'
      return 'soft'
    }
    if (ratio >= hardLimit) return 'hard'
    if (ratio >= softLimit) return 'soft'
    return 'normal'
  }

  private levelOf(key: string, ratio: number, at: number): LimitLevel {
    const level = this.levelFor(key, ratio, at)
    const lock = this.locks.get(key)
    if (level === 'hard') {
      const held = lock?.level === 'hard' && ratio < this.settings.hysteresis.hardReleaseBelow
      if (!held) this.locks.set(key, { level: 'hard', since: at })
    } else if (level === 'soft') {
      if (lock?.level !== 'soft') this.locks.set(key, { level: 'soft', since: at })
    } else if (lock !== undefined) {
      this.locks.delete(key)
    }
    return level
  }

  /** The state a reader may see, computed without touching a lock or creating a window. */
  peek(botId: string, session: string): LimitState {
    const at = this.now()
    const byScope: Record<string, LimitLevel> = {}
    const triggeredBy: string[] = []
    let aggregate: LimitLevel = 'normal'
    for (const key of this.keysFor(botId, session)) {
      const ratio = this.spentOn(key, at) / this.limits.capacity
      const level = this.levelFor(key, ratio, at)
      byScope[key] = level
      if (level !== 'normal') triggeredBy.push(key)
      if (level === 'hard') aggregate = 'hard'
      else if (level === 'soft' && aggregate === 'normal') aggregate = 'soft'
    }
    return { byScope, aggregate, triggeredBy }
  }

  private spentOn(key: string, at: number): number {
    return this.windows.get(key)?.sum(at) ?? 0
  }

  check(botId: string, session: string): LimitState {
    const at = this.now()
    const byScope: Record<string, LimitLevel> = {}
    const triggeredBy: string[] = []
    let aggregate: LimitLevel = 'normal'
    for (const key of this.keysFor(botId, session)) {
      const ratio = this.window(key).sum(at) / this.limits.capacity
      const level = this.levelOf(key, ratio, at)
      byScope[key] = level
      if (level !== 'normal') triggeredBy.push(key)
      if (level === 'hard') aggregate = 'hard'
      else if (level === 'soft' && aggregate === 'normal') aggregate = 'soft'
    }
    return { byScope, aggregate, triggeredBy }
  }

  /** Records a charge under its own key, so a replay of the same event is charged once. */
  reserve(botId: string, session: string, chargeKind: ChargeKind, amount: number, chargeId?: string): Hold {
    const at = this.now()
    if (chargeId !== undefined) {
      const seen = this.charged.get(chargeId)
      if (seen !== undefined && at - seen <= this.charges.ttlMs) {
        return { botId, sessionKey: session, chargeKind, amount: 0, chargeId, duplicate: true, settled: false }
      }
      this.remember(chargeId, at)
    }
    const hold: Hold = {
      botId,
      sessionKey: session,
      chargeKind,
      amount,
      ...(chargeId === undefined ? {} : { chargeId }),
      duplicate: false,
      settled: false,
    }
    this.charge(this.keysFor(botId, session), amount)
    return hold
  }

  /** Drops the records past the replay window, then the oldest while the table is still full. */
  private remember(chargeId: string, at: number): void {
    this.charged.delete(chargeId)
    this.charged.set(chargeId, at)
    for (const [id, seen] of this.charged) {
      if (at - seen <= this.charges.ttlMs) break
      this.charged.delete(id)
    }
    while (this.charged.size > this.charges.limit) {
      const oldest = this.charged.keys().next()
      if (oldest.done === true) break
      this.charged.delete(oldest.value)
    }
  }

  settle(hold: Hold, outcome: 'accepted' | 'rejected'): Usage {
    if (hold.settled) throw new Error('hold already settled')
    hold.settled = true
    if (hold.duplicate) return this.usage(hold.botId, hold.sessionKey)
    const final = hold.chargeKind === 'bot' ? this.pointsFor('bot', outcome) : hold.amount
    const delta = final - hold.amount
    if (delta !== 0) this.charge(this.keysFor(hold.botId, hold.sessionKey), delta)
    return this.usage(hold.botId, hold.sessionKey)
  }

  refund(hold: Hold): void {
    if (hold.settled) throw new Error('hold already settled')
    hold.settled = true
    if (hold.duplicate) return
    if (hold.chargeId !== undefined) this.charged.delete(hold.chargeId)
    this.charge(this.keysFor(hold.botId, hold.sessionKey), -hold.amount)
  }

  /** Checks and charges synchronously, so no other turn can slip in between. */
  decide(botId: string, session: string, chargeKind: ChargeKind, run: () => boolean): Decision {
    if (run.constructor.name === 'AsyncFunction') throw new Error('decide requires a sync predicate')
    const state = this.check(botId, session)
    if (state.aggregate === 'hard') return { allowed: false, limitState: 'hard', triggeredBy: state.triggeredBy }
    if (!run()) return { allowed: false, limitState: state.aggregate, triggeredBy: state.triggeredBy }
    this.charge(this.keysFor(botId, session), this.pointsFor(chargeKind))
    return { allowed: true, limitState: state.aggregate, triggeredBy: state.triggeredBy }
  }

  setUsage(usage: Usage): void {
    const at = this.now()
    for (const [key, value] of Object.entries(usage)) {
      const window = this.window(key)
      window.add(value - window.sum(at), at)
    }
  }

  snapshot(): LedgerSnapshot {
    return { locks: [...this.locks.entries()] }
  }

  restore(snapshot: LedgerSnapshot): void {
    this.locks.clear()
    for (const [key, value] of snapshot.locks) this.locks.set(key, value)
  }
}
