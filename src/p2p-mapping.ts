import { buildEvent } from './event-build.js'
import type { Event } from './event-types.js'

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
      : ` (in reply to ${inbound.inReplyTo}${inbound.inReplyToExcerpt === undefined ? '' : `: "${inbound.inReplyToExcerpt}"`})`
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
