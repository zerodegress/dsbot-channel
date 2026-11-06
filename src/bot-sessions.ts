import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ConfigError } from './config.js'

export interface BotSegment {
  sessionId?: unknown
  endedAt?: unknown
}

export interface BotRecord {
  id?: unknown
  name?: unknown
  sessionId?: unknown
  segments?: unknown
}

export const ANCHOR_CODES = [
  'session_unresolved',
  'session_ambiguous',
  'session_stale',
  'session_unknown',
  'session_anchor_conflict',
] as const

export type AnchorCode = (typeof ANCHOR_CODES)[number]

export type AnchorResult =
  | { ok: true; sessionId: string }
  | { ok: false; code: AnchorCode; reason: string }

export interface SessionAnchorOptions {
  channel: string
  botName?: string
  session?: string
  statePath?: string
  warn(line: string): void
}

/** Where the host keeps its bot roster; `DSH_HOME` is the launcher's own default. */
export function defaultBotStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, 'bot', 'state.json')
}

const recordOf = (value: unknown): value is BotRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const stringOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined

/** A host without ds-bot keeps no roster; that is not an error worth a warning. */
export class BotRosterMissing extends Error {
  constructor(path: string) {
    super(`no bot roster at ${path}`)
    this.name = 'BotRosterMissing'
  }
}

/** Reads the bot roster; a missing file, an unreadable one and a corrupt one stay apart. */
export async function readBots(path: string): Promise<BotRecord[]> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new BotRosterMissing(path)
    throw error
  }
  const parsed = JSON.parse(raw) as { bots?: unknown }
  const bots = parsed?.bots
  if (!recordOf(bots)) throw new Error('state.json has no bots map')
  return Object.values(bots).filter(recordOf)
}

/** The segment a bot is in now: `sessionId`, else its first id. */
export function currentSessionOf(bot: BotRecord): string | undefined {
  return stringOf(bot.sessionId) ?? stringOf(bot.id)
}

/** Segments the bot has left, by their recorded id. */
export function endedSessionsOf(bot: BotRecord): Set<string> {
  const ended = new Set<string>()
  if (!Array.isArray(bot.segments)) return ended
  for (const segment of bot.segments as readonly unknown[]) {
    if (!recordOf(segment)) continue
    const one = segment as BotSegment
    if (one.endedAt === undefined || one.endedAt === null) continue
    const id = stringOf(one.sessionId)
    if (id !== undefined) ended.add(id)
  }
  return ended
}

export function botNameOf(bot: BotRecord): string {
  return typeof bot.name === 'string' ? bot.name : ''
}

type PinnedState = 'current' | 'stale' | 'unknown'

/**
 * Resolves the session one adapter anchors to: a Bot's current segment, or a
 * segment the profile pinned. A resolver keeps the last good Bot session.
 */
export class SessionAnchor {
  readonly #channel: string
  readonly #botName: string | undefined
  readonly #session: string | undefined
  readonly #path: string
  readonly #warn: (line: string) => void
  #lastKnown: string | undefined
  #warned = false

  constructor(options: SessionAnchorOptions) {
    this.#channel = options.channel
    this.#botName = options.botName
    this.#session = options.session
    this.#path = options.statePath ?? defaultBotStatePath()
    this.#warn = options.warn
  }

  get channel(): string {
    return this.#channel
  }

  get botName(): string | undefined {
    return this.#botName
  }

  get pinnedSession(): string | undefined {
    return this.#session
  }

  /** True when this adapter follows a Bot instead of pinning a session. */
  get followsBot(): boolean {
    return this.#botName !== undefined
  }

  /** Resolves the session for one turn; reads the roster anew every time. */
  async resolve(): Promise<AnchorResult> {
    return this.#session === undefined ? this.#resolveBot() : this.#resolvePinned()
  }

