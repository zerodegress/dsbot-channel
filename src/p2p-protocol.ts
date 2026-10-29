import { verifyRequest } from './p2p-auth.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { SecretRefError, resolvePeers } from './p2p-secrets.js'
import type { DedupeTable } from './p2p-dedupe.js'
import type { ChannelStats } from './channel-stats.js'

export const P2P_ROUTE = '/p2p/v1/message'

export const MAX_BODY_BYTES = 64 * 1024

export interface P2PConfig {
  botName: string
  peers: readonly PeerRef[]
  credentials: CredentialsLike
  inflightTtlMs: number
  maxBodyBytes: number
  waitMs?: number
}

export interface P2PPayload {
  eventId?: unknown
  to?: unknown
  sender?: unknown
  instance?: unknown
  body?: unknown
  sentAt?: unknown
  [key: string]: unknown
}

export interface AuthHeader {
  authorization?: string | null
  signature?: string | null
  claimedInstance: string
}

export type Parsed =
  | { ok: true; value: { eventId: string; to: string; sender: string; instance: string; body: string; sentAt: number } }
  | { ok: false; status: 400 | 413; reason: string }

export function parseRequest(payload: P2PPayload, maxBodyBytes = MAX_BODY_BYTES): Parsed {
  const { eventId, to, sender, instance, body, sentAt } = payload
  for (const [name, value] of Object.entries({ eventId, to, sender, instance, body })) {
    if (typeof value !== 'string' || value.length === 0) return { ok: false, status: 400, reason: `${name} must be a non-empty string` }
  }
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return { ok: false, status: 400, reason: 'sentAt must be a number' }
  const text = body as string
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) return { ok: false, status: 413, reason: 'body exceeds the size limit' }
  return { ok: true, value: { eventId: eventId as string, to: to as string, sender: sender as string, instance: instance as string, body: text, sentAt } }
}

export interface HandleInput {
  config: P2PConfig
  table: DedupeTable
  auth: AuthHeader
  payload: P2PPayload
  process?: (eventId: string) => Promise<boolean>
  stats?: ChannelStats | undefined
}

export type HandleResult =
  | { ok: true; status: 200; body: { duplicate: boolean; messageId: string; eventId: string } }
  | { ok: false; status: 400 | 401 | 403 | 413 | 503; body: { error: string } }

function messageIdFor(eventId: string): string {
  return `p2p-${eventId}`
}

export async function handleMessage(input: HandleInput): Promise<HandleResult> {
  const { config, table, auth, payload } = input
  const parsed = parseRequest(payload, config.maxBodyBytes)
  if (!parsed.ok) return { ok: false, status: parsed.status, body: { error: parsed.reason } }
  const request = parsed.value

  let resolved
  try {
    resolved = await resolvePeers(config.peers, config.credentials)
  } catch (error) {
    if (error instanceof SecretRefError) return { ok: false, status: 401, body: { error: 'peer secret is not configured' } }
    throw error
  }
  const verified = verifyRequest({
    peers: resolved,
    authorization: auth.authorization ?? null,
    signature: auth.signature ?? null,
    claimedInstance: auth.claimedInstance,
    eventId: request.eventId,
    sentAt: request.sentAt,
    body: request.body,
  })
  if (!verified.ok) {
    input.stats?.rejected(verified.reason ?? 'unauthorized')
    return { ok: false, status: verified.status ?? 401, body: { error: verified.reason ?? 'unauthorized' } }
  }
  input.stats?.authenticated()
  if (request.instance !== verified.instance) return { ok: false, status: 403, body: { error: 'instance does not match the bound secret' } }
  if (request.to !== config.botName) return { ok: false, status: 403, body: { error: 'message is addressed to another bot' } }

  const key = `${request.instance}|${request.to}|${request.eventId}`
  const stats = input.stats
  stats?.beginDelivery()
  try {
    const claim = await table.claim(key, config.waitMs ?? 10_000)
    if (claim.done) {
      if (!claim.entry) return { ok: false, status: 503, body: { error: 'the first delivery is still being processed' } }
      return { ok: true, status: 200, body: { duplicate: true, messageId: claim.entry.messageId, eventId: request.eventId } }
    }

    const messageId = messageIdFor(request.eventId)
    try {
      if (input.process) await input.process(request.eventId)
      table.commit(key, messageId)
    } catch (error) {
      table.abort(key)
      throw error
    }
    return { ok: true, status: 200, body: { duplicate: false, messageId, eventId: request.eventId } }
  } finally {
    stats?.endDelivery()
  }
}
