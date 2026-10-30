export const PEER_GUIDANCE =
  'This is a peer message from another bot. Answer it with your reply as usual. If it needs no answer, call no_reply instead of staying silent. If you refuse it, call decline with a short reason.'

export const GROUP_GUIDANCE =
  'This is a message from an external group chat. Your reply is posted to that group. To address one member only, call send_text.'

/** The line that teaches a session how to answer, chosen by where the message came from. */
export function guidanceFor(scope: string): string {
  return scope === 'group' ? GROUP_GUIDANCE : PEER_GUIDANCE
}

/** Injects the guidance once per session, so a run of messages carries it only at the start. */
export class InjectionLedger {
  readonly #seen = new Set<string>()

  claim(sessionId: string): boolean {
    if (this.#seen.has(sessionId)) return false
    this.#seen.add(sessionId)
    return true
  }

  get size(): number {
    return this.#seen.size
  }

  clear(): void {
    this.#seen.clear()
  }
}
