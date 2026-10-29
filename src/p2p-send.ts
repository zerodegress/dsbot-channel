import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { canonicalEnvelope, signEnvelope } from './p2p-auth.js'
import { SecretRefError, resolvePeers } from './p2p-secrets.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { P2P_ROUTE } from './p2p-protocol.js'

export const DEFAULT_SEND_TIMEOUT_MS = 10_000

export type SendFailureCode = 'no_url' | 'credential' | 'unreachable' | 'timeout' | 'unauthorized' | 'forbidden' | 'busy' | 'rejected'

export interface PeerTarget extends PeerRef {
  url?: string
  /** Sent as the Host header, for a peer reached by address behind a name router.
   *  http only: https checks the certificate against the url host, not this header. */
  host?: string
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
  /** Marks the message as a refusal; the peer runs no answer for it. */
  status?: 'declined'
  reason?: string
  final?: boolean
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

interface Answer {
  status: number
  body: unknown
}

/** Posts the signed bytes with an explicit Host header, which fetch refuses to set. */
function postWithHost(
  url: string,
  host: string,
  payload: string,
  signature: string,
  timeoutMs: number,
): Promise<Answer | SendFailure> {
  return new Promise((resolve) => {
    const target = new URL(url)
    const send = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = send(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname.replace(/\/$/, '')}${P2P_ROUTE}`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload),
          'x-p2p-signature': signature,
          host,
        },
        signal: AbortSignal.timeout(timeoutMs),
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8')
          let body: unknown
          try {
            body = raw.length === 0 ? {} : JSON.parse(raw)
          } catch {
            resolve(failure('rejected', false, `the peer answered ${response.statusCode ?? 0} without json`))
            return
          }
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    request.on('error', (error: { name?: string; code?: string }) => {
      if (error.name === 'AbortError' || error.name === 'TimeoutError' || error.code === 'ABORT_ERR') {
        resolve(failure('timeout', true, 'the peer did not answer in time'))
        return
      }
      resolve(failure('unreachable', true, 'the peer could not be reached'))
    })
    request.end(payload)
  })
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
    if (error instanceof SecretRefError) return failure('credential', false, error.message)
    throw error
  }

  const sentAt = input.sentAt ?? Date.now()
  const envelope = {
    eventId: input.eventId,
    to: input.to,
    sender: input.sender,
    instance: input.instance,
    body: input.body,
    sentAt,
    ...(input.status === undefined ? {} : { status: input.status }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.final === undefined ? {} : { final: input.final }),
  }
  const signature = signEnvelope(secret, envelope)
  const payload = canonicalEnvelope(envelope)
  const timeoutMs = input.timeoutMs ?? DEFAULT_SEND_TIMEOUT_MS

  let answered: Answer | SendFailure
  if (input.peer.host === undefined) {
    const send = input.fetchImpl ?? fetch
    try {
      const response = await send(`${url.replace(/\/$/, '')}${P2P_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-p2p-signature': signature },
        body: payload,
        signal: AbortSignal.timeout(timeoutMs),
      })
      let parsed: unknown
      try {
        parsed = await response.json()
      } catch {
        return failure('rejected', false, `the peer answered ${response.status} without json`)
      }
      answered = { status: response.status, body: parsed }
    } catch (error) {
      const name = (error as { name?: string }).name
      if (name === 'TimeoutError' || name === 'AbortError') return failure('timeout', true, 'the peer did not answer in time')
      return failure('unreachable', true, 'the peer could not be reached')
    }
  } else {
    answered = await postWithHost(url, input.peer.host, payload, signature, timeoutMs)
  }

  if (!('status' in answered)) return answered
  const body = answered.body as { messageId?: string; duplicate?: boolean; error?: string }
  if (answered.status === 200) {
    return { ok: true, messageId: body.messageId ?? `p2p-${input.eventId}`, duplicate: body.duplicate === true }
  }
  if (answered.status === 401) return failure('unauthorized', false, body.error ?? 'unauthorized')
  if (answered.status === 403) return failure('forbidden', false, body.error ?? 'forbidden')
  if (answered.status === 503) return failure('busy', true, body.error ?? 'the peer is still working on this event')
  return failure('rejected', answered.status >= 500, body.error ?? `the peer answered ${answered.status}`)
}
