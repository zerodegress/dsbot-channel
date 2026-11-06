import type { AnchorCode, SessionAnchor } from './bot-sessions.js'
import type { ModelSelection, ModelSelectionState } from './adapter-status.js'

export interface SessionMessagePart {
  type: string
  text?: string
}

export interface SessionEventLike {
  type: string
  /** user/message puts the message itself in data; assistant/message nests it under message. */
  data?: {
    content?: readonly SessionMessagePart[]
    source?: { rpcId?: string }
    message?: { content?: readonly SessionMessagePart[] }
  }
}

export interface PromptRequest {
  sessionId: string
  requestId: string
  mode: 'queue' | 'steer'
  content: readonly { type: 'text'; text: string }[]
}

/** One model route a session can run on: the provider id and the model id under it. */
export interface ModelRoute {
  provider: string
  model: string
}

export interface SessionControllerLike {
  prompt(request: PromptRequest, signal: AbortSignal): Promise<{ accepted: boolean }>
  /** Selects the model a session runs on; absent when the host cannot choose one. */
  selectModel?(request: ModelRoute & { sessionId: string }): Promise<unknown>
}

export interface PeerSessionsOptions {
  controller: SessionControllerLike
  observe: (listener: (sessionId: string, event: SessionEventLike) => void) => () => void
  /** Resolves the session a turn runs in; read every turn because a Bot may move to a new segment. */
  anchor: SessionAnchor
  timeoutMs?: number
  /** The model the resolved session runs on. */
  model?: ModelRoute | undefined
  /** Receives what the host could not honour, such as a missing model selector. */
  warn?: ((message: string) => void) | undefined
}

/** A turn that cannot name its session; the code travels to the turn record. */
export class AnchorTurnError extends Error {
  readonly code: AnchorCode

  constructor(code: AnchorCode, reason: string) {
    super(reason)
    this.name = 'AnchorTurnError'
    this.code = code
  }
}

export interface PeerTurnInput {
  peer: string
  requestId: string
  text: string
  /** Called once the turn knows its session, inside the adapter's queue and before the prompt. */
  onSession?: ((sessionId: string) => void) | undefined
}

export interface PeerTurn {
  sessionId: string
  requestId: string
  text: string
}

/** Turn ceiling a peer message may occupy before it is dropped. */
export const DEFAULT_TURN_TIMEOUT_MS = 120_000

/** Raised when a turn outlives the ceiling instead of finishing. */
export class TurnTimeoutError extends Error {
  readonly timeoutMs: number

  constructor(timeoutMs: number) {
    super(`the peer turn did not finish within ${timeoutMs}ms`)
    this.name = 'TurnTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** One turn the bridge is waiting on; aborting it settles the wait, not just the signal. */
interface RunningTurn {
  abort(error: Error): void
}

function textOf(content: readonly SessionMessagePart[] | undefined): string {
  if (content === undefined) return ''
  let text = ''
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') text += part.text
  }
  return text
}

/** Runs one turn per peer on a long lived session and waits for its final text. */
export class PeerSessions {
  readonly #controller: SessionControllerLike
  readonly #observe: PeerSessionsOptions['observe']
  readonly #anchor: SessionAnchor
  readonly #timeoutMs: number
  readonly #model: ModelRoute | undefined
  #modelState: ModelSelectionState | undefined
  readonly #warn: ((message: string) => void) | undefined
  readonly #readyModels = new Map<string, Promise<string>>()
  #warnedNoSelector = false
  #queue: Promise<void> = Promise.resolve()
  readonly #running = new Set<RunningTurn>()
  readonly #detachers = new Set<() => void>()
  #disposed = false

  constructor(options: PeerSessionsOptions) {
    this.#controller = options.controller
    this.#observe = options.observe
    this.#anchor = options.anchor
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.#model = options.model
    this.#modelState =
      options.model !== undefined && options.controller.selectModel === undefined ? 'unsupported' : undefined
    this.#warn = options.warn
  }

