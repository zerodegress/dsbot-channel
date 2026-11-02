/** How many queued messages make the next turn, under the limits a profile declared. */
export interface PendingMessage {
  eventKey: string
  /** Characters this message contributes once joined into the batch body. */
  chars: number
}

export interface BatchLimits {
  maxBatch: number
  maxChars: number
}

/**
 * Takes a prefix of the queue as one turn. A message is never split or dropped for being large:
 * when the batch is still empty it is taken whole, because the character limit bounds how many
 * messages go together, not whether a single message may arrive at all.
 */
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
