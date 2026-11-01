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