  /** Stops every turn in flight and rejects the turns asked for afterwards; safe to call more than once. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = new Error('the peer sessions were disposed')
    for (const running of [...this.#running]) running.abort(error)
    this.#running.clear()
    for (const detach of [...this.#detachers]) detach()
    this.#readyModels.clear()
  }

  /** The model this adapter asked for and whether the host took it; absent until that is decided. */
  get modelSelection(): ModelSelection | undefined {
    const model = this.#model
    if (model === undefined || this.#modelState === undefined) return undefined
    return { requested: `${model.provider}/${model.model}`, state: this.#modelState }
  }

  /** Whether dispose ran; a disposed bridge refuses every later turn. */
  get disposed(): boolean {
    return this.#disposed
  }

  /** Queues a turn behind the adapter's previous one: one Bot session, one turn at a time. */
  runTurn(input: PeerTurnInput): Promise<PeerTurn> {
    if (this.#disposed) return Promise.reject(new Error('the peer sessions were disposed'))
    const run = this.#queue.then(
      () => this.#runTurn(input),
      () => this.#runTurn(input),
    )
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /** Picks the configured model once per session; every caller waits for that same pick. */
  #ready(sessionId: string): Promise<string> {
    const model = this.#model
    if (model === undefined) return Promise.resolve(sessionId)
    const started = this.#readyModels.get(sessionId)
    if (started !== undefined) return started
    const ready = (async (): Promise<string> => {
      if (this.#controller.selectModel === undefined) {
        if (!this.#warnedNoSelector) {
          this.#warnedNoSelector = true
          this.#warn?.(
            'dsbot-channel: a model is configured but the host session controller cannot select one; sessions keep their own model',
          )
        }
        return sessionId
      }
      try {
        await this.#controller.selectModel({ sessionId, provider: model.provider, model: model.model })
        this.#modelState = 'applied'
      } catch (error) {
        this.#modelState = 'rejected'
        this.#warn?.(
          `dsbot-channel: selecting model ${model.provider}/${model.model} for ${sessionId} failed: ${String(error)}`,
        )
      }
      return sessionId
    })()
    this.#readyModels.set(sessionId, ready)
    return ready
  }

  async #runTurn(input: PeerTurnInput): Promise<PeerTurn> {
    if (this.#disposed) throw new Error('the peer sessions were disposed')
    const resolved = await this.#anchor.resolve()
    if (this.#disposed) throw new Error('the peer sessions were disposed')
    if (!resolved.ok) throw new AnchorTurnError(resolved.code, resolved.reason)
    input.onSession?.(resolved.sessionId)
    const sessionId = await this.#ready(resolved.sessionId)
    const texts: string[] = []
    let started = false
    let settle = (): void => {}
    const finished = new Promise<void>((resolve) => {
      settle = resolve
    })
    const stop = this.#observe((observed, event) => {
      if (observed !== sessionId) return
      if (event.type === 'user/message') {
        const rpcId = event.data?.source?.rpcId
        if (rpcId === undefined) return
        if (rpcId !== input.requestId) return
        started = true
        texts.length = 0
        return
      }
      if (event.type === 'turn/start') {
        started = true
        return
      }
      if (!started) return
      if (event.type === 'assistant/message') {
        const text = textOf(event.data?.message?.content)
        if (text.length > 0) texts.push(text)
        return
      }
      if (event.type === 'turn/end') settle()
    })
    let detached = false
    const detach = (): void => {
      if (detached) return
      detached = true
      this.#detachers.delete(detach)
      stop()
    }
    this.#detachers.add(detach)
    const cancelled = new AbortController()
    let fail: (error: Error) => void = () => {}
    const closed = new Promise<never>((_, reject) => {
      fail = reject
    })
    const running: RunningTurn = {
      abort(error: Error) {
        cancelled.abort(error)
        fail(error)
      },
    }
    this.#running.add(running)
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cancelled.abort()
        reject(new TurnTimeoutError(this.#timeoutMs))
      }, this.#timeoutMs)
      timer.unref()
    })
    const delivered = (async (): Promise<void> => {
      await this.#controller.prompt(
        { sessionId, requestId: input.requestId, mode: 'queue', content: [{ type: 'text', text: input.text }] },
        cancelled.signal,
      )
      await finished
    })()
    void delivered.catch(() => undefined)
    try {
      await Promise.race([delivered, expired, closed])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.#running.delete(running)
      detach()
    }
    return { sessionId, requestId: input.requestId, text: texts.join('\n') }
  }
}
