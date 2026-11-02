import { createHash, timingSafeEqual } from 'node:crypto'

export interface PeerSecret {
  instance: string
  secret: string
}

export interface AuthResult {
  ok: boolean
  instance?: string | undefined
  status?: 401 | 403 | undefined
  reason?: string | undefined
}

/** Everything the signature covers, in the order both sides build it. */
export interface Envelope {
  eventId: string
  /** The root event of the conversation this message belongs to; signed like eventId. */
  chainId: string
  to: string
  sender: string
  instance: string
  body: string
  sentAt: number
  status?: string | undefined
  reason?: string | undefined
  final?: boolean | undefined
  inReplyTo?: string | undefined
  inReplyToExcerpt?: string | undefined
  /** Only present when the message carries media, so a text-only envelope keeps its old bytes. */
  media?: readonly (readonly [string, string])[] | undefined
}

export interface AuthInput {
  peers: readonly PeerSecret[]
  signature?: string | null | undefined
  claimedInstance: string
  envelope?: Envelope | undefined
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}


/** The bytes a signature covers: every field of the envelope, in one fixed order. */
export function canonicalEnvelope(envelope: Envelope): string {
  return JSON.stringify({
    eventId: envelope.eventId,
    chainId: envelope.chainId,
    to: envelope.to,
    sender: envelope.sender,
    instance: envelope.instance,
    body: envelope.body,
    sentAt: envelope.sentAt,
    ...(envelope.status === undefined ? {} : { status: envelope.status }),
    ...(envelope.reason === undefined ? {} : { reason: envelope.reason }),
    ...(envelope.final === undefined ? {} : { final: envelope.final }),
    ...(envelope.inReplyTo === undefined ? {} : { inReplyTo: envelope.inReplyTo }),
    ...(envelope.inReplyToExcerpt === undefined ? {} : { inReplyToExcerpt: envelope.inReplyToExcerpt }),
    ...(envelope.media === undefined || envelope.media.length === 0 ? {} : { media: envelope.media }),
  })
}

export function signEnvelope(secret: string, envelope: Envelope): string {
  return createHash('sha256').update(`${secret}.${canonicalEnvelope(envelope)}`, 'utf8').digest('base64')
}

/** Resolves the peer instance from the credential, never from the request body. */
export function verifyRequest(input: AuthInput): AuthResult {
  if (!input.peers.length) throw new Error('p2p: at least one peer secret is required to start')

  if (!input.signature || input.envelope === undefined) return { ok: false, status: 401, reason: 'missing signature' }
  for (const peer of input.peers) {
    const expected = signEnvelope(peer.secret, input.envelope)
    if (sameSecret(expected, input.signature)) {
      if (input.claimedInstance && input.claimedInstance !== peer.instance) {
        return { ok: false, status: 403, reason: 'instance does not match the signing key' }
      }
      return { ok: true, instance: peer.instance }
    }
  }
  return { ok: false, status: 401, reason: 'bad signature' }
}
