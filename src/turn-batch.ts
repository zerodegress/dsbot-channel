/** One message in the queue, with the characters it brings to a joined body. */
export interface PendingMessage {
  eventKey: string
  /** Characters this message contributes once joined into the batch body. */
  chars: number
}

export interface BatchLimits {
  maxBatch: number
  maxChars: number
}

/** How many queued messages make the next turn; a single oversized message still goes alone. */
export function takeBatch(pending: readonly PendingMessage[], limits: BatchLimits): number {
  if (pending.length === 0) return 0
  let chars = 0
  let taken = 0
  for (const message of pending) {
    if (taken >= limits.maxBatch) break
    const added = taken === 0 ? message.chars : message.chars + 1
    if (taken > 0 && chars + added > limits.maxChars) break
    chars += added
    taken += 1
  }
  return taken
}

/** Joins one batch into the text a turn reads, keeping each message's own line intact. */
export function joinBatch(texts: readonly string[]): string {
  return texts.join('\n')
}

/** The characters a batch occupies once joined: the parts plus one newline between each. */
export function batchChars(texts: readonly string[]): number {
  if (texts.length === 0) return 0
  return texts.reduce((sum, text) => sum + text.length, 0) + texts.length - 1
}
