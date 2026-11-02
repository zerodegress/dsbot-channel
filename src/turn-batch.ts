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
    if (taken > 0 && chars + message.chars > limits.maxChars) break
    chars += message.chars
    taken += 1
  }
  return taken
}

/** Joins one batch into the text a turn reads, keeping each message's own line intact. */
export function joinBatch(texts: readonly string[]): string {
  return texts.join('\n')
}

/** The characters a batch contributes, separator included, so a cap stays a cap. */
export function batchChars(texts: readonly string[]): number[] {
  return texts.map((text) => text.length + 1)
}
