import { buildEvent } from './event-build.js'
import type { Event } from './event-types.js'

/** How much of the message being answered travels back with the reply. */
export const EXCERPT_CHARS = 200

/** How much of a peer's own text reaches a line of ours. */
export const PEER_TEXT_MAX = 200

function flatten(text: string): string {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    out += code < 0x20 || code === 0x7f ? ' ' : char
  }
  return out
}

/** A peer's own words for a line of ours: one line, bounded, nothing that breaks the line. */
export function oneLine(text: string, limit = PEER_TEXT_MAX): string {
  const flat = flatten(text).replace(/\s+/g, ' ').trim()
  return Array.from(flat).slice(0, limit).join('').trim()
}

/** Keeps a peer from shaping the header: no control characters, one line, no quotes. */
export function cleanExcerpt(text: string, limit = EXCERPT_CHARS): string {
  const flat = flatten(text)
    .replace(/["'`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(flat).slice(0, limit).join('').trim()
}

export interface P2PInbound {
  instance: string
  sender: string
  messageId: string
  body: string
  sentAt: number
  inReplyTo?: string
  inReplyToExcerpt?: string
}

/** Maps a peer message onto the event model with the peer identity as the source. */
export function toP2PEvent(inbound: P2PInbound): Event {
  const prefix = `[p2p from ${inbound.instance} · ${inbound.sender} · ${inbound.messageId}]`
  const reference =
    inbound.inReplyTo === undefined
      ? ''
      : ` (in reply to ${inbound.inReplyTo}${inbound.inReplyToExcerpt === undefined ? '' : `: "${cleanExcerpt(inbound.inReplyToExcerpt)}"`})`
  const head = `${prefix}${reference}`
  const text = inbound.body.length ? `${head} ${inbound.body}` : head
  return buildEvent({
    source: { kind: 'p2p', instance: inbound.instance, peer: inbound.instance, scope: 'p2p' },
    author: { senderId: inbound.sender, kind: 'bot', personId: null },
    body: { text, media: [], replyTo: null },
    transport: {
      messageId: inbound.messageId,
      timestamp: inbound.sentAt,
      mentioned: false,
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
  })
}
