import { createHash } from 'node:crypto'
import type { MediaInput } from './event-types.js'

/** Identifies one platform message for dedupe and billing. */
export function eventKey(instance: string, platformMessageId: string): string {
  if (!instance) throw new Error('eventKey: instance is required')
  if (!platformMessageId) throw new Error('eventKey: platform message id is required')
  return `${instance}:${platformMessageId}`
}

/** Content is the media itself: the url, the handle, never the instance that owns it. */
function normalizeMedia(media: readonly MediaInput[]): string {
  return JSON.stringify(media.map((item) => [item.type, item.url, item.handle]))
}

/** Hashes body text and media references, never the platform message id or a media owner. */
export function contentHash(body: { text: string; media: readonly MediaInput[] }): string {
  const payload = `${body.text.trim()}\n${normalizeMedia(body.media)}`
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}
