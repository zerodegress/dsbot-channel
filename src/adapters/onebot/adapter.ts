import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AdapterStatus } from '../../adapter-status.js'
import { buildListenerHealth, buildStatus } from '../../adapter-status.js'
import { answerStatus } from '../shared/status-route.js'
import type { ChannelSnapshot } from '../../channel-stats.js'
import { ChannelStats, countersOf } from '../../channel-stats.js'
import { ConfigError } from '../../config.js'
import type {
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  SendFailure,
  SendInput,
  SendResult,
} from '../../contract.js'
import { MEDIA_HANDLE_MAX } from '../../event-types.js'
import type { AuthorKind, MediaRef, Mentioned, Scope } from '../../event-types.js'
import { buildEvent } from '../../event-build.js'

export interface OneBotAdapterConfig {
  channel: string
  instance: string
  botName: string
  selfId?: string
  listen: { host: string; port: number; path: string }
  api: { url: string; timeoutMs: number }
  sendTimeoutMs: number
  accessToken?: string
  bots: readonly string[]
  /** Whether this adapter answers its own status route. */
  status?: boolean | undefined
}

export interface OneBotEvent {
  post_type?: unknown
  message_type?: unknown
  sub_type?: unknown
  self_id?: unknown
  message_id?: unknown
  user_id?: unknown
  group_id?: unknown
  time?: unknown
  raw_message?: unknown
  message?: unknown
  sender?: { nickname?: unknown; card?: unknown }
}

export const ONEBOT_PEER_GUIDANCE =
  'This is a private OneBot message. Answer it with your reply as usual. If it needs no answer, call no_reply instead of staying silent. If you refuse it, call decline with a short reason.'

export const ONEBOT_GROUP_GUIDANCE =
  'This is a group message from OneBot. Your reply is posted back to that group. If it needs no answer, call no_reply; if you refuse it, call decline with a short reason.'

export const ONEBOT_STATUS_ROUTE = '/onebot/status'

export const ONEBOT_DEDUPE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const ONEBOT_DEDUPE_LIMIT = 100_000
export const ONEBOT_CHAIN_TTL_MS = 60 * 60 * 1000
export const ONEBOT_CHAIN_LIMIT = 10_000
export const ONEBOT_MAX_BODY_BYTES = 1024 * 1024

const MEDIA_FOR_SEGMENT: Record<string, MediaRef['type']> = {
  image: 'image',
  record: 'voice',
  file: 'file',
}

function idOf(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'string' && value.length > 0) return value
  return undefined
}

function segmentText(segments: unknown): string {
  if (!Array.isArray(segments)) return ''
  return segments
    .filter((segment) => segment !== null && typeof segment === 'object' && (segment as { type?: unknown }).type === 'text')
    .map((segment) => String((segment as { data?: { text?: unknown } }).data?.text ?? ''))
    .join('')
}

function mentionsOf(segments: unknown, selfId: string | undefined): Mentioned {
  const mentioned: Mentioned = { self: false, others: false, all: false }
  if (!Array.isArray(segments)) return mentioned
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue
    const one = segment as { type?: unknown; data?: { qq?: unknown } }
    if (one.type !== 'at') continue
    const qq = idOf(one.data?.qq)
    if (qq === undefined) continue
    if (qq === 'all') mentioned.all = true
    else if (selfId !== undefined && qq === selfId) mentioned.self = true
    else mentioned.others = true
  }
  return mentioned
}

/** A handle must be one printable line; a bad one becomes null instead of failing the message. */
function handleOf(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  if (Array.from(value).length > MEDIA_HANDLE_MAX) return null
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) return null
  }
  return value
}

function mediaOf(segments: unknown): { media: MediaRef[]; dropped: number } {
  const media: MediaRef[] = []
  let dropped = 0
  if (!Array.isArray(segments)) return { media, dropped }
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue
    const one = segment as { type?: unknown; data?: Record<string, unknown> }
    const type = typeof one.type === 'string' ? MEDIA_FOR_SEGMENT[one.type] : undefined
    if (type === undefined) continue
    const url = typeof one.data?.url === 'string' && one.data.url.length > 0 ? one.data.url : null
    const handle = handleOf(one.data?.file)
    if (url === null && handle === null) {
      dropped += 1
      continue
    }
    media.push({ type, url, handle })
  }
  return { media, dropped }
}

function replyIdOf(segments: unknown): string | undefined {
  if (!Array.isArray(segments)) return undefined
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue
    const one = segment as { type?: unknown; data?: { id?: unknown } }
    if (one.type !== 'reply') continue
    const id = idOf(one.data?.id)
    if (id !== undefined) return id
  }
  return undefined
}

