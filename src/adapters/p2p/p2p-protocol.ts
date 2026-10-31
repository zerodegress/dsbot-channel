import { verifyRequest } from './p2p-auth.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { SecretRefError, resolvePeers } from './p2p-secrets.js'
import type { DedupeTable } from './p2p-dedupe.js'
import type { ChannelStats } from '../../channel-stats.js'
import { EXCERPT_CHARS } from './p2p-mapping.js'

export const P2P_ROUTE = '/p2p/v1/message'

export const MAX_BODY_BYTES = 64 * 1024

export const DEFAULT_SENT_AT_WINDOW_MS = 300_000

/** The reference is a token, not free text: it lands in a header line. */
export const IN_REPLY_TO_MAX = 128

/** An event id grows a reply: prefix each round, so it needs more room than a token. */
export const EVENT_ID_MAX = 256

function isToken(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) return false
  }
  return true
}

export interface P2PConfig {
  botName: string
  peers: readonly PeerRef[]
  credentials: CredentialsLike
  inflightTtlMs: number
  maxBodyBytes: number
  waitMs?: number
  sentAtWindowMs?: number
  now?: () => number
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
  signature?: string | null
  claimedInstance: string
}

export const DECLINED = 'declined'

export interface ParsedMessage {
  eventId: string
  to: string
  sender: string
  instance: string
  body: string
  sentAt: number
  status?: typeof DECLINED
  reason?: string
  final?: boolean
  inReplyTo?: string
  inReplyToExcerpt?: string
}

export type Parsed = { ok: true; value: ParsedMessage } | { ok: false; status: 400 | 413; reason: string }

export function parseRequest(payload: P2PPayload, maxBodyBytes = MAX_BODY_BYTES): Parsed {
  const { eventId, to, sender, instance, body, sentAt } = payload
  for (const [name, value] of Object.entries({ eventId, to, sender, instance, body })) {
    if (typeof value !== 'string' || value.length === 0) return { ok: false, status: 400, reason: `${name} must be a non-empty string` }
  }
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return { ok: false, status: 400, reason: 'sentAt must be a number' }
  if ((eventId as string).length > EVENT_ID_MAX || !isToken(eventId as string)) {
    return { ok: false, status: 400, reason: `eventId must be a token of at most ${EVENT_ID_MAX} characters` }
  }
  if (!isToken(sender as string)) {
    return { ok: false, status: 400, reason: 'sender must be a token: printable characters, no whitespace' }
  }
  const text = body as string
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) return { ok: false, status: 413, reason: 'body exceeds the size limit' }
  const status = payload.status
  if (status !== undefined && status !== DECLINED) {
    return { ok: false, status: 400, reason: `status must be "${DECLINED}" when it is present` }
  }
  const reason = payload.reason
  if (reason !== undefined && typeof reason !== 'string') return { ok: false, status: 400, reason: 'reason must be a string' }
  const final = payload.final
  if (final !== undefined && typeof final !== 'boolean') return { ok: false, status: 400, reason: 'final must be a boolean' }
  const inReplyTo = payload.inReplyTo
  if (inReplyTo !== undefined) {
    if (typeof inReplyTo !== 'string' || inReplyTo.length === 0 || inReplyTo.length > IN_REPLY_TO_MAX || !isToken(inReplyTo)) {
      return { ok: false, status: 400, reason: `inReplyTo must be a token of at most ${IN_REPLY_TO_MAX} characters` }
    }
  }
  const rawExcerpt = payload.inReplyToExcerpt
  if (rawExcerpt !== undefined && typeof rawExcerpt !== 'string') {
    return { ok: false, status: 400, reason: 'inReplyToExcerpt must be a string' }
  }
  const inReplyToExcerpt =
    rawExcerpt === undefined ? undefined : Array.from(rawExcerpt).slice(0, EXCERPT_CHARS).join('')
  return {
    ok: true,
    value: {
      eventId: eventId as string,
      to: to as string,
      sender: sender as string,
      instance: instance as string,
      body: text,
      sentAt,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
      ...(final === undefined ? {} : { final }),
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      ...(inReplyToExcerpt === undefined ? {} : { inReplyToExcerpt }),
    },
  }
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
  | {
      ok: false
      status: 400 | 401 | 403 | 413 | 503
      body: { error: string; code?: string; sentAt?: number; now?: number }
    }

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
    signature: auth.signature ?? null,
    claimedInstance: auth.claimedInstance,
    envelope: request,
  })
  if (!verified.ok) return { ok: false, status: verified.status ?? 401, body: { error: verified.reason ?? 'unauthorized' } }
  input.stats?.authenticated()
  const window = config.sentAtWindowMs ?? DEFAULT_SENT_AT_WINDOW_MS
  const at = config.now?.() ?? Date.now()
  if (Math.abs(at - request.sentAt) > window) {
    return {
      ok: false,
      status: 403,
      body: {
        error: `sentAt is outside the accepted window of ${window}ms`,
        code: 'stale_sent_at',
        sentAt: request.sentAt,
        now: at,
      },
    }
  }
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
