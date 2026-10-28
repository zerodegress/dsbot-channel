import { buildEvent } from './event-build.js'
import type { Event } from './event-types.js'

export interface P2PInbound {
  instance: string
  sender: string
  messageId: string
  body: string
  sentAt: number
}

/** Maps a peer message onto the event model with the peer identity as the source. */
export function toP2PEvent(inbound: P2PInbound): Event {
  const prefix = `[p2p from ${inbound.instance} · ${inbound.sender} · ${inbound.messageId}]`
  const text = inbound.body.length ? `${prefix} ${inbound.body}` : prefix
  return buildEvent({
    source: { kind: 'p2p', instance: inbound.instance, peer: inbound.instance, scope: 'p2p' },
    author: { senderId: inbound.sender, personId: null },
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
