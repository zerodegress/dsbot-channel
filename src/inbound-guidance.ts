/** The block a tool-mode turn carries, so the model knows plain text is not delivered. */
export const TOOL_MODE_NOTICE =
  '[tool-mode] Answer with a tool: send_text to send, no_reply to end, decline to refuse. Plain text is not delivered.'

/** Longest tool-mode block core injects. */
export const TOOL_MODE_NOTICE_MAX = 300

/** Decides which prompt blocks a turn carries: guidance once per conversation, the mode block on each switch into tool. */
export class InjectionLedger {
  readonly #guidance = new Set<string>()
  readonly #mode = new Map<string, 'tool'>()

  claim(key: string): boolean {
    if (this.#guidance.has(key)) return false
    this.#guidance.add(key)
    return true
  }

  /** True when this turn enters tool mode from something else, which is when the block is worth repeating. */
  claimMode(key: string, mode: 'auto' | 'tool'): boolean {
    if (mode === 'auto') {
      this.#mode.delete(key)
      return false
    }
    if (this.#mode.get(key) === 'tool') return false
    this.#mode.set(key, 'tool')
    return true
  }

  /** Conversations that have already received the guidance block; the mode state is tracked apart. */
  get guidanceSize(): number {
    return this.#guidance.size
  }

  clear(): void {
    this.#guidance.clear()
    this.#mode.clear()
  }
}
