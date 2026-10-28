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

export interface AuthInput {
  peers: readonly PeerSecret[]
  authorization?: string | null | undefined
  signature?: string | null | undefined
  claimedInstance: string
  eventId?: string | undefined
  sentAt?: number | undefined
  body?: string | undefined
}

function sameSecret(a: string, b: string): boolean {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}

export function digestBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

export function signBody(secret: string, input: { eventId: string; sentAt: number; body: string }): string {
  const payload = `${input.eventId}.${input.sentAt}.${digestBody(input.body)}`
  return createHash('sha256').update(`${secret}.${payload}`, 'utf8').digest('hex')
}

/** Resolves the peer instance from the credential, never from the request body. */
export function verifyRequest(input: AuthInput): AuthResult {
  if (!input.peers.length) throw new Error('p2p: at least one peer secret is required to start')

  if (input.signature) {
    const payload = `${input.eventId ?? ''}.${input.sentAt ?? 0}.${digestBody(input.body ?? '')}`
    for (const peer of input.peers) {
      const expected = createHash('sha256').update(`${peer.secret}.${payload}`, 'utf8').digest('hex')
      if (sameSecret(expected, input.signature)) {
        if (input.claimedInstance && input.claimedInstance !== peer.instance) {
          return { ok: false, status: 403, reason: 'instance does not match the signing key' }
        }
        return { ok: true, instance: peer.instance }
      }
    }
    return { ok: false, status: 401, reason: 'bad signature' }
  }

  const header = input.authorization ?? ''
  if (!header.startsWith('Bearer ')) return { ok: false, status: 401, reason: 'missing bearer token' }
  const presented = header.slice('Bearer '.length)
  for (const peer of input.peers) {
    if (!sameSecret(presented, peer.secret)) continue
    if (input.claimedInstance && input.claimedInstance !== peer.instance) {
      return { ok: false, status: 403, reason: 'instance does not match the bound secret' }
    }
    return { ok: true, instance: peer.instance }
  }
  return { ok: false, status: 401, reason: 'unknown secret' }
}
