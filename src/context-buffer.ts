import type { MediaType } from './event-types.js'

/** Messages kept per conversation, and the budget their text may spend. */
export const DEFAULT_CONTEXT_MESSAGES = 0
export const DEFAULT_CONTEXT_CHARS = 2000
/** Longest single line kept; a reader never needs more of one message. */
export const CONTEXT_LINE_MAX = 240
/** Conversations the buffer will hold; past this a new one is left out. */
export const CONTEXT_GROUPS_MAX = 100
/** The first line of the block, so a reader knows where it starts and what it holds. */
export const CONTEXT_HEADER = '[context] messages this bot did not answer'

export interface BufferedMessage {
  eventKey: string
  senderId: string
  /** Shown beside the id when the transport declared one; never used as identity. */
  nickname: string
  /** What the sender said — no adapter header — cut to `CONTEXT_LINE_MAX` on one line. */
  text: string
  media: readonly MediaType[]
}

export interface ContextLimits {
  /** Messages kept per conversation; `0` turns the buffer off. */
  messages: number
  /** Text budget per conversation, in characters. */
  chars: number
}

/** A message flattened to one line and cut to the length a context line may take. */
export function oneLine(text: string, limit = CONTEXT_LINE_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : flat.slice(0, limit)
}

/** One message as a line: who said it, what they said, and any media placeholder. */
export function contextLine(message: BufferedMessage): string {
  const who = message.nickname === '' ? message.senderId : `${message.senderId} (${message.nickname})`
  const media = message.media.map((type) => `[${type}]`).join(' ')
  const said = message.text === '' ? media : media === '' ? message.text : `${message.text} ${media}`
  return said === '' ? `${who}:` : `${who}: ${said}`
}

/** The block a turn reads, or an empty string when there is nothing to show. */
export function renderContext(entries: readonly BufferedMessage[]): string {
  if (entries.length === 0) return ''
  return [CONTEXT_HEADER, ...entries.map((one) => contextLine(one))].join('\n')
}

/** The last few messages of each conversation, kept only to give a turn context. */
export class ContextBuffer {
  readonly #limits: ContextLimits
  readonly #groups = new Map<string, BufferedMessage[]>()

  constructor(limits: Partial<ContextLimits> = {}) {
    this.#limits = {
      messages: limits.messages ?? DEFAULT_CONTEXT_MESSAGES,
      chars: limits.chars ?? DEFAULT_CONTEXT_CHARS,
    }
  }

  /** Records one inbound message; policy never decides what a reader may see. */
  record(sessionKey: string, message: BufferedMessage): void {
    if (this.#limits.messages <= 0) return
    let kept = this.#groups.get(sessionKey)
    if (kept === undefined) {
      if (this.#groups.size >= CONTEXT_GROUPS_MAX) return
      kept = []
      this.#groups.set(sessionKey, kept)
    }
    kept.push({ ...message, text: oneLine(message.text) })
    while (kept.length > this.#limits.messages) kept.shift()
    this.#trim(sessionKey, kept)
  }

  /** What a turn may read: oldest first, with the keys this turn already carries left out. */
  entries(sessionKey: string, exclude: readonly string[] = []): BufferedMessage[] {
    if (this.#limits.messages <= 0) return []
    const kept = this.#groups.get(sessionKey)
    if (kept === undefined) return []
    const skip = new Set(exclude)
    return kept.filter((one) => !skip.has(one.eventKey))
  }

  /** Drops the oldest whole message until the text fits the budget. */
  #trim(sessionKey: string, kept: BufferedMessage[]): void {
    let used = kept.reduce((sum, one) => sum + one.text.length, 0)
    while (used > this.#limits.chars && kept.length > 0) {
      const dropped = kept.shift()!
      used -= dropped.text.length
    }
    if (kept.length === 0) this.#groups.delete(sessionKey)
  }
}