  /** Checks a pinned session before the profile starts; a Bot anchor needs no mount check. */
  async mountCheck(): Promise<void> {
    const pinned = this.#session
    if (pinned === undefined) return
    let bots: BotRecord[]
    try {
      bots = await readBots(this.#path)
    } catch (error) {
      if (error instanceof BotRosterMissing) return
      this.#warnOnce(this.#cannotVerify(pinned, 'state.json is unreadable'))
      return
    }
    this.#warned = false
    const state = classifyPinned(bots, pinned)
    if (state === 'current') return
    if (state === 'stale') {
      throw new ConfigError(
        `pinned session "${pinned}" is a segment the Bot has left (session_stale); use botName to follow the current segment`,
        ['adapters', 'session'],
      )
    }
    throw new ConfigError(
      `pinned session "${pinned}" is in no Bot roster (session_unknown); use botName to follow a Bot`,
      ['adapters', 'session'],
    )
  }

  async #resolveBot(): Promise<AnchorResult> {
    const wanted = this.#botName ?? this.#channel
    let bots: BotRecord[]
    try {
      bots = await readBots(this.#path)
    } catch (error) {
      const missing = error instanceof BotRosterMissing
      return this.#unresolved(missing ? 'state.json is missing' : 'state.json is unreadable', wanted, missing)
    }
    this.#warned = false
    const byName = bots.filter((bot) => botNameOf(bot) === wanted)
    const matches = byName.length > 0 ? byName : bots.filter((bot) => stringOf(bot.id) === wanted)
    if (matches.length > 1) {
      return { ok: false, code: 'session_ambiguous', reason: `more than one Bot is named "${wanted}"` }
    }
    if (matches.length === 0) {
      const names = bots.map((bot) => botNameOf(bot)).filter((name) => name.length > 0)
      const listed = names.length > 0 ? names.join(', ') : 'none'
      return { ok: false, code: 'session_unresolved', reason: `Bot "${wanted}" is not in the roster (known: ${listed})` }
    }
    const current = currentSessionOf(matches[0] as BotRecord)
    if (current === undefined) {
      return { ok: false, code: 'session_unresolved', reason: `Bot "${wanted}" has no current segment id` }
    }
    this.#lastKnown = current
    return { ok: true, sessionId: current }
  }

  #unresolved(reason: string, wanted: string, quiet = false): AnchorResult {
    const last = this.#lastKnown
    if (quiet && last === undefined) {
      return { ok: false, code: 'session_unresolved', reason }
    }
    if (last === undefined) {
      this.#warnOnce(
        `dsbot-channel: adapter "${this.#channel}" cannot resolve the session of bot "${wanted}": ${reason}; the turn fails with session_unresolved`,
      )
      return { ok: false, code: 'session_unresolved', reason }
    }
    this.#warnOnce(
      `dsbot-channel: adapter "${this.#channel}" cannot resolve the session of bot "${wanted}": ${reason}; using the last session ${last}`,
    )
    return { ok: true, sessionId: last }
  }

  async #resolvePinned(): Promise<AnchorResult> {
    const pinned = this.#session as string
    let bots: BotRecord[]
    try {
      bots = await readBots(this.#path)
    } catch (error) {
      if (error instanceof BotRosterMissing) return { ok: true, sessionId: pinned }
      this.#warnOnce(this.#cannotVerify(pinned, 'state.json is unreadable'))
      return { ok: true, sessionId: pinned }
    }
    this.#warned = false
    const state = classifyPinned(bots, pinned)
    if (state === 'current') return { ok: true, sessionId: pinned }
    if (state === 'stale') {
      return { ok: false, code: 'session_stale', reason: `pinned session "${pinned}" is a segment its Bot has left` }
    }
    return { ok: false, code: 'session_unknown', reason: `pinned session "${pinned}" is in no Bot roster` }
  }

  #cannotVerify(pinned: string, reason: string): string {
    return `dsbot-channel: cannot verify pinned session ${pinned} (${reason}); it will be re-checked each turn`
  }

  #warnOnce(line: string): void {
    if (this.#warned) return
    this.#warned = true
    this.#warn(line)
  }
}

function classifyPinned(bots: readonly BotRecord[], pinned: string): PinnedState {
  if (bots.some((bot) => currentSessionOf(bot) === pinned)) return 'current'
  if (bots.some((bot) => endedSessionsOf(bot).has(pinned))) return 'stale'
  if (bots.some((bot) => stringOf(bot.id) === pinned)) return 'stale'
  return 'unknown'
}

/** The Bot a pinned session belongs to now, for the anchor-conflict check. */
export function botOfSession(bots: readonly BotRecord[], session: string): BotRecord | undefined {
  return bots.find((bot) => currentSessionOf(bot) === session)
}
