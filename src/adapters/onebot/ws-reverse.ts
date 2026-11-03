import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer } from 'ws'
import type { ActionAnswer } from './ws-forward.js'

export interface ReverseOptions {
  path: string
  token?: string | undefined
  selfId?: string | undefined
  maxFrameBytes: number
  /** How long an action waits for its answer; the profile's `sendTimeoutMs`. */
  timeoutMs: number
  heartbeat?: { intervalMs: number; timeoutMs: number } | undefined
  onEvent: (frame: Record<string, unknown>) => void
  onMismatch: () => void
  onAuthFailure: () => void
  onUnknownPath: () => void
  warn: (message: string) => void
  now?: (() => number) | undefined
}

/**
 * The reverse half of OneBot over WebSocket: an implementation dials us, we keep one
 * connection per adapter, and actions travel back down it with an `echo`.
 */
export class ReverseLink {
  readonly #options: ReverseOptions
  readonly #pending = new Map<string, { resolve: (answer: ActionAnswer) => void; timer: ReturnType<typeof setTimeout> }>()
  readonly #server: WebSocketServer
  #socket: WebSocket | undefined
  #selfId: string | undefined
  #lastAuthenticatedAt: number | null = null
  #beat: ReturnType<typeof setInterval> | undefined
  #lastFrameAt = 0
  #warnedSize = false
  #warnedNoId = false

  constructor(options: ReverseOptions) {
    this.#options = options
    this.#server = new WebSocketServer({ noServer: true })
  }

  /** Takes over the server's upgrade events; anything not on our path is left to the caller. */
  attach(server: Server): void {
    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      void this.#upgrade(request, socket, head)
    })
    if (this.#options.heartbeat !== undefined && this.#options.heartbeat.intervalMs > 0) {
      this.#startBeat()
    }
  }

  close(): void {
    if (this.#beat !== undefined) clearInterval(this.#beat)
    this.#beat = undefined
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, code: 'unreachable', reason: 'the link closed while waiting for an answer' })
    }
    this.#pending.clear()
    this.#socket?.close()
    this.#socket = undefined
    this.#server.close()
  }

  connection(): WebSocket | undefined {
    return this.#socket
  }

  lastAuthenticatedAt(): number | null {
    return this.#lastAuthenticatedAt
  }

  request(action: string, params: Record<string, unknown>, timeoutMs: number | undefined): Promise<ActionAnswer> {
    const socket = this.#socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) {
      return Promise.resolve({ ok: false, code: 'unreachable', reason: 'no reverse socket is connected' })
    }
    const echo = randomUUID()
    return new Promise<ActionAnswer>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(echo)
        resolve({ ok: false, code: 'timeout', reason: 'the api did not answer in time' })
      }, timeoutMs ?? this.#options.timeoutMs)
      this.#pending.set(echo, { resolve, timer })
      socket.send(JSON.stringify({ action, params, echo }), (error?: Error | null) => {
        if (error === null || error === undefined) return
        const pending = this.#pending.get(echo)
        if (pending === undefined) return
        clearTimeout(pending.timer)
        this.#pending.delete(echo)
        pending.resolve({ ok: false, code: 'unreachable', reason: `the frame could not be sent: ${String(error)}` })
      })
    })
  }

  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const url = request.url ?? '/'
    if (url !== this.#options.path) {
      this.#options.onUnknownPath()
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    if (!this.#authorized(request)) {
      this.#options.onAuthFailure()
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    const claimed = headerOf(request, 'x-self-id')
    if (this.#options.selfId !== undefined && claimed !== undefined && claimed !== this.#options.selfId) {
      this.#options.onAuthFailure()
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
    if (this.#options.selfId === undefined && claimed === undefined && !this.#warnedNoId) {
      this.#warnedNoId = true
      this.#options.warn('dsbot-channel: accepted an onebot reverse connection that names no X-Self-ID')
    }
    const previous = this.#socket
    if (previous !== undefined) {
      const previousId = this.#selfId
      if (claimed !== undefined && previousId !== undefined && claimed !== previousId) {
        this.#options.onAuthFailure()
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      this.#options.warn('dsbot-channel: replaced the onebot reverse connection this adapter already held')
      previous.close(1000, 'replaced by a new connection')
    }
    this.#server.handleUpgrade(request, socket, head, (upgraded) => {
      this.#adopt(upgraded, claimed)
    })
  }

  #adopt(socket: WebSocket, claimed: string | undefined): void {
    this.#socket = socket
    this.#lastAuthenticatedAt = this.#now()
    this.#lastFrameAt = this.#now()
    this.#selfId = claimed ?? this.#options.selfId
    socket.on('message', (raw: WebSocket.RawData) => this.#onFrame(raw))
    socket.on('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      for (const [, pending] of this.#pending) {
        clearTimeout(pending.timer)
        pending.resolve({ ok: false, code: 'unreachable', reason: 'the reverse socket closed while waiting for an answer' })
      }
      this.#pending.clear()
    })
    socket.on('error', (error: Error) => this.#options.warn(`dsbot-channel: onebot reverse socket: ${error.message}`))
  }

  #onFrame(raw: WebSocket.RawData): void {
    const bytes = Array.isArray(raw)
      ? Buffer.concat(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(new Uint8Array(raw as ArrayBuffer))
    if (bytes.length > this.#options.maxFrameBytes) {
      this.#socket?.close(1009, 'frame too large')
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
      pending.resolve(answerOf(record))
      return
    }
    if (record.post_type !== undefined) {
      this.#lastFrameAt = this.#now()
      this.#options.onEvent(record)
      return
    }
    this.#options.onMismatch()
  }

  #authorized(request: IncomingMessage): boolean {
    if (this.#options.token === undefined) return true
    const header = request.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^(?:Bearer|Token)\s+(.+)$/i.exec(header.trim())
    return match !== null && match[1] === this.#options.token
  }

  #startBeat(): void {
    const beat = this.#options.heartbeat
    if (beat === undefined) return
    this.#beat = setInterval(() => {
      if (this.#socket === undefined) return
      if (this.#now() - this.#lastFrameAt > beat.timeoutMs) {
        this.#options.warn('dsbot-channel: closed the onebot socket: its heartbeat went silent')
        this.#socket.close(1001, 'heartbeat timeout')
      }
    }, beat.intervalMs)
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now()
  }
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function answerOf(frame: Record<string, unknown>): ActionAnswer {
  if (frame.status !== 'ok') {
    const message =
      typeof frame.message === 'string' && frame.message.length > 0 ? frame.message : 'the api answered with a failed status'
    return { ok: false, code: 'rejected', reason: message }
  }
  return { ok: true, frame }
}
