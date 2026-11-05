import { createHash } from 'node:crypto'

/** The first eight bytes of a sha256 digest, so one bucket is a whole number below 2^64. */
const BUCKET_SPACE = 1n << 64n

/**
 * The bucket one event key falls in for one node: a fixed hash, so a
 * redelivery takes the same outcome, and the node id, so two chance
 * nodes on one message are independent.
 */
export function chanceBucket(eventKey: string, nodeId: string): bigint {
  const digest = createHash('sha256').update(`${eventKey}\u0000${nodeId}`, 'utf8').digest()
  let value = 0n
  for (let index = 0; index < 8; index += 1) value = (value << 8n) | BigInt(digest[index] ?? 0)
  return value
}

/** Whether a bucket falls under the probability, compared in whole numbers so both ends are exact. */
export function chanceHits(bucket: bigint, probability: number): boolean {
  if (!(probability > 0)) return false
  if (probability >= 1) return true
  return bucket < BigInt(Math.floor(probability * Number(BUCKET_SPACE)))
}