/** Maps one OneBot event onto the inbound message core takes; returns undefined for a non-message event. */
export function mapOneBotEvent(
  event: OneBotEvent,
  config: OneBotAdapterConfig,
  chainOf: (messageId: string) => string | undefined,
  warn?: (message: string) => void,
  now: () => number = Date.now,
): InboundMessage | undefined {
  if (event.post_type !== 'message') return undefined
  if (event.message_type !== 'group' && event.message_type !== 'private') return undefined
  const messageId = idOf(event.message_id)
  const eventSelf = idOf(event.self_id)
  if (config.selfId !== undefined && eventSelf !== undefined && eventSelf !== config.selfId) {
    warn?.(
      `dsbot-channel: dropped an onebot event for account ${eventSelf}: this adapter answers for ${config.selfId}`,
    )
    return undefined
  }
  const selfId = config.selfId ?? eventSelf
  if (messageId === undefined || selfId === undefined) return undefined
  const scope: Scope = event.message_type === 'group' ? 'group' : 'c2c'
  const target = scope === 'group' ? idOf(event.group_id) : idOf(event.user_id)
  const senderId = idOf(event.user_id)
  if (target === undefined || senderId === undefined) return undefined
  const replyTo = replyIdOf(event.message)
  const ownKey = `${scope}:${target}:${messageId}`
  const chainId = replyTo === undefined ? ownKey : chainOf(replyTo) ?? ownKey
  const rawText = segmentText(event.message)
  const { media, dropped } = mediaOf(event.message)
  if (dropped > 0) {
    warn?.(`dsbot-channel: dropped ${dropped} onebot media reference(s) from ${messageId} that carried neither a url nor a usable handle`)
  }
  const nickname = typeof event.sender?.card === 'string' && event.sender.card.length > 0
    ? event.sender.card
    : typeof event.sender?.nickname === 'string'
      ? event.sender.nickname
      : ''
  const kind: AuthorKind = config.bots.includes(senderId) ? 'bot' : 'person'
  const head = `[onebot from ${nickname.length === 0 ? senderId : nickname} · ${senderId} · ${messageId}]`
  const body = rawText.length === 0 ? head : `${head} ${rawText}`
  const built = buildEvent({
    source: { kind: 'onebot', instance: config.instance, peer: target, scope },
    author: { senderId, kind, personId: null },
    body: { text: body, media, replyTo: replyTo ?? null },
    transport: {
      messageId,
      timestamp: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * 1000 : Date.now(),
      mentioned: mentionsOf(event.message, selfId),
      isReply: replyTo !== undefined,
      signature: null,
    },
    declared: { nickname, avatar: '', claimedIdentity: null },
  })
  return {
    eventKey: ownKey,
    chainId,
    sessionKey: `${scope === 'group' ? 'group' : 'peer'}:${target}`,
    replyTarget: `${scope === 'group' ? 'group' : 'peer'}:${target}`,
    requestId: messageId,
    source: built.source,
    author: built.author,
    rawText,
    body: built.body,
    transport: built.meta.transport,
    declared: built.meta.declared,
    receivedAt: now(),
  }
}

class Seen {
  readonly #seen = new Map<string, number>()
  readonly #now: () => number
  readonly #ttlMs: number
  readonly #limit: number

  constructor(ttlMs: number, limit: number, now: () => number) {
    this.#ttlMs = ttlMs
    this.#limit = limit
    this.#now = now
  }

  /** True when this key was already recorded inside the window; records it otherwise. */
  claim(key: string): boolean {
    const at = this.#now()
    const seen = this.#seen.get(key)
    if (seen !== undefined) {
      this.#seen.delete(key)
      if (at - seen < this.#ttlMs) {
        this.#seen.set(key, seen)
        return true
      }
    }
    this.#seen.set(key, at)
    while (this.#seen.size > this.#limit) {
      const oldest = this.#seen.keys().next()
      if (oldest.done === true) break
      this.#seen.delete(oldest.value)
    }
    return false
  }

  get size(): number {
    return this.#seen.size
  }

  prune(): void {
    const at = this.#now()
    for (const [key, seen] of this.#seen) {
      if (at - seen >= this.#ttlMs) this.#seen.delete(key)
    }
  }
}

/** The OneBot 11 transport: events arrive over reverse HTTP, replies call the implementation's HTTP API. */
export class OneBotAdapter implements ChannelAdapter {
  readonly kind = 'onebot'
  readonly guidance = { peer: ONEBOT_PEER_GUIDANCE, group: ONEBOT_GROUP_GUIDANCE }
  readonly capabilities = {
    text: true,
    image: false,
    file: false,
    voice: false,
    recall: false,
    history: false,
    mention: true,
    reply: true,
    stream: false,
  }
  readonly #config: OneBotAdapterConfig
  readonly #stats: ChannelStats
  readonly #now: () => number
  readonly #dedupe: Seen
  readonly #chainRoot = new Map<string, string>()
  #ports: AdapterPorts | undefined
  #server: Server | undefined
  #warn: ((message: string) => void) | undefined

