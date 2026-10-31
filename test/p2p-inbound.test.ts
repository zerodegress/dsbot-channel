import { describe, expect, test } from 'vitest'
import { PeerSessions, TurnTimeoutError } from '../src/adapters/p2p/p2p-inbound.js'
import type { PromptRequest, SessionControllerLike, SessionEventLike } from '../src/adapters/p2p/p2p-inbound.js'

type Observer = (sessionId: string, event: SessionEventLike) => void

interface Recorded {
  request: PromptRequest
  signal: AbortSignal
}

class FakeController implements SessionControllerLike {
  readonly creates: unknown[] = []
  readonly prompts: Recorded[] = []
  onPrompt?: (request: PromptRequest) => void
  failCreate: Error | undefined
  failPrompt: Error | undefined
  #count = 0

  create(request: { cwd?: string; agentPreset?: string }): Promise<{ sessionId: string }> {
    this.creates.push(request)
    if (this.failCreate) return Promise.reject(this.failCreate)
    this.#count += 1
    return Promise.resolve({ sessionId: `session-${this.#count}` })
  }

  prompt(request: PromptRequest, signal: AbortSignal): Promise<{ accepted: boolean }> {
    signal.throwIfAborted()
    this.prompts.push({ request, signal })
    if (this.failPrompt) return Promise.reject(this.failPrompt)
    this.onPrompt?.(request)
    return Promise.resolve({ accepted: true })
  }
}

function bus(): {
  observe: (listener: Observer) => () => void
  emit: (sessionId: string, event: SessionEventLike) => void
  readonly size: number
} {
  const listeners = new Set<Observer>()
  return {
    observe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    emit: (sessionId, event) => {
      for (const listener of [...listeners]) listener(sessionId, event)
    },
    get size() {
      return listeners.size
    },
  }
}

function prompt_(requestId: string): SessionEventLike {
  return { type: 'user/message', data: { source: { rpcId: requestId }, content: [] } }
}

function assistant(text: string): SessionEventLike {
  return { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }
}

function turn(sessionId: string, emit: (sessionId: string, event: SessionEventLike) => void, texts: string[]): void {
  emit(sessionId, { type: 'turn/start' })
  for (const text of texts) emit(sessionId, assistant(text))
  emit(sessionId, { type: 'turn/end' })
}

function harness(options: { timeoutMs?: number; cwd?: string; agentPreset?: string; session?: string } = {}) {
  const controller = new FakeController()
  const events = bus()
  const bridge = new PeerSessions({ controller, observe: events.observe, ...options })
  return { controller, events, bridge }
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('a turn queued behind other work', () => {
  test('collects the answer of the turn its own message opened', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, prompt_(request.requestId))
      events.emit(request.sessionId, assistant('mine'))
      events.emit(request.sessionId, { type: 'turn/end' })
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('mine')
  })

  test('ignores the turn that was already running when the message was queued', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, prompt_('somebody-else'))
      events.emit(request.sessionId, assistant('theirs'))
      events.emit(request.sessionId, { type: 'turn/end' })
      events.emit(request.sessionId, prompt_(request.requestId))
      events.emit(request.sessionId, assistant('mine'))
      events.emit(request.sessionId, { type: 'turn/end' })
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('mine')
  })

  test('drops what an earlier turn of the session had already produced', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, { type: 'turn/start' })
      events.emit(request.sessionId, assistant('theirs'))
      events.emit(request.sessionId, prompt_(request.requestId))
      events.emit(request.sessionId, assistant('mine'))
      events.emit(request.sessionId, { type: 'turn/end' })
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('mine')
  })

  test('collects an answer that joins a turn already running, with no turn/start of its own', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, prompt_(request.requestId))
      events.emit(request.sessionId, assistant('queued answer'))
      events.emit(request.sessionId, { type: 'turn/end' })
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('queued answer')
  })
})

