import { createHash } from 'node:crypto'
import type { Body, MediaRef } from './event-types.js'

/** Identifies one platform message for dedupe and billing. */
export function eventKey(instance: string, platformMessageId: string): string {
  if (!instance) throw new Error('eventKey: instance is required')
  if (!platformMessageId) throw new Error('eventKey: platform message id is required')
  return `${instance}:${platformMessageId}`
}

function normalizeMedia(media: readonly MediaRef[]): string {
  return JSON.stringify(media.map((item) => [item.type, item.url]))
}

/** Hashes body text and media references, never the platform message id. */
export function contentHash(body: Pick<Body, 'text' | 'media'>): string {
  const payload = `${body.text.trim()}\n${normalizeMedia(body.media)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