  constructor(config: OneBotAdapterConfig, options: { warn?: (message: string) => void; now?: () => number } = {}) {
    this.#config = config
    this.#stats = new ChannelStats(options.now)
    this.#now = options.now ?? Date.now
    this.#warn = options.warn
    this.#dedupe = new Seen(ONEBOT_DEDUPE_TTL_MS, ONEBOT_DEDUPE_LIMIT, this.#now)
  }

  get snapshot(): ChannelSnapshot {
    return this.#stats.snapshot()
  }

  checkConfig(): void {
    if (this.#config.accessToken !== undefined && this.#config.accessToken.trim().length === 0) {
      throw new ConfigError('transport.accessToken must name a credential', ['adapters', 'transport', 'accessToken'])
    }
  }

  checkSessionKey(key: string): string | undefined {
    return this.#targetProblem(key, 'session key')
  }

  checkTarget(target: string): string | undefined {
    return this.#targetProblem(target, 'target')
  }

  describeTargets(): string {
    return 'group:<id> or peer:<id>'
  }

  status(): AdapterStatus {
    const snapshot = this.#stats.snapshot()
    const listening = snapshot.state === 'listening'
    return buildStatus({
      channel: this.#config.channel,
      account: this.#config.instance,
      bot: this.#config.botName,
      health: buildListenerHealth({
        listenState: listening ? 'listening' : snapshot.state === 'failed' ? 'failed' : 'stopped',
        boundPort: snapshot.boundPort,
        lastAuthenticatedAt: snapshot.lastAuthenticatedAt,
        lastFailure: snapshot.lastFailure,
        queueDepth: snapshot.inFlight,
      }),
      counters: countersOf(snapshot),
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: snapshot.sampledAt,
      queueDepth: snapshot.inFlight,
    })
  }

