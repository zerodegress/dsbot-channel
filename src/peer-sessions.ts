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

export interface SessionControllerLike {
  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }>
  prompt(request: PromptRequest, signal: AbortSignal): Promise<{ accepted: boolean }>
}

export interface PeerSessionsOptions {
  controller: SessionControllerLike
  observe: (listener: (sessionId: string, event: SessionEventLike) => void) => () => void
  /** An existing session every peer turn runs in, instead of one created per peer. */
  session?: string
  timeoutMs?: number
  cwd?: string
  agentPreset?: string
}

export interface PeerTurnInput {
  peer: string
  requestId: string
  text: string
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
  readonly #session: string | undefined
  readonly #timeoutMs: number
  readonly #cwd: string | undefined
  readonly #agentPreset: string | undefined
  readonly #sessions = new Map<string, Promise<string>>()
  readonly #tail = new Map<string, Promise<void>>()
  readonly #running = new Set<RunningTurn>()
  readonly #detachers = new Set<() => void>()
  #disposed = false

  constructor(options: PeerSessionsOptions) {
    this.#controller = options.controller
    this.#observe = options.observe
    this.#session = options.session
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    this.#cwd = options.cwd
    this.#agentPreset = options.agentPreset
  }

  /** Stops every turn in flight and drops what the bridge held; safe to call more than once. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    const error = new Error('the peer sessions were disposed')
    for (const running of [...this.#running]) running.abort(error)
    this.#running.clear()
    for (const detach of [...this.#detachers]) detach()
    this.#sessions.clear()
    this.#tail.clear()
  }

  /** Creates the peer session once and hands the same identity to every later turn. */
  sessionFor(peer: string): Promise<string> {
    if (this.#disposed) return Promise.reject(new Error('the peer sessions were disposed'))
    if (this.#session !== undefined) return Promise.resolve(this.#session)
    const cached = this.#sessions.get(peer)
    if (cached !== undefined) return cached
    const created = this.#controller
      .create({
        ...(this.#cwd === undefined ? {} : { cwd: this.#cwd }),
        ...(this.#agentPreset === undefined ? {} : { agentPreset: this.#agentPreset }),
      })
      .then((result) => {
        const sessionId = result?.sessionId
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new Error('session create returned no session id')
        }
        return sessionId
      })
    this.#sessions.set(peer, created)
    void created.catch(() => {
      if (this.#sessions.get(peer) === created) this.#sessions.delete(peer)
    })
    return created
  }

  /** Queues a turn behind the peer's previous one so replies stay attributable. */
  runTurn(input: PeerTurnInput): Promise<PeerTurn> {
    if (this.#disposed) return Promise.reject(new Error('the peer sessions were disposed'))
    const previous = this.#tail.get(input.peer) ?? Promise.resolve()
    const run = previous.then(
      () => this.#runTurn(input),
      () => this.#runTurn(input),
    )
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.#tail.set(input.peer, tail)
    void tail.then(() => {
      if (this.#tail.get(input.peer) === tail) this.#tail.delete(input.peer)
    })
    return run
  }

  async #runTurn(input: PeerTurnInput): Promise<PeerTurn> {
    if (this.#disposed) throw new Error('the peer sessions were disposed')
    const sessionId = await this.sessionFor(input.peer)
    if (this.#disposed) throw new Error('the peer sessions were disposed')
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
