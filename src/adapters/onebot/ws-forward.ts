import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import type { ConnectionHealth, ConnectionState } from '../../adapter-status.js'

/** What an action call answers: the payload of a `status: ok` reply, or why none came. */
export type ActionAnswer =
  | { ok: true; frame: Record<string, unknown> }
  | { ok: false; code: 'timeout' | 'unreachable' | 'rejected'; reason: string }

export interface ForwardOptions {
  apiUrl: string
  /** The event socket; absent means events and actions share the api socket. */
  eventUrl?: string | undefined
  token?: string | undefined
  reconnect: { initialMs: number; maxMs: number; factor: number } | false
  heartbeat?: { intervalMs: number; timeoutMs: number } | undefined
  timeoutMs: number
  maxFrameBytes: number
  onEvent: (frame: Record<string, unknown>) => void
  onMismatch: () => void
  warn: (message: string) => void
  now?: (() => number) | undefined
}

/**
 * The forward half of OneBot over WebSocket: this side dials out, sends actions with an
 * `echo`, and reads events off the same socket or a second one.
 */
export class ForwardLink {
  readonly #options: ForwardOptions
  readonly #pending = new Map<string, { resolve: (answer: ActionAnswer) => void; timer: ReturnType<typeof setTimeout> }>()
  #api: WebSocket | undefined
  #events: WebSocket | undefined
  #closed = false
  #retry: ReturnType<typeof setTimeout> | undefined
  #beat: ReturnType<typeof setInterval> | undefined
  #attempt = 0
  #reconnects = 0
  #state: ConnectionState = 'offline'
  #lastFailure: string | null = null
  #lastFailureAt: number | null = null
  #lastConnectedAt: number | null = null
  #lastFrameAt = 0
  #warnedSize = false

  constructor(options: ForwardOptions) {
    this.#options = options
  }

  start(): void {
    this.#closed = false
    this.#dial()
    if (this.#options.heartbeat !== undefined && this.#options.heartbeat.intervalMs > 0) {
      this.#startBeat()
    }
  }