  async send(input: SendInput): Promise<SendResult> {
    const target = this.#parseTarget(input.target)
    if (target === undefined) {
      return { ok: false, code: 'no_url', retryable: false, reason: `this adapter cannot address "${input.target}"` }
    }
    const action = target.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = target.scope === 'group'
      ? { group_id: target.id, message: input.body }
      : { user_id: target.id, message: input.body }
    const answered = await this.#call(action, params, input.timeoutMs)
    if (!answered.ok) {
      this.#stats.sendFailed(answered.code)
      return answered
    }
    this.#rememberChain(String(answered.messageId), input.chainId ?? input.eventId)
    return answered
  }

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    this.#ports = ports
    if (this.#config.accessToken !== undefined) {
      const token = await ports.resolveSecret(this.#config.accessToken)
      if (token === undefined) {
        throw new ConfigError('transport.accessToken names a credential that did not resolve', [
          'adapters',
          'transport',
          'accessToken',
        ])
      }
    }
    const server = createServer((request, response) => {
      void this.#handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#config.listen.port, this.#config.listen.host, () => {
        server.off('error', reject)
        resolve()
      })
    }).catch((error: unknown) => {
      this.#stats.failed(error instanceof Error ? error.message : String(error))
      throw error
    })
    this.#server = server
    this.#stats.listening((server.address() as AddressInfo).port)
    return {
      stop: async () => {
        await new Promise<void>((resolve) => server.close(() => resolve()))
        this.#stats.closed()
      },
      address: () => ({ port: (server.address() as AddressInfo).port }),
    }
  }

  /** Stops the listener without going through the handle, for tests and for a failed mount. */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#stats.closed()
  }

  #rememberChain(messageId: string, chainId: string): void {
    this.#chainRoot.set(messageId, chainId)
    while (this.#chainRoot.size > ONEBOT_CHAIN_LIMIT) {
      const oldest = this.#chainRoot.keys().next()
      if (oldest.done === true) break
      this.#chainRoot.delete(oldest.value)
    }
  }

  #targetProblem(value: string, label: string): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return `${label} must be a non-empty string`
    if (this.#parseTarget(value) === undefined) return `${label} must look like group:<id> or peer:<id>: "${value}"`
    return undefined
  }

  #parseTarget(value: string): { scope: 'group' | 'c2c'; id: string } | undefined {
    const match = /^(group|peer):([0-9A-Za-z_-]+)$/.exec(value)
    if (match === null) return undefined
    return { scope: match[1] === 'group' ? 'group' : 'c2c', id: match[2] as string }
  }

  async #call(
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<{ ok: true; messageId: string; duplicate: false } | { ok: false; code: SendFailure['code']; retryable: boolean; reason: string }> {
    const ports = this.#ports
    if (ports === undefined) return { ok: false, code: 'unreachable', retryable: true, reason: 'the onebot adapter is not started' }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      return { ok: false, code: 'credential', retryable: false, reason: 'the onebot access token did not resolve' }
    }
    let response: Response
    try {
      response = await fetch(`${this.#config.api.url}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs ?? this.#config.sendTimeoutMs),
      })
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return {
        ok: false,
        code: timeout ? 'timeout' : 'unreachable',
        retryable: true,
        reason: timeout ? 'the onebot api did not answer in time' : `the onebot api is unreachable: ${String(error)}`,
      }
    }
    let parsed: { status?: unknown; retcode?: unknown; data?: { message_id?: unknown }; message?: unknown }
    try {
      parsed = (await response.json()) as typeof parsed
    } catch {
      return { ok: false, code: 'rejected', retryable: response.status >= 500, reason: `the api answered ${response.status} without json` }
    }
    if (response.status === 401 || response.status === 403 || parsed.retcode === 1403) {
      return { ok: false, code: 'unauthorized', retryable: false, reason: this.#oneLine(parsed.message ?? 'unauthorized') }
    }
    if (!response.ok || (parsed.retcode !== undefined && parsed.retcode !== 0)) {
      return {
        ok: false,
        code: response.status >= 500 ? 'unreachable' : 'rejected',
        retryable: response.status >= 500,
        reason: this.#oneLine(parsed.message ?? `the api answered ${response.status}`),
      }
    }
    const messageId = idOf(parsed.data?.message_id)
    if (messageId === undefined) return { ok: false, code: 'rejected', retryable: false, reason: 'the api answered without a message id' }
    return { ok: true, messageId, duplicate: false }
  }

  #oneLine(value: unknown): string {
    return String(value).replace(/\s+/g, ' ').trim().slice(0, 200)
  }

  async #authorized(request: IncomingMessage): Promise<boolean> {
    if (this.#config.accessToken === undefined) return true
    const expected = await this.#ports?.resolveSecret(this.#config.accessToken)
    if (expected === undefined || expected.length === 0) return false
    const header = request.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^(?:Bearer|Token)\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const offered = Buffer.from(match[1] as string, 'utf8')
    const secret = Buffer.from(expected, 'utf8')
    return offered.length === secret.length && timingSafeEqual(offered, secret)
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (
      this.#config.status !== false &&
      answerStatus(request, response, {
        route: ONEBOT_STATUS_ROUTE,
        report: () => this.status(),
        onRefused: () => this.#stats.unknownPath(),
      })
    ) {
      return
    }
    const url = request.url ?? '/'
    if (request.method !== 'POST' || url !== this.#config.listen.path) {
      this.#stats.unknownPath()
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"status":"failed","retcode":1404,"message":"not found"}')
      return
    }
    if (!(await this.#authorized(request))) {
      this.#stats.authFailure()
      this.#stats.rejected('unauthorized')
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end('{"status":"failed","retcode":1403,"message":"unauthorized"}')
      return
    }
    const raw = await this.#readBody(request)
    if (raw === undefined) {
      response.writeHead(413, { 'content-type': 'application/json' })
      response.end('{"status":"failed","retcode":1404,"message":"body too large"}')
      return
    }
    let event: OneBotEvent
    try {
      event = JSON.parse(raw) as OneBotEvent
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end('{"status":"failed","retcode":1400,"message":"body must be json"}')
      return
    }
    // OneBot implementations resend a non-2xx answer, so every event is accepted or dropped here, not refused.
    response.writeHead(204)
    response.end()
    const message = mapOneBotEvent(
      event,
      this.#config,
      (messageId) => this.#chainRoot.get(messageId),
      this.#warn,
      this.#now,
    )
    if (message === undefined) return
    if (this.#dedupe.claim(`${message.source.scope}:${message.replyTarget}:${message.requestId}`)) {
      this.#warn?.(`dsbot-channel: kept a repeated onebot message ${message.requestId} from ${message.replyTarget} out of a turn`)
      return
    }
    this.#rememberChain(message.requestId, message.chainId)
    const ports = this.#ports
    if (ports === undefined) return
    try {
      const verdict = await ports.onMessage(message)
      if (!verdict.ok) {
        this.#warn?.(`dsbot-channel: kept ${message.requestId} from ${message.replyTarget} out of a turn: ${verdict.code} ${verdict.reason}`)
      }
    } catch (error) {
      this.#warn?.(`dsbot-channel: handing off ${message.requestId} failed: ${String(error)}`)
    }
  }

  #readBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const settle = (value: string | undefined): void => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > ONEBOT_MAX_BODY_BYTES) {
          chunks.length = 0
          settle(undefined)
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => settle(Buffer.concat(chunks).toString('utf8')))
      request.on('error', () => settle(undefined))
    })
  }
}