describe('peer sessions', () => {
  test('creates one session per peer and reuses it', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['first', 'second'])

    const first = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'one' })
    const second = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-2', text: 'two' })

    expect(controller.creates).toHaveLength(1)
    expect(first.sessionId).toBe('session-1')
    expect(second.sessionId).toBe('session-1')
    expect(controller.prompts).toHaveLength(2)
  })

  test('keeps a separate session for each peer', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    const a = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'a' })
    const b = await bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'b' })

    expect(controller.creates).toHaveLength(2)
    expect(a.sessionId).not.toBe(b.sessionId)
  })

  test('creates the session with the configured cwd and preset', async () => {
    const { controller, events, bridge } = harness({ cwd: '/tmp/sandbox', agentPreset: 'peer' })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(controller.creates[0]).toEqual({ cwd: '/tmp/sandbox', agentPreset: 'peer' })
  })

  test('runs the turn on the configured session and creates nothing', async () => {
    const { controller, events, bridge } = harness({ session: 'session-main' })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(controller.creates).toHaveLength(0)
    expect(controller.prompts[0]?.request.sessionId).toBe('session-main')
    expect(result.sessionId).toBe('session-main')
    expect(result.text).toBe('ok')
  })

  test('lands every peer in the one configured session', async () => {
    const { controller, events, bridge } = harness({ session: 'session-main' })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    const a = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'a' })
    const b = await bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'b' })

    expect(controller.creates).toHaveLength(0)
    expect(a.sessionId).toBe('session-main')
    expect(b.sessionId).toBe('session-main')
    expect(controller.prompts.map((entry) => entry.request.sessionId)).toEqual(['session-main', 'session-main'])
  })

  test('sends the inbound event id as the request id and a live cancellation signal', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-42', text: 'hi' })

    const recorded = controller.prompts[0]
    expect(recorded?.request.requestId).toBe('evt-42')
    expect(recorded?.request.mode).toBe('queue')
    expect(recorded?.request.sessionId).toBe('session-1')
    expect(recorded?.signal).toBeInstanceOf(AbortSignal)
    expect(typeof recorded?.signal.throwIfAborted).toBe('function')
    expect(recorded?.signal.aborted).toBe(false)
  })

  test('prompts the text exactly as received so the prefix is not doubled', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])
    const text = '[p2p from peer-a · sender-1 · evt-1] hello'

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text })

    expect(controller.prompts[0]?.request.content).toEqual([{ type: 'text', text }])
  })

  test('ignores the closing edge of a turn that started before the prompt', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, assistant('leaked'))
      events.emit(request.sessionId, { type: 'turn/end' })
      turn(request.sessionId, events.emit, ['mine'])
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('mine')
  })

  test('ignores events that belong to another session', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit('session-99', { type: 'turn/start' })
      events.emit('session-99', assistant('leaked'))
      events.emit('session-99', { type: 'turn/end' })
      turn(request.sessionId, events.emit, ['mine'])
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('mine')
  })

  test('joins several assistant messages in one turn', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['one', 'two'])

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('one\ntwo')
  })

  test('skips an assistant message that carries no content', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => {
      events.emit(request.sessionId, { type: 'turn/start' })
      events.emit(request.sessionId, { type: 'assistant/message', data: { message: { content: [] } } })
      events.emit(request.sessionId, assistant('after'))
      events.emit(request.sessionId, { type: 'turn/end' })
    }

    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(result.text).toBe('after')
  })

  test('detaches its observer once the turn settles', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(events.size).toBe(0)
  })

  test('fails a turn that never finishes', async () => {
    const { controller, events, bridge } = harness({ timeoutMs: 20 })
    controller.onPrompt = (request) => events.emit(request.sessionId, { type: 'turn/start' })

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).rejects.toBeInstanceOf(
      TurnTimeoutError,
    )
    expect(events.size).toBe(0)
  })

  test('cancels the signal it handed the controller when the turn runs out', async () => {
    const { controller, events, bridge } = harness({ timeoutMs: 20 })
    controller.onPrompt = (request) => events.emit(request.sessionId, { type: 'turn/start' })

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).rejects.toBeInstanceOf(
      TurnTimeoutError,
    )
    expect(controller.prompts[0]?.signal.aborted).toBe(true)
  })

  test('keeps one turn in flight per peer', async () => {
    const { controller, events, bridge } = harness()
    const pending: (() => void)[] = []
    controller.onPrompt = (request) => {
      pending.push(() => turn(request.sessionId, events.emit, [`reply ${request.requestId}`]))
    }

    const first = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'one' })
    await flush()
    const second = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-2', text: 'two' })
    await flush()

    expect(pending).toHaveLength(1)
    expect(controller.prompts).toHaveLength(1)

    pending[0]?.()
    await expect(first).resolves.toMatchObject({ text: 'reply evt-1' })
    await flush()
    expect(controller.prompts).toHaveLength(2)

    pending[1]?.()
    await expect(second).resolves.toMatchObject({ text: 'reply evt-2' })
  })

  test('runs different peers in parallel', async () => {
    const { controller, events, bridge } = harness()
    const pending: (() => void)[] = []
    controller.onPrompt = (request) => {
      pending.push(() => turn(request.sessionId, events.emit, [`reply ${request.requestId}`]))
    }

    const first = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'one' })
    const second = bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'two' })
    await flush()

    expect(controller.prompts).toHaveLength(2)
    for (const settle of pending) settle()
    await expect(first).resolves.toMatchObject({ text: 'reply evt-1' })
    await expect(second).resolves.toMatchObject({ text: 'reply evt-2' })
  })

  test('propagates a prompt failure and still detaches the observer', async () => {
    const { controller, bridge } = harness()
    controller.failPrompt = new Error('session/not-found')

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).rejects.toThrow(
      'session/not-found',
    )
  })

  test('retries creation after the host refuses the first attempt', async () => {
    const { controller, events, bridge } = harness()
    controller.failCreate = new Error('session/agent-busy')
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).rejects.toThrow('agent-busy')

    controller.failCreate = undefined
    const result = await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-2', text: 'hi' })

    expect(result.text).toBe('ok')
    expect(controller.creates).toHaveLength(2)
  })
})
