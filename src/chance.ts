import { createHash } from 'node:crypto'

/**
 * The bucket one event key falls in for one node: a fixed hash, so a
 * redelivery takes the same outcome, and the node id, so two chance
 * nodes on one message are independent.
 */
export function chanceBucket(eventKey: string, nodeId: string): number {
  const digest = createHash('sha256').update(`${eventKey}\u0000${nodeId}`, 'utf8').digest()
  let value = 0n
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index] ?? 0)
  return Number(value) / 18_446_744_073_709_551_616
}
