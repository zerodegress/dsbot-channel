import { randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AdapterStatus, CapabilitySet } from '../../adapter-status.js'
import { buildListenerHealth, buildStatus } from '../../adapter-status.js'
import { answerStatus } from '../shared/status-route.js'
import { ForwardLink } from './ws-forward.js'
import { ReverseLink } from './ws-reverse.js'
import type { ChannelSnapshot } from '../../channel-stats.js'
import { ChannelStats, countersOf } from '../../channel-stats.js'
import { ConfigError } from '../../config.js'
import type {
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  HistoryInput,
  HistoryRecord,
  HistoryResult,
  InboundMessage,
  OutboundMedia,
  SendFailure,
  SendInput,
  SendResult,
} from '../../contract.js'
import type { AuthorKind, MediaInput, MediaRef, Mentioned, Scope } from '../../event-types.js'
import { buildEvent, handleProblem } from '../../event-build.js'
import { ADAPTER_META_MAX_BYTES } from '../../adapter-meta.js'

export interface OneBotAdapterConfig {
  channel: string
  instance: string
  botName: string
  selfId?: string
  /** How this link carries OneBot; the other fields below are read per protocol. */
  protocol: 'http' | 'ws-forward' | 'ws-reverse'
  listen?: { host: string; port: number; path: string } | undefined
  api?: { url: string; timeoutMs: number } | undefined
  /** ws-forward only: the event socket; absent means events arrive on the api socket. */
  event?: { url: string } | undefined
  /** ws-forward only: how a dropped link comes back; false turns retrying off. */
  reconnect?: { initialMs: number; maxMs: number; factor: number } | false | undefined
  /** websocket protocols only: how long silence may last before the link is closed. */
  heartbeat?: { intervalMs: number; timeoutMs: number } | undefined
  /** Which addresses a profile lets this link page history for; both off unless written out. */
  history?: { group: boolean; private: boolean } | undefined
  /** Whether this implementation takes a file as an http(s) url; most only take a path on its host. */
  fileFromUrl?: boolean | undefined
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

function mediaOf(segments: unknown): { media: MediaInput[]; dropped: number } {
  const media: MediaInput[] = []
  let dropped = 0
  if (!Array.isArray(segments)) return { media, dropped }
  for (const segment of segments) {
    if (segment === null || typeof segment !== 'object') continue
    const one = segment as { type?: unknown; data?: Record<string, unknown> }
    const type = typeof one.type === 'string' ? MEDIA_FOR_SEGMENT[one.type] : undefined
    if (type === undefined) continue
    const url = typeof one.data?.url === 'string' && one.data.url.length > 0 ? one.data.url : null
    const handle = typeof one.data?.file === 'string' && one.data.file.length > 0 ? one.data.file : null
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
    warn?.(`dsbot-channel: dropped ${dropped} onebot media reference(s) from ${messageId} that carried neither a url nor a file name`)
  }
  const nickname = typeof event.sender?.card === 'string' && event.sender.card.length > 0
    ? event.sender.card
    : typeof event.sender?.nickname === 'string'
      ? event.sender.nickname
      : ''
  const kind: AuthorKind = config.bots.includes(senderId) ? 'bot' : 'person'
  const head = `[onebot from ${nickname.length === 0 ? senderId : nickname} · ${senderId} · ${messageId}]`
  const body = rawText.length === 0 ? head : `${head} ${rawText}`
  const rawMessage = typeof event.raw_message === 'string' ? event.raw_message : ''
  const payload: Record<string, unknown> = {
    rawMessage,
    messageType: event.message_type,
    ...(typeof event.sub_type === 'string' ? { subType: event.sub_type } : {}),
  }
  const oversized = Buffer.byteLength(JSON.stringify(payload), 'utf8') > ADAPTER_META_MAX_BYTES
  if (oversized) {
    warn?.(`dsbot-channel: kept the raw payload of onebot message ${messageId} out of the event: it is larger than ${ADAPTER_META_MAX_BYTES} bytes`)
  }
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
    declared: { nickname, avatar: '' },
    ...(oversized ? {} : { adapter: payload }),
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
    adapter: built.meta.adapter,
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
  readonly capabilities: CapabilitySet
  readonly #config: OneBotAdapterConfig
  readonly #stats: ChannelStats
  readonly #now: () => number
  readonly #dedupe: Seen
  readonly #chainRoot = new Map<string, string>()
  #ports: AdapterPorts | undefined
  #server: Server | undefined
  #forward: ForwardLink | undefined
  #reverse: ReverseLink | undefined
  #warn: ((message: string) => void) | undefined

  constructor(config: OneBotAdapterConfig, options: { warn?: (message: string) => void; now?: () => number } = {}) {
    this.#config = config
    this.capabilities = {
      text: true,
      image: { in: true, out: true, fromUrl: true, fromHandle: true },
      file: { in: true, out: true, fromUrl: config.fileFromUrl === true, fromHandle: true },
      voice: { in: true, out: false, fromUrl: false, fromHandle: false },
      recall: false,
      history: {
        group: config.history?.group === true,
        private: config.history?.private === true,
      },
      mention: true,
      reply: true,
      stream: false,
    }
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
    const forward = this.#forward
    return buildStatus({
      channel: this.#config.channel,
      account: this.#config.instance,
      bot: this.#config.botName,
      health: forward === undefined ? buildListenerHealth({
        listenState: listening ? 'listening' : snapshot.state === 'failed' ? 'failed' : 'stopped',
        boundPort: snapshot.boundPort,
        lastAuthenticatedAt: this.#reverse?.lastAuthenticatedAt() ?? snapshot.lastAuthenticatedAt,
        lastFailure: snapshot.lastFailure,
        queueDepth: snapshot.inFlight,
      }) : forward.health(),
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
    const file = (input.media ?? []).find((item) => item.type === 'file')
    if (file !== undefined) {
      if (input.body.length > 0) {
        this.#warn?.('dsbot-channel: dropped the text beside a file: a file send carries its name only')
      }
      return this.#sendFile(target, file, input.timeoutMs)
    }
    const message = this.#messageOf(input)
    if (message === undefined) {
      return { ok: false, code: 'rejected', retryable: false, reason: 'there is nothing this channel can carry' }
    }
    const action = target.scope === 'group' ? 'send_group_msg' : 'send_private_msg'
    const params = target.scope === 'group'
      ? { group_id: target.id, message }
      : { user_id: target.id, message }
    const answered = await this.#call(action, params, input.timeoutMs)
    if (!answered.ok) {
      this.#stats.sendFailed(answered.code)
      return answered
    }
    this.#rememberChain(String(answered.messageId), input.chainId ?? input.eventId)
    return answered
  }


  /** Pages earlier messages through the implementation's history API. */
  async history(input: HistoryInput): Promise<HistoryResult> {
    const target = this.#parseTarget(input.target)
    if (target === undefined) {
      return { ok: false, code: 'unsupported', reason: `this adapter cannot address "${input.target}"` }
    }
    const segment = target.scope === 'group' ? 'group' : 'private'
    if (this.capabilities.history[segment] !== true) {
      return { ok: false, code: 'unsupported', reason: `capabilities.history.${segment} is false` }
    }
    const action = target.scope === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history'
    const params: Record<string, unknown> = {
      ...(target.scope === 'group' ? { group_id: target.id } : { user_id: target.id }),
      count: input.limit,
      ...(input.before === undefined ? {} : { message_seq: input.before }),
    }
    const answered = await this.#historyCall(action, params)
    if (!answered.ok) return answered
    const raw = Array.isArray(answered.data.messages) ? answered.data.messages : []
    const records: HistoryRecord[] = []
    for (const entry of raw) {
      const record = this.#historyRecord(entry)
      if (record !== undefined) records.push(record)
    }
    // Oldest first, so a reader follows the conversation the way it happened.
    records.sort((left, right) => left.timestamp - right.timestamp)
    // `next` is the cursor to pass back as `before` for earlier messages: the oldest record on
    // this page, not an offset. A page without `next` means there is nothing older.
    const next = records.length > 0 && records.length >= input.limit ? records[0]!.cursor : undefined
    return { ok: true, records, ...(next === undefined ? {} : { next }) }
  }

  #historyRecord(entry: unknown): HistoryRecord | undefined {
    if (entry === null || typeof entry !== 'object') return undefined
    const one = entry as Record<string, unknown>
    const messageId = idOf(one.message_id)
    if (messageId === undefined) return undefined
    const sender = (one.sender === null || typeof one.sender !== 'object' ? {} : one.sender) as Record<string, unknown>
    const card = typeof sender.card === 'string' && sender.card.length > 0 ? sender.card : undefined
    const nickname =
      card ?? (typeof sender.nickname === 'string' && sender.nickname.length > 0 ? sender.nickname : undefined)
    const cursor = idOf(one.message_seq) ?? idOf(one.real_seq) ?? messageId
    const seconds = typeof one.time === 'number' && Number.isFinite(one.time) ? one.time : 0
    return {
      messageId,
      cursor,
      timestamp: seconds * 1000,
      senderId: idOf(sender.user_id) ?? '',
      text: segmentText(one.message),
      ...(nickname === undefined ? {} : { nickname }),
    }
  }

  async #historyCall(
    action: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: SendFailure['code']; reason: string }> {
    const ports = this.#ports
    if (ports === undefined) {
      return { ok: false, code: 'unreachable', reason: 'the onebot adapter is not started' }
    }
    if (this.#config.protocol !== 'http') {
      const socket = this.#socketLink()
      if (socket === undefined) {
        return { ok: false, code: 'unreachable', reason: 'the socket is not open' }
      }
      const answer = await socket.request(action, params, undefined)
      if (!answer.ok) {
        if (/^消息.*不存在$/.test(answer.reason)) return { ok: true, data: {} }
        if (/^记录.*不存在$/.test(answer.reason)) return { ok: false, code: 'rejected', reason: answer.reason }
        return { ok: false, code: answer.code, reason: answer.reason }
      }
      const data = answer.frame.data
      return { ok: true, data: data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {} }
    }
    const api = this.#config.api
    if (api === undefined) {
      return { ok: false, code: 'unsupported', reason: 'this protocol has no http action api' }
    }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      return { ok: false, code: 'credential', reason: 'the onebot access token did not resolve' }
    }
    let response: Response
    try {
      response = await fetch(`${api.url}/${action}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(this.#config.sendTimeoutMs),
      })
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
      return {
        ok: false,
        code: timeout ? 'timeout' : 'unreachable',
        reason: timeout ? 'the onebot api did not answer in time' : `the onebot api is unreachable: ${String(error)}`,
      }
    }
    let parsed: { status?: unknown; retcode?: unknown; data?: unknown; message?: unknown }
    try {
      parsed = (await response.json()) as typeof parsed
    } catch {
      if (response.status === 404) {
        return { ok: false, code: 'unsupported', reason: 'the implementation has no such history action' }
      }
      return { ok: false, code: 'rejected', reason: `the api answered ${response.status} without json` }
    }
    const message = this.#oneLine(parsed.message ?? '')
    if (response.status === 401 || response.status === 403 || parsed.retcode === 1403) {
      return { ok: false, code: 'unauthorized', reason: message === '' ? 'unauthorized' : message }
    }
    if (/^消息.*不存在$/.test(message)) return { ok: true, data: {} }
    if (/^记录.*不存在$/.test(message)) return { ok: false, code: 'rejected', reason: message }
    if (response.status === 404) {
      return { ok: false, code: 'unsupported', reason: message === '' ? 'the implementation has no such history action' : message }
    }
    if (!response.ok || parsed.status === 'failed' || (parsed.retcode !== undefined && parsed.retcode !== 0)) {
      return {
        ok: false,
        code: response.status >= 500 ? 'unreachable' : 'rejected',
        reason: message === '' ? `the api answered ${response.status}` : message,
      }
    }
    if (parsed.data === null || typeof parsed.data !== 'object') return { ok: true, data: {} }
    return { ok: true, data: parsed.data as Record<string, unknown> }
  }

  /** Uploads one file; the implementation takes a url only when the profile said it does. */
  async #sendFile(
    target: { scope: 'group' | 'c2c'; id: string },
    item: OutboundMedia,
    timeoutMs: number | undefined,
  ): Promise<SendResult> {
    const capability = this.capabilities.file
    if (capability.out !== true) {
      return { ok: false, code: 'unsupported', retryable: false, reason: 'this channel cannot send files' }
    }
    if (item.url !== null && capability.fromUrl !== true) {
      return {
        ok: false,
        code: 'unsupported',
        retryable: false,
        reason: 'this channel cannot take a file from a url; transport.fileFromUrl is false',
      }
    }
    const file = item.url ?? item.handle
    if (file === null) {
      return { ok: false, code: 'no_url', retryable: false, reason: 'the file names neither a url nor a handle' }
    }
    const name = item.name
    if (name === undefined || name.trim().length === 0) {
      return { ok: false, code: 'rejected', retryable: false, reason: 'a file needs a name' }
    }
    const action = target.scope === 'group' ? 'upload_group_file' : 'upload_private_file'
    const params = target.scope === 'group' ? { group_id: target.id, file, name } : { user_id: target.id, file, name }
    return this.#uploadCall(action, params, timeoutMs)
  }

  async #uploadCall(
    action: string,
    params: Record<string, unknown>,
    timeoutMs: number | undefined,
  ): Promise<SendResult> {
    const ports = this.#ports
    if (ports === undefined) {
      return { ok: false, code: 'unreachable', retryable: true, reason: 'the onebot adapter is not started' }
    }
    if (this.#config.protocol !== 'http') {
      const socket = this.#socketLink()
      if (socket === undefined) {
        return { ok: false, code: 'unreachable', retryable: true, reason: 'the socket is not open' }
      }
      const answer = await socket.request(action, params, timeoutMs)
      if (!answer.ok) {
        return { ok: false, code: answer.code, retryable: answer.code !== 'rejected', reason: answer.reason }
      }
      const data = answer.frame.data
      const payload = data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : {}
      const given = idOf(payload.file_id) ?? idOf(payload.message_id)
      return { ok: true, messageId: given ?? `local:${randomUUID()}`, duplicate: false }
    }
    const api = this.#config.api
    if (api === undefined) {
      return { ok: false, code: 'unsupported', retryable: false, reason: 'this protocol has no http action api' }
    }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      return { ok: false, code: 'credential', retryable: false, reason: 'the onebot access token did not resolve' }
    }
    let response: Response
    try {
      response = await fetch(`${api.url}/${action}`, {
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
    let parsed: { status?: unknown; data?: unknown; message?: unknown }
    try {
      parsed = (await response.json()) as typeof parsed
    } catch {
      if (response.status === 404) {
        return { ok: false, code: 'unsupported', retryable: false, reason: 'the implementation has no upload action' }
      }
      return {
        ok: false,
        code: 'rejected',
        retryable: response.status >= 500,
        reason: `the api answered ${response.status} without json`,
      }
    }
    const message = this.#oneLine(parsed.message ?? '')
    if (response.status === 401 || response.status === 403) {
      return { ok: false, code: 'unauthorized', retryable: false, reason: message === '' ? 'unauthorized' : message }
    }
    if (response.status === 404) {
      return {
        ok: false,
        code: 'unsupported',
        retryable: false,
        reason: message === '' ? 'the implementation has no upload action' : message,
      }
    }
    if (!response.ok || parsed.status !== 'ok') {
      return {
        ok: false,
        code: response.status >= 500 ? 'unreachable' : 'rejected',
        retryable: response.status >= 500,
        reason: message === '' ? `the api answered ${response.status}` : message,
      }
    }
    const data = (parsed.data ?? {}) as Record<string, unknown>
    const given = idOf(data.file_id) ?? idOf(data.message_id)
    return { ok: true, messageId: given ?? `local:${randomUUID()}`, duplicate: false }
  }

  /** The text alone when there is no media, otherwise the segments this instance may carry. */
  #messageOf(input: SendInput): string | { type: string; data: Record<string, string> }[] | undefined {
    const segments: { type: string; data: Record<string, string> }[] = []
    if (input.body.length > 0) segments.push({ type: 'text', data: { text: input.body } })
    for (const item of input.media ?? []) {
      if (item.type !== 'image') {
        this.#warn?.(`dsbot-channel: dropped a ${item.type} from the send: this version sends images only`)
        continue
      }
      const capability = this.capabilities.image
      if (capability.out !== true) {
        this.#warn?.('dsbot-channel: dropped an image from the send: capabilities.image.out is false')
        continue
      }
      if (item.url === null && item.handle === null) {
        this.#warn?.('dsbot-channel: dropped a media item from the send: it names neither a url nor a handle')
        continue
      }
      if (item.url === null && (typeof item.handle !== 'string' || handleProblem(item.handle) !== undefined)) {
        this.#warn?.('dsbot-channel: dropped a media item from the send: its handle is not one printable token')
        continue
      }
      const source = item.url !== null ? capability.fromUrl : capability.fromHandle
      if (source !== true) {
        this.#warn?.('dsbot-channel: dropped an image from the send: this channel cannot take it from that source')
        continue
      }
      if (item.url === null) {
        const owner = item.owner
        if (owner === undefined || owner.kind !== this.kind || owner.instance !== this.#config.instance) {
          this.#warn?.('dsbot-channel: dropped an image whose handle belongs to another instance')
          continue
        }
      }
      segments.push({ type: 'image', data: { file: (item.url ?? item.handle) as string } })
    }
    if (segments.length === 0) return undefined
    if (segments.length === 1 && segments[0]!.type === 'text') return input.body
    return segments
  }

  /** The socket a websocket protocol speaks through, whichever direction it dials. */
  #socketLink(): ForwardLink | ReverseLink | undefined {
    if (this.#config.protocol === 'ws-forward') return this.#forward
    if (this.#config.protocol === 'ws-reverse') return this.#reverse
    return undefined
  }

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    if (this.#config.protocol === 'ws-forward') return this.#startForward(ports)
    if (this.#config.protocol === 'ws-reverse') return this.#startReverse(ports)
    const listen = this.#config.listen
    if (this.#config.protocol !== 'http' || listen === undefined) {
      throw new ConfigError(
        `transport.protocol "${this.#config.protocol}" is not wired yet; this build answers over http`,
        ['adapters', 'transport', 'protocol'],
      )
    }
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
      server.listen(listen.port, listen.host, () => {
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
    if (this.#config.protocol !== 'http') {
      const socket = this.#socketLink()
      if (socket === undefined) return { ok: false, code: 'unreachable', retryable: true, reason: 'the socket is not open' }
      const answer = await socket.request(action, params, timeoutMs)
      if (!answer.ok) {
        return { ok: false, code: answer.code, retryable: answer.code !== 'rejected', reason: answer.reason }
      }
      const data = answer.frame.data
      const messageId =
        data !== null && typeof data === 'object' ? idOf((data as Record<string, unknown>).message_id) : undefined
      if (messageId === undefined) {
        return { ok: false, code: 'rejected', retryable: false, reason: 'the api answered without a message id' }
      }
      return { ok: true, messageId, duplicate: false }
    }
    const api = this.#config.api
    if (api === undefined) {
      return { ok: false, code: 'unsupported', retryable: false, reason: 'this protocol has no http action api' }
    }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      return { ok: false, code: 'credential', retryable: false, reason: 'the onebot access token did not resolve' }
    }
    let response: Response
    try {
      response = await fetch(`${api.url}/${action}`, {
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
    if (request.method !== 'POST' || url !== this.#config.listen?.path) {
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
    await this.#acceptEvent(event)
  }

  /** Turns one OneBot event into a message and hands it to core, whatever carried it. */
  async #acceptEvent(event: OneBotEvent): Promise<void> {
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

  /** Hosts a socket the implementation dials, and answers its actions on that socket. */
  async #startReverse(ports: AdapterPorts): Promise<AdapterHandle> {
    const listen = this.#config.listen
    if (listen === undefined) {
      throw new ConfigError('transport.listen is required for ws-reverse', ['adapters', 'transport', 'listen'])
    }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      throw new ConfigError('transport.accessToken names a credential that did not resolve', [
        'adapters',
        'transport',
        'accessToken',
      ])
    }
    this.#ports = ports
    const link = new ReverseLink({
      path: listen.path,
      token,
      ...(this.#config.selfId === undefined ? {} : { selfId: this.#config.selfId }),
      maxFrameBytes: ONEBOT_MAX_BODY_BYTES,
      timeoutMs: this.#config.sendTimeoutMs,
      ...(this.#config.heartbeat === undefined ? {} : { heartbeat: this.#config.heartbeat }),
      onEvent: (frame) => {
        void this.#acceptEvent(frame as OneBotEvent)
      },
      onMismatch: () => this.#stats.protocolMismatch(),
      onAuthFailure: () => this.#stats.authFailure(),
      onUnknownPath: () => this.#stats.unknownPath(),
      warn: (message) => this.#warn?.(message),
    })
    this.#reverse = link
    const server = createServer((request, response) => {
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
      this.#stats.unknownPath()
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"status":"failed","retcode":1404,"message":"not found"}')
    })
    link.attach(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(listen.port, listen.host, () => {
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
        link.close()
        this.#reverse = undefined
        await new Promise<void>((resolve) => server.close(() => resolve()))
        this.#stats.closed()
      },
      address: () => ({ port: (server.address() as AddressInfo).port }),
    }
  }

  /** Dials the implementation's socket and hands what arrives to the same event path. */
  async #startForward(ports: AdapterPorts): Promise<AdapterHandle> {
    const api = this.#config.api
    if (api === undefined) {
      throw new ConfigError('transport.api is required for ws-forward', ['adapters', 'transport', 'api'])
    }
    const token = this.#config.accessToken === undefined ? undefined : await ports.resolveSecret(this.#config.accessToken)
    if (this.#config.accessToken !== undefined && token === undefined) {
      throw new ConfigError('transport.accessToken names a credential that did not resolve', [
        'adapters',
        'transport',
        'accessToken',
      ])
    }
    this.#ports = ports
    const link = new ForwardLink({
      apiUrl: api.url,
      ...(this.#config.event === undefined ? {} : { eventUrl: this.#config.event.url }),
      token,
      reconnect: this.#config.reconnect ?? { initialMs: 500, maxMs: 30_000, factor: 2 },
      ...(this.#config.heartbeat === undefined ? {} : { heartbeat: this.#config.heartbeat }),
      timeoutMs: this.#config.sendTimeoutMs,
      maxFrameBytes: ONEBOT_MAX_BODY_BYTES,
      onEvent: (frame) => {
        void this.#acceptEvent(frame as OneBotEvent)
      },
      onMismatch: () => this.#stats.protocolMismatch(),
      warn: (message) => this.#warn?.(message),
    })
    this.#forward = link
    link.start()
    return {
      stop: async () => {
        link.close()
        this.#forward = undefined
      },
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