  close(): void {
    this.#closed = true
    if (this.#retry !== undefined) clearTimeout(this.#retry)
    if (this.#beat !== undefined) clearInterval(this.#beat)
    this.#retry = undefined
    this.#beat = undefined
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'unreachable', reason: 'the link closed while waiting for an answer' })
    }
    this.#pending.clear()
    this.#api?.close()
    this.#events?.close()
    this.#api = undefined
    this.#events = undefined
    this.#state = 'offline'
  }

  health(): ConnectionHealth {
    return {
      kind: 'connection',
      state: this.#state,
      lastFailure: this.#lastFailure,
      lastFailureAt: this.#lastFailureAt,
      reconnectCount: this.#reconnects,
      lastConnectedAt: this.#lastConnectedAt,
      queueDepth: this.#pending.size,
    }
  }

  /** Sends one action and waits for the frame that carries its echo. */
  request(action: string, params: Record<string, unknown>, timeoutMs: number | undefined): Promise<ActionAnswer> {
    const socket = this.#api
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, code: 'unreachable', reason: 'the forward socket is not open' })
    }
    const echo = randomUUID()
    return new Promise<ActionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        resolve({ ok: false, code: 'timeout', reason: 'the api did not answer in time' })
      }, timeoutMs ?? this.#options.timeoutMs)
      this.#pending.set(echo, { resolve, timer })
      socket.send(JSON.stringify({ action, params, echo }), (error?: Error | undefined) => {
        if (error === null || error === undefined) return
        const pending = this.#pending.get(echo)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.#pending.delete(echo)
        pending.resolve({ ok: false, code: 'unreachable', reason: `the frame could not be sent: ${String(error)}` })
      })
    })
  }

  #dial(): void {
    const socket = new WebSocket(this.#options.apiUrl, {
      ...(this.#options.token === undefined ? {} : { headers: { authorization: `Bearer ${this.#options.token}` } }),
    })
    this.#api = socket
    socket.on('open', () => {
      this.#attempt = 0
      if (this.#lastConnectedAt !== null) this.#reconnects += 1
      this.#lastConnectedAt = this.#now()
      this.#lastFrameAt = this.#now()
      this.#state = 'online'
      this.#openEvents()
    })
    socket.on('message', (raw: WebSocket.RawData) => this.#onFrame(raw))
    socket.on('close', (code: number) => this.#dropped(`the forward socket closed with ${code}`))
    socket.on('error', (error: Error) => {
      this.#lastFailure = error.message
      this.#lastFailureAt = this.#now()
    })
  }

  #openEvents(): void {
    const url = this.#options.eventUrl
    if (url === undefined || this.#events !== undefined) return
    const socket = new WebSocket(url, {
      ...(this.#options.token === undefined ? {} : { headers: { authorization: `Bearer ${this.#options.token}` } }),
    })
    this.#events = socket
    socket.on('message', (raw: WebSocket.RawData) => this.#onFrame(raw))
    socket.on('close', () => {
      this.#events = undefined
      if (!this.#closed) setTimeout(() => this.#openEvents(), this.#options.reconnect === false ? 0 : 1000)
    })
    socket.on('error', (error: Error) => {
      this.#lastFailure = error.message
      this.#lastFailureAt = this.#now()
    })
  }

  #onFrame(raw: WebSocket.RawData): void {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(new Uint8Array(raw as ArrayBuffer))
    if (bytes.length > this.#options.maxFrameBytes) {
      this.#api?.close(1009, 'frame too large')
      if (!this.#warnedSize) {
        this.#warnedSize = true
        this.#options.warn('dsbot-channel: closed the onebot socket: a frame exceeded the size limit')
      }
      return
    }
    let frame: unknown
    try {
      frame = JSON.parse(bytes.toString())
    } catch {
      this.#options.onMismatch()
      return
    }
    if (frame === null || typeof frame !== 'object' || Array.isArray(frame)) {
      this.#options.onMismatch()
      return
    }
    const record = frame as Record<string, unknown>
    if (typeof record.echo === 'string') {
      const pending = this.#pending.get(record.echo)
      if (pending === undefined) {
        this.#options.onMismatch()
        return
      }
      clearTimeout(pending.timer)
      this.#pending.delete(record.echo)
      pending.resolve(this.#answer(record))
      return
    }
    if (record.post_type !== undefined) {
      this.#lastFrameAt = this.#now()
      this.#options.onEvent(record)
      return
    }
    this.#options.onMismatch()
  }

  #answer(frame: Record<string, unknown>): ActionAnswer {
    if (frame.status !== 'ok') {
      const message = typeof frame.message === 'string' && frame.message.length > 0 ? frame.message : 'the api answered with a failed status'
      return { ok: false, code: 'rejected', reason: message }
    }
    return { ok: true, frame }
  }

  #dropped(reason: string): void {
    this.#state = 'offline'
    this.#lastFailure = reason
    this.#lastFailureAt = this.#now()
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'unreachable', reason })
    }
    this.#pending.clear()
    this.#api = undefined
    this.#events?.close()
    this.#events = undefined
    const retry = this.#options.reconnect
    if (this.#closed || retry === false) return
    const base = Math.min(retry.initialMs * retry.factor ** this.#attempt, retry.maxMs)
    const jittered = Math.round(base * (0.8 + Math.random() * 0.4))
    this.#attempt += 1
    this.#retry = setTimeout(() => {
      this.#retry = undefined
      if (!this.#closed) this.#dial()
    }, jittered)
  }

  #startBeat(): void {
    const beat = this.#options.heartbeat
    if (beat === undefined) return
    this.#beat = setInterval(() => {
      if (this.#state !== 'online') return
      if (this.#now() - this.#lastFrameAt > beat.timeoutMs) {
        this.#options.warn('dsbot-channel: closed the onebot socket: its heartbeat went silent')
        this.#api?.close(1001, 'heartbeat timeout')
      }
    }, beat.intervalMs)
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}
