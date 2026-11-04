import { verifyRequest } from './p2p-auth.js'
import type { CredentialsLike, PeerRef } from './p2p-secrets.js'
import { SecretRefError, resolvePeers } from './p2p-secrets.js'
import type { DedupeTable } from './p2p-dedupe.js'
import type { ChannelStats } from '../../channel-stats.js'
import { EXCERPT_CHARS } from './p2p-mapping.js'
import { MEDIA_TYPES, mediaNameProblem } from '../../event-types.js'
import type { P2PMediaItem } from './p2p-wire.js'

export const P2P_ROUTE = '/p2p/v1/message'

export const MAX_BODY_BYTES = 64 * 1024

export const DEFAULT_SENT_AT_WINDOW_MS = 300_000

/** The reference is a token, not free text: it lands in a header line. */
export const IN_REPLY_TO_MAX = 128

/** An event id is a token the adapter builds; a reply's own id stays this short. */
export const EVENT_ID_MAX = 256

/** A chain root is an event id, so it gets the same room. */
export const CHAIN_ID_MAX = 256

export const MEDIA_MAX_ITEMS = 16
export const MEDIA_URL_MAX = 2048
export const MEDIA_TOTAL_MAX = 8 * 1024

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
  warn?: (message: string) => void
}

export interface P2PPayload {
  eventId?: unknown
  to?: unknown
  sender?: unknown
  instance?: unknown
  body?: unknown
  media?: unknown
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
  chainId: string
  to: string
  sender: string
  instance: string
  body: string
  media: readonly P2PMediaItem[]
  sentAt: number
  status?: typeof DECLINED
  reason?: string
  final?: boolean
  inReplyTo?: string
  inReplyToExcerpt?: string
}

export type Parsed =
  | { ok: true; value: ParsedMessage }
  | { ok: false; status: 400 | 401 | 413; reason: string; protocolMismatch?: boolean }

export function parseRequest(payload: P2PPayload, maxBodyBytes = MAX_BODY_BYTES): Parsed {
  const { eventId, to, sender, instance, body, sentAt } = payload
  const parsed = parseMedia(payload.media)
  if (!parsed.ok) return { ok: false, status: 400, reason: parsed.reason }
  // An empty body is accepted only when the request carries media; a message with neither is refused.
  const carriesMedia = parsed.value.length > 0
  for (const [name, value] of Object.entries({ eventId, to, sender, instance, body })) {
    if (name === 'body' && carriesMedia && typeof value === 'string') continue
    if (typeof value !== 'string' || value.length === 0) return { ok: false, status: 400, reason: `${name} must be a non-empty string` }
  }
  if (typeof sentAt !== 'number' || !Number.isFinite(sentAt)) return { ok: false, status: 400, reason: 'sentAt must be a number' }
  if ((eventId as string).length > EVENT_ID_MAX || !isToken(eventId as string)) {
    return { ok: false, status: 400, reason: `eventId must be a token of at most ${EVENT_ID_MAX} characters` }
  }
  if (!isToken(sender as string)) {
    return { ok: false, status: 400, reason: 'sender must be a token: printable characters, no whitespace' }
  }
  const text = typeof body === 'string' ? body : ''
  if (Buffer.byteLength(text, 'utf8') > maxBodyBytes) return { ok: false, status: 413, reason: 'body exceeds the size limit' }
  const status = payload.status
  if (status !== undefined && status !== DECLINED) {
    return { ok: false, status: 400, reason: `status must be "${DECLINED}" when it is present` }
  }
  const reason = payload.reason
  if (reason !== undefined && typeof reason !== 'string') return { ok: false, status: 400, reason: 'reason must be a string' }
  const final = payload.final
  if (final !== undefined && typeof final !== 'boolean') return { ok: false, status: 400, reason: 'final must be a boolean' }
  const chainId = payload.chainId
  if (chainId === undefined) {
    return {
      ok: false,
      status: 401,
      reason: 'chainId is required: this peer speaks the chain-root protocol',
      protocolMismatch: true,
    }
  }
  if (typeof chainId !== 'string' || !isToken(chainId) || chainId.length > CHAIN_ID_MAX) {
    return { ok: false, status: 400, reason: `chainId must be a token of at most ${CHAIN_ID_MAX} characters` }
  }
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
      chainId,
      to: to as string,
      sender: sender as string,
      instance: instance as string,
      body: text,
      media: parsed.value,
      sentAt,
      ...(status === undefined ? {} : { status }),
      ...(reason === undefined ? {} : { reason }),
      ...(final === undefined ? {} : { final }),
      ...(inReplyTo === undefined ? {} : { inReplyTo }),
      ...(inReplyToExcerpt === undefined ? {} : { inReplyToExcerpt }),
    },
  }
}

/** Media is a list of [type, url, name?] items; anything else is refused whole, never trimmed. */
function parseMedia(raw: unknown): { ok: true; value: readonly P2PMediaItem[] } | { ok: false; reason: string } {
  if (raw === undefined) return { ok: true, value: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: 'media must be an array of [type, url] or [type, url, name] items' }
  if (raw.length > MEDIA_MAX_ITEMS) return { ok: false, reason: `media carries at most ${MEDIA_MAX_ITEMS} items` }
  const value: P2PMediaItem[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || (item.length !== 2 && item.length !== 3)) {
      return { ok: false, reason: 'each media item must be a [type, url] or [type, url, name] item' }
    }
    const [type, url, name] = item as [unknown, unknown, unknown?]
    if (typeof type !== 'string' || !(MEDIA_TYPES as readonly string[]).includes(type)) {
      return { ok: false, reason: `media type must be one of ${MEDIA_TYPES.join(', ')}` }
    }
    if (typeof url !== 'string' || url.length === 0 || url.length > MEDIA_URL_MAX || !/^https?:\/\/[^\s]+$/i.test(url)) {
      return { ok: false, reason: `media url must be an http(s) address of at most ${MEDIA_URL_MAX} characters` }
    }
    if (item.length === 2) {
      value.push([type, url])
      continue
    }
    const nameProblem = mediaNameProblem(name)
    if (nameProblem !== undefined) return { ok: false, reason: nameProblem }
    value.push([type, url, name as string])
  }
  if (JSON.stringify(value).length > MEDIA_TOTAL_MAX) return { ok: false, reason: `media must fit in ${MEDIA_TOTAL_MAX} bytes` }
  return { ok: true, value }
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
  if (!parsed.ok) {
    if (parsed.protocolMismatch) input.stats?.protocolMismatch()
    return {
      ok: false,
      status: parsed.status,
      body: { error: parsed.reason, ...(parsed.protocolMismatch ? { code: 'protocol_mismatch' } : {}) },
    }
  }
  const request = parsed.value
  const roster = config.peers.map((peer) => peer.instance)
  if (!roster.includes(request.instance)) {
    const firstForInstance = input.stats === undefined || input.stats.unknownInstance(request.instance)
    if (firstForInstance) {
      config.warn?.(
        `dsbot-channel: refused a message from unknown instance "${request.instance}" for ${config.botName}; ` +
          `configured peers are ${roster.join(', ')}`,
      )
    }
  }

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
  const skewMs = request.sentAt - at
  input.stats?.skew(skewMs)
  if (Math.abs(skewMs) > window) {
    const sender = verified.instance ?? request.instance
    const firstForInstance = input.stats === undefined || input.stats.stale(sender)
    if (firstForInstance) {
      config.warn?.(
        `dsbot-channel: refused a message from ${sender} for ${config.botName}: ` +
          `sentAt is ${skewMs}ms from the local clock, outside the ${window}ms window`,
      )
    }
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
