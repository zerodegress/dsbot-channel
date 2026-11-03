import { buildEvent } from '../../event-build.js'
import type { MediaType } from '../../event-types.js'
import type { P2PMediaItem } from './p2p-wire.js'
import type { Event } from '../../event-types.js'

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
export function oneLine(text: unknown, limit = PEER_TEXT_MAX): string {
  const flat = flatten(typeof text === 'string' ? text : String(text ?? '')).replace(/\s+/g, ' ').trim()
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

/** Longest handle a header line carries, so a reply's id cannot grow the line. */
export const HANDLE_MAX = 64

/**
 * A bounded single-line handle for a header: the id is already short (42-47 characters
 * for a reply), and the limit keeps a caller from ever pushing a whole long id through.
 */
export function shortHandle(value: string, limit = HANDLE_MAX): string {
  return Array.from(oneLine(value, limit)).slice(0, limit).join('')
}

export interface P2PInbound {
  instance: string
  sender: string
  messageId: string
  body: string
  media?: readonly P2PMediaItem[]
  sentAt: number
  inReplyTo?: string
  inReplyToExcerpt?: string
  status?: 'declined'
  reason?: string
  final?: boolean
}

/** Maps a peer message onto the event model with the peer identity as the source. */
export function toP2PEvent(inbound: P2PInbound): Event {
  const prefix = `[p2p from ${inbound.instance} · ${inbound.sender} · ${shortHandle(inbound.messageId)}]`
  const reference =
    inbound.inReplyTo === undefined
      ? ''
      : ` (in reply to ${shortHandle(inbound.inReplyTo)}${inbound.inReplyToExcerpt === undefined ? '' : `: "${cleanExcerpt(inbound.inReplyToExcerpt)}"`})`
  const head = `${prefix}${reference}`
  const text = inbound.body.length ? `${head} ${inbound.body}` : head
  return buildEvent({
    source: { kind: 'p2p', instance: inbound.instance, peer: inbound.instance, scope: 'p2p' },
    author: { senderId: inbound.sender, kind: 'bot', personId: null },
    body: {
      text,
      media: (inbound.media ?? []).map(([type, url, name]) => ({
        type: type as MediaType,
        url,
        handle: null,
        ...(name === undefined ? {} : { name }),
      })),
      replyTo: null,
    },
    transport: {
      messageId: inbound.messageId,
      timestamp: inbound.sentAt,
      mentioned: { self: false, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: '', avatar: '', claimedIdentity: null },
    adapter: {
      sentAt: inbound.sentAt,
      ...(inbound.inReplyTo === undefined ? {} : { inReplyTo: inbound.inReplyTo }),
      ...(inbound.inReplyToExcerpt === undefined ? {} : { inReplyToExcerpt: inbound.inReplyToExcerpt }),
      ...(inbound.status === undefined ? {} : { status: inbound.status }),
      ...(inbound.reason === undefined ? {} : { reason: inbound.reason }),
      ...(inbound.final === undefined ? {} : { final: inbound.final }),
    },
  })
}
