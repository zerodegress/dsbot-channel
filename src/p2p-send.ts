import { signBody } from './p2p-auth.js'
import { SecretRefError, resolvePeers } from './p2p-secrets.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { P2P_ROUTE } from './p2p-protocol.js'

export const DEFAULT_SEND_TIMEOUT_MS = 10_000

export type SendFailureCode = 'no_url' | 'unreachable' | 'timeout' | 'unauthorized' | 'forbidden' | 'busy' | 'rejected'

export interface PeerTarget extends PeerRef {
  url?: string
}

export interface SendInput {
  peer: PeerTarget
  credentials: CredentialsLike
  to: string
  body: string
  eventId: string
  sender: string
  instance: string
  sentAt?: number
  timeoutMs?: number
  waitMs?: number
  fetchImpl?: typeof fetch
}

export interface SendSuccess {
  ok: true
  messageId: string
  duplicate: boolean
}

export interface SendFailure {
  ok: false
  code: SendFailureCode
  retryable: boolean
  reason: string
}

export type SendResult = SendSuccess | SendFailure

function failure(code: SendFailureCode, retryable: boolean, reason: string): SendFailure {
  return { ok: false, code, retryable, reason }
}

/** Posts one signed message to a peer; the eventId doubles as the retry key. */
export async function sendToPeer(input: SendInput): Promise<SendResult> {
  const url = input.peer.url
  if (!url) return failure('no_url', false, `peer "${input.peer.instance}" has no url configured`)

  let secret: string
  try {
    const resolved = await resolvePeers([input.peer], input.credentials)
    secret = resolved[0]!.secret
  } catch (error) {
    if (error instanceof SecretRefError) return failure('unreachable', false, error.message)
    throw error
  }

  const sentAt = input.sentAt ?? Date.now()
  const signature = signBody(secret, { eventId: input.eventId, sentAt, body: input.body })
  const payload = JSON.stringify({ eventId: input.eventId, to: input.to, sender: input.sender, instance: input.instance, body: input.body, sentAt })
  const send = input.fetchImpl ?? fetch

  let response: Response
  try {
    response = await send(`${url.replace(/\/$/, '')}${P2P_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-p2p-signature': signature },
      body: payload,
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS),
    })
  } catch (error) {
    const name = (error as { name?: string }).name
    if (name === 'TimeoutError' || name === 'AbortError') return failure('timeout', true, 'the peer did not answer in time')
    return failure('unreachable', true, 'the peer could not be reached')
  }

  let parsed: unknown
  try {
    parsed = await response.json()
  } catch {
    return failure('rejected', false, `the peer answered ${response.status} without json`)
  }
  const body = parsed as { messageId?: string; duplicate?: boolean; error?: string }

  if (response.status === 200) {
    return { ok: true, messageId: body.messageId ?? `p2p-${input.eventId}`, duplicate: body.duplicate === true }
  }
  if (response.status === 401) return failure('unauthorized', false, body.error ?? 'unauthorized')
  if (response.status === 403) return failure('forbidden', false, body.error ?? 'forbidden')
  if (response.status === 503) return failure('busy', true, body.error ?? 'the peer is still working on this event')
  return failure('rejected', response.status >= 500, body.error ?? `the peer answered ${response.status}`)
}
