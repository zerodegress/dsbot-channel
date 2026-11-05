import { createServer } from 'node:http'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { NO_MEDIA, buildListenerHealth, buildStatus } from '../../adapter-status.js'
import type { AdapterStatus, CapabilitySet } from '../../adapter-status.js'
import { ChannelStats, countersOf } from '../../channel-stats.js'
import type { AdapterHandle, AdapterPorts, ChannelAdapter, InboundMessage, SendFailureCode, SendInput, SendResult } from '../../contract.js'
import { ADAPTER_META_MAX_BYTES } from '../../adapter-meta.js'
import { fitAdapterMeta, mapWebhook } from './mapping.js'
import type { WebhookDialect } from './mapping.js'

export const DEFAULT_WEBHOOK_HOST = '127.0.0.1'
export const DEFAULT_WEBHOOK_PORT = 8463
export const DEFAULT_WEBHOOK_PATH = '/github/webhook'
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
export const SEEN_TTL_MS = 10 * 60_000
export const SEND_QUEUE_MAX = 8

export interface WebhookConfig {
  channel: string
  botName: string
  status: boolean
  listen: { host: string; port: number; path: string }
  secret: string
  token: string
  dialect: WebhookDialect
  api: string
  login: string
  bots: readonly string[]
  repos: readonly string[]
}

export interface WebhookOptions {
  warn?: ((message: string) => void) | undefined
  now?: (() => number) | undefined
}

const CAPABILITIES: CapabilitySet = {
  text: true,
  image: NO_MEDIA,
  file: NO_MEDIA,
  voice: NO_MEDIA,
  recall: false,
  history: { group: false, private: false },
  mention: true,
  reply: false,
  stream: false,
  outbound: true,
}

type SignatureKind = 'github' | 'forgejo'

interface Seen {
  at: number
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function hexToBytes(hex: string): Buffer | undefined {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) return undefined
  return Buffer.from(hex, 'hex')
}

/** The signature the request carries, whichever dialect names it. */
export function signatureOf(request: IncomingMessage): { kind: SignatureKind; value: string } | undefined {
  const github = headerOf(request, 'x-hub-signature-256')
  if (github !== undefined) {
    return { kind: 'github', value: github.startsWith('sha256=') ? github.slice('sha256='.length) : github }
  }
  for (const name of ['x-forgejo-signature', 'x-gitea-signature', 'x-hub-signature']) {
    const found = headerOf(request, name)
    if (found !== undefined) {
      return { kind: 'forgejo', value: found.startsWith('sha256=') ? found.slice('sha256='.length) : found }
    }
  }
  return undefined
}

export function verifySignature(secret: string, raw: Buffer, signature: string): boolean {
  const expected = hexToBytes(signature)
  if (expected === undefined) return false
  const computed = createHmac('sha256', secret).update(raw).digest()
  if (expected.length !== computed.length) return false
  return timingSafeEqual(expected, computed)
}

export interface DialectPick {
  dialect: 'github' | 'forgejo'
  fallback: boolean
}

/** Which dialect the request speaks, from its headers; only an ambiguous signature falls back to the payload. */
export function pickDialect(request: IncomingMessage, configured: WebhookDialect, payload: unknown): DialectPick | 'mismatch' | 'unknown' {
  const githubEvent = headerOf(request, 'x-github-event')
  const forgejoEvent = headerOf(request, 'x-forgejo-event') ?? headerOf(request, 'x-gitea-event')
  const seen = signatureOf(request)?.kind
  const byHeader = githubEvent !== undefined ? 'github' : forgejoEvent !== undefined ? 'forgejo' : undefined
  if (configured !== 'auto') {
    if (byHeader !== undefined && byHeader !== configured) return 'mismatch'
    return { dialect: configured, fallback: false }
  }
  if (byHeader !== undefined) return { dialect: byHeader, fallback: false }
  if (seen === undefined) return 'unknown'
  if (payload !== null && typeof payload === 'object' && 'repository' in (payload as Record<string, unknown>)) {
    return { dialect: 'github', fallback: true }
  }
  return 'unknown'
}

/** The comment body the GitHub API expects, kept to what this adapter promises to write. */
export function commentRequest(config: WebhookConfig, input: SendInput): { url: string; body: string } | undefined {
  const matched = /^gh:([^/]+)\/([^#]+)#(\d+)$/.exec(input.target)
  if (matched === null) return undefined
  const [, owner, repo, number] = matched
  const base = config.api.replace(/\/+$/, '')
  return {
    url: `${base}/repos/${owner}/${repo}/issues/${number}/comments`,
    body: input.body,
  }
}

export class WebhookAdapter implements ChannelAdapter {
  readonly kind = 'webhook'
  readonly capabilities = CAPABILITIES
  readonly guidance = {
    peer: 'An issue or a pull request is the room: answer there, in markdown, as a comment.',
    group: 'An issue or a pull request is the room: answer there, in markdown, as a comment.',
  }

  readonly #config: WebhookConfig
  readonly #now: () => number
  readonly #stats = new ChannelStats()
  readonly #seen = new Map<string, Seen>()
  readonly #queue: { input: SendInput; resolve: (result: SendResult) => void }[] = []
  #server: Server | undefined
  #inFlight = 0
  #stopped = false
  #dialectFallback = 0

  constructor(config: WebhookConfig, options: WebhookOptions = {}) {
    this.#config = config
    this.#now = options.now ?? Date.now
  }

  checkConfig(): void {
    if (this.#config.secret.length === 0) throw new Error('webhook: transport.secret is required')
    if (this.#config.token.length === 0) throw new Error('webhook: transport.token is required to answer with a comment')
    if (this.#config.login.length === 0) throw new Error('webhook: transport.login names the bot and is required')
    if (!/^https?:\/\//.test(this.#config.api)) throw new Error(`webhook: transport.api must be an absolute http(s) url: ${this.#config.api}`)
    if (!this.#config.listen.path.startsWith('/')) throw new Error(`webhook: transport.listen.path must start with "/": ${this.#config.listen.path}`)
  }

  checkSessionKey(key: string): string | undefined {
    if (!/^gh:[^/#]+\/[^#]+(#[0-9]+)?$/.test(key)) return 'a webhook session key reads "gh:<owner>/<repo>[#<number>]"'
    return undefined
  }

  checkTarget(target: string): string | undefined {
    if (!/^gh:[^/#]+\/[^#]+#[0-9]+$/.test(target)) return 'a webhook reply target reads "gh:<owner>/<repo>#<number>"'
    return undefined
  }

  describeTargets(): string {
    return 'gh:<owner>/<repo>#<number>'
  }

  status(): AdapterStatus {
    const snapshot = this.#stats.snapshot()
    const counters = countersOf(snapshot)
    if (this.#dialectFallback > 0) counters.dialectFallback = this.#dialectFallback
    return buildStatus({
      channel: this.#config.channel,
      account: this.#config.channel,
      bot: this.#config.botName,
      health: buildListenerHealth({
        listenState: snapshot.state === 'listening' ? 'listening' : snapshot.state === 'failed' ? 'failed' : 'stopped',
        boundPort: snapshot.boundPort,
        lastAuthenticatedAt: snapshot.lastAuthenticatedAt,
        queueDepth: this.#queue.length + this.#inFlight,
      }),
      counters,
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: this.#now(),
      queueDepth: this.#queue.length + this.#inFlight,
    })
  }

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    const secret = await ports.resolveSecret(this.#config.secret)
    if (secret === undefined || secret.length === 0) throw new Error(`webhook: credential "${this.#config.secret}" did not resolve`)
    const token = await ports.resolveSecret(this.#config.token)
    if (token === undefined || token.length === 0) throw new Error(`webhook: credential "${this.#config.token}" did not resolve`)
    this.#tokenValue = token
    const server = createServer((request, response) => {
      void this.#handle(secret, ports, request, response)
    })
    this.#server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#config.listen.port, this.#config.listen.host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address() as AddressInfo
    this.#stats.listening(address.port)
    return {
      address: () => ({ port: address.port }),
      stop: () => this.#stop(),
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    if (this.#stopped) return { ok: false, code: 'no_url', reason: 'the listener is closed', retryable: false }
    const request = commentRequest(this.#config, input)
    if (request === undefined) {
      return { ok: false, code: 'no_url', reason: `"${input.target}" is not an issue address`, retryable: false }
    }
    if (this.#queue.length >= SEND_QUEUE_MAX) {
      return { ok: false, code: 'busy', reason: 'too many comments are already waiting', retryable: true }
    }
    return new Promise<SendResult>((resolve) => {
      this.#queue.push({ input, resolve })
      void this.#drain()
    })
  }

  async #drain(): Promise<void> {
    if (this.#inFlight > 0) return
    const next = this.#queue.shift()
    if (next === undefined) return
    this.#inFlight = 1
    try {
      next.resolve(await this.#postComment(next.input))
    } finally {
      this.#inFlight = 0
      if (this.#queue.length > 0) void this.#drain()
    }
  }

  async #postComment(input: SendInput): Promise<SendResult> {
    const request = commentRequest(this.#config, input)
    if (request === undefined) return { ok: false, code: 'no_url', reason: 'not an issue address', retryable: false }
    const token = await this.#token()
    if (token === undefined) return { ok: false, code: 'unauthorized', reason: 'the token did not resolve', retryable: false }
    let response: Response
    try {
      response = await fetch(request.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'user-agent': 'dsbot-channel' },
        body: JSON.stringify({ body: request.body }),
      })
    } catch (error) {
      this.#stats.sendFailed('unreachable')
      return { ok: false, code: 'unreachable', reason: String(error), retryable: true }
    }
    if (response.ok) return { ok: true, messageId: `comment:${input.eventId}`, duplicate: false }
    const status = response.status
    if (status === 401) return this.#fail('unauthorized', false)
    if (status === 403 || status === 429) return this.#fail(status === 429 ? 'busy' : 'forbidden', status === 429)
    if (status >= 500) return this.#fail('unreachable', true)
    return this.#fail('rejected', false)
  }

  #fail(code: SendFailureCode, retryable: boolean, reason = 'the api refused the comment'): SendResult {
    this.#stats.sendFailed(code)
    return { ok: false, code, reason, retryable }
  }

  #tokenValue: string | undefined

  async #token(): Promise<string | undefined> {
    return this.#tokenValue
  }

  async #handle(secret: string, ports: AdapterPorts, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (path !== this.#config.listen.path) {
      this.#stats.unknownPath()
      this.#answer(response, 404, 'not found')
      return
    }
    if (request.method !== 'POST') {
      this.#answer(response, 405, 'method not allowed')
      return
    }
    const raw = await this.#readBody(request)
    if (raw === undefined) {
      this.#answer(response, 413, 'payload too large')
      return
    }
    const signature = signatureOf(request)
    if (signature === undefined || !verifySignature(secret, raw, signature.value)) {
      this.#stats.authFailure()
      this.#answer(response, 401, 'bad signature')
      return
    }
    this.#stats.authenticated()
    let payload: unknown
    try {
      payload = JSON.parse(raw.toString('utf8'))
    } catch {
      this.#answer(response, 400, 'bad json')
      return
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      this.#answer(response, 400, 'bad json')
      return
    }
    const record = payload as Record<string, unknown>
    const picked = pickDialect(request, this.#config.dialect, record)
    if (picked === 'mismatch') {
      this.#stats.protocolMismatch()
      this.#answer(response, 400, 'the event headers name another dialect')
      return
    }
    if (picked === 'unknown') {
      this.#answer(response, 400, 'cannot tell the dialect')
      return
    }
    if (picked.fallback) this.#dialectFallback += 1
    const event = headerOf(request, 'x-github-event') ?? headerOf(request, 'x-forgejo-event') ?? headerOf(request, 'x-gitea-event') ?? ''
    if (event === '') {
      this.#answer(response, 400, 'cannot tell the event class')
      return
    }
    const delivery = headerOf(request, 'x-github-delivery') ?? headerOf(request, 'x-forgejo-delivery') ?? headerOf(request, 'x-gitea-delivery') ?? ''
    if (this.#config.repos.length > 0) {
      const repo = record.repository as Record<string, unknown> | undefined
      const full = repo === undefined ? '' : `${String((repo.owner as Record<string, unknown> | undefined)?.login ?? '')}/${String(repo.name ?? '')}`
      if (!this.#config.repos.includes(full)) {
        this.#answer(response, 200, 'ignored')
        return
      }
    }
    const mapped = mapWebhook({
      dialect: picked.dialect,
      event,
      delivery: delivery === '' ? `${event}:${this.#now()}` : delivery,
      payload: record,
      config: { channel: this.#config.channel, login: this.#config.login, bots: this.#config.bots },
    })
    if ('skip' in mapped) {
      if (mapped.skip === 'ping') this.#stats.event('webhook.ping')
      this.#answer(response, 200, 'ok')
      return
    }
    const key = delivery === '' ? mapped.message.eventKey : delivery
    if (this.#seen.has(key) || this.#seen.has(mapped.message.eventKey)) {
      this.#answer(response, 200, 'duplicate')
      return
    }
    this.#remember(key)
    this.#remember(mapped.message.eventKey)
    const at = this.#now()
    const message: InboundMessage = {
      ...mapped.message,
      transport: { ...mapped.message.transport, timestamp: mapped.message.transport.timestamp === 0 ? at : mapped.message.transport.timestamp },
      receivedAt: at,
      adapter: fitAdapterMeta(mapped.message.adapter, ADAPTER_META_MAX_BYTES),
    }
    this.#stats.event(`${message.kind ?? 'message'}.${message.event?.postType ?? 'unknown'}`)
    const verdict = await ports.onMessage(message).catch((error: unknown) => ({ ok: false as const, code: 'rejected' as const, reason: String(error) }))
    if (verdict.ok) {
      this.#answer(response, 200, 'ok')
      return
    }
    if (verdict.code === 'busy') {
      response.writeHead(503, { 'retry-after': '1', 'content-type': 'text/plain' })
      response.end('busy')
      return
    }
    this.#answer(response, 202, verdict.reason)
  }

  #remember(key: string): void {
    const at = this.#now()
    for (const [seen, when] of this.#seen) {
      if (at - when.at > SEEN_TTL_MS) this.#seen.delete(seen)
    }
    this.#seen.set(key, { at })
  }

  #readBody(request: IncomingMessage): Promise<Buffer | undefined> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const settle = (value: Buffer | undefined) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      request.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > MAX_WEBHOOK_BODY_BYTES) {
          settle(undefined)
          request.resume()
          return
        }
        chunks.push(chunk)
      })
      request.on('end', () => settle(Buffer.concat(chunks)))
      request.on('error', () => settle(undefined))
    })
  }

  #answer(response: ServerResponse, status: number, body: string): void {
    response.writeHead(status, { 'content-type': 'text/plain', 'content-length': Buffer.byteLength(body) })
    response.end(body)
  }

  async #stop(): Promise<void> {
    this.#stopped = true
    for (const waiting of this.#queue.splice(0)) {
      waiting.resolve({ ok: false, code: 'no_url', reason: 'the listener is closed', retryable: false })
    }
    const server = this.#server
    this.#server = undefined
    if (server === undefined) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
    this.#stats.closed()
  }
}
