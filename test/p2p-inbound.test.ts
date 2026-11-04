import { describe, expect, test } from 'vitest'
import { PeerSessions, TurnTimeoutError } from '../src/peer-sessions.js'
import type { PromptRequest, SessionControllerLike, SessionEventLike } from '../src/peer-sessions.js'

type Observer = (sessionId: string, event: SessionEventLike) => void

interface Recorded {
  request: PromptRequest
  signal: AbortSignal
}

class FakeController implements SessionControllerLike {
  readonly creates: unknown[] = []
  readonly prompts: Recorded[] = []
  readonly models: { sessionId: string; provider: string; model: string }[] = []
  onPrompt?: (request: PromptRequest) => void
  failCreate: Error | undefined
  failPrompt: Error | undefined
  failModel: Error | undefined
  #count = 0

  selectModel(request: { sessionId: string; provider: string; model: string }): Promise<unknown> {
    this.models.push(request)
    if (this.failModel) return Promise.reject(this.failModel)
    return Promise.resolve({ selected: { provider: request.provider, model: request.model } })
  }

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

function harness(
  options: {
    timeoutMs?: number
    cwd?: string
    agentPreset?: string
    session?: string
    model?: { provider: string; model: string }
    warn?: (message: string) => void
  } = {},
) {
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

describe('the model a bridge runs', () => {
  const route = { provider: 'deepseek', model: 'deepseek-chat' }

  test('selects the configured model once per session', async () => {
    const { controller, events, bridge } = harness({ model: route })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'one' })
    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-2', text: 'two' })

    expect(controller.models).toEqual([{ sessionId: 'session-1', provider: 'deepseek', model: 'deepseek-chat' }])
  })

  test('selects once for each peer session', async () => {
    const { controller, events, bridge } = harness({ model: route })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'a' })
    await bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'b' })

    expect(controller.models.map((one) => one.sessionId)).toEqual(['session-1', 'session-2'])
  })

  test('selects on the one configured session too', async () => {
    const { controller, events, bridge } = harness({ session: 'session-main', model: route })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(controller.models).toEqual([{ sessionId: 'session-main', provider: 'deepseek', model: 'deepseek-chat' }])
  })

  test('two peers on one fixed session wait for the same selection', async () => {
    const { controller, events, bridge } = harness({ session: 'session-main', model: route })
    void events
    let release: () => void = () => undefined
    const selection = new Promise<void>((resolve) => {
      release = resolve
    })
    let selects = 0
    controller.selectModel = () => {
      selects += 1
      return selection.then(() => ({}))
    }

    const first = bridge.sessionFor('peer-a')
    const second = bridge.sessionFor('peer-b')
    let settled = 0
    void first.then(() => {
      settled += 1
    })
    void second.then(() => {
      settled += 1
    })
    await flush()

    expect(selects).toBe(1)
    expect(settled).toBe(0)
    release()
    await expect(first).resolves.toBe('session-main')
    await expect(second).resolves.toBe('session-main')
    expect(settled).toBe(2)
  })

  test('a rejected selection still hands out the session', async () => {
    const { controller, events, bridge } = harness({ session: 'session-main', model: route })
    void events
    controller.selectModel = () => Promise.reject(new Error('no such model'))
    const warnings: string[] = []
    const bridgeWithWarn = new PeerSessions({
      controller,
      observe: events.observe,
      session: 'session-main',
      model: route,
      warn: (line) => warnings.push(line),
    })
    void bridge

    await expect(bridgeWithWarn.sessionFor('peer-a')).resolves.toBe('session-main')
    await expect(bridgeWithWarn.sessionFor('peer-b')).resolves.toBe('session-main')
    expect(warnings.some((line) => line.includes('no such model'))).toBe(true)
  })

  test('a host without a selector warns once across peer sessions', async () => {
    const events = bus()
    const warnings: string[] = []
    let count = 0
    const controller = {
      create: () => {
        count += 1
        return Promise.resolve({ sessionId: `session-${count}` })
      },
      prompt: (request: PromptRequest) => {
        turn(request.sessionId, events.emit, ['ok'])
        return Promise.resolve({ accepted: true })
      },
    }
    const bridge = new PeerSessions({
      controller,
      observe: events.observe,
      model: route,
      warn: (line) => warnings.push(line),
    })

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'a' })
    await bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'b' })

    expect(warnings).toHaveLength(1)
  })

  test('a host without a selector only warns and the turn still runs', async () => {
    const events = bus()
    const warnings: string[] = []
    const controller = {
      create: () => Promise.resolve({ sessionId: 'session-1' }),
      prompt: (request: PromptRequest, signal: AbortSignal) => {
        signal.throwIfAborted()
        turn('session-1', events.emit, ['ok'])
        void request
        return Promise.resolve({ accepted: true })
      },
    }
    const bridge = new PeerSessions({ controller, observe: events.observe, model: route, warn: (line) => warnings.push(line) })

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).resolves.toMatchObject({
      text: 'ok',
    })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('cannot select one')
  })

  test('a rejected selection warns and the turn still runs', async () => {
    const warnings: string[] = []
    const { controller, events, bridge } = harness({ model: route, warn: (line) => warnings.push(line) })
    controller.failModel = new Error('no such model')
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).resolves.toMatchObject({
      text: 'ok',
    })
    expect(warnings.some((line) => line.includes('no such model'))).toBe(true)
  })

  test('no model configured never touches the selector', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(controller.models).toEqual([])
  })
})

describe('disposing the bridge', () => {
  test('cancels the turn it is waiting on', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => events.emit(request.sessionId, { type: 'turn/start' })

    const running = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })
    await flush()
    expect(controller.prompts).toHaveLength(1)

    bridge.dispose()

    await expect(running).rejects.toThrow('the peer sessions were disposed')
    expect(controller.prompts[0]?.signal.aborted).toBe(true)
    expect(events.size).toBe(0)
  })

  test('cancels a queued turn before it prompts', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => events.emit(request.sessionId, { type: 'turn/start' })

    const first = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'one' })
    await flush()
    const second = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-2', text: 'two' })
    await flush()
    expect(controller.prompts).toHaveLength(1)

    bridge.dispose()

    await expect(first).rejects.toThrow('the peer sessions were disposed')
    await expect(second).rejects.toThrow('the peer sessions were disposed')
    expect(controller.prompts).toHaveLength(1)
  })

  test('is idempotent and detaches every observer it registered', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => events.emit(request.sessionId, { type: 'turn/start' })

    const running = bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })
    await flush()

    bridge.dispose()
    bridge.dispose()

    await expect(running).rejects.toThrow('the peer sessions were disposed')
    expect(events.size).toBe(0)
  })

  test('refuses a turn asked for after it was disposed', async () => {
    const { controller, bridge } = harness()

    bridge.dispose()

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).rejects.toThrow(
      'the peer sessions were disposed',
    )
    await expect(bridge.sessionFor('peer-a')).rejects.toThrow('the peer sessions were disposed')
    expect(controller.creates).toHaveLength(0)
  })

  test('a turn that finishes normally leaves nothing behind', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).resolves.toMatchObject({
      text: 'ok',
    })

    bridge.dispose()
    expect(events.size).toBe(0)
  })
})

describe('the model selection a bridge reports', () => {
  const route = { provider: 'deepseek', model: 'deepseek-chat' }

  test('reports nothing when the profile names no model', async () => {
    const { controller, events, bridge } = harness()
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(bridge.modelSelection).toBeUndefined()
  })

  test('a host without a selector is unsupported before any turn', () => {
    const events = bus()
    const bridge = new PeerSessions({
      controller: {
        create: () => Promise.resolve({ sessionId: 'session-1' }),
        prompt: () => Promise.resolve({ accepted: true }),
      },
      observe: events.observe,
      model: route,
    })

    expect(bridge.modelSelection).toEqual({ requested: 'deepseek/deepseek-chat', state: 'unsupported' })
    bridge.dispose()
  })

  test('a selection the host takes is applied', async () => {
    const { controller, events, bridge } = harness({ model: route })
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    expect(bridge.modelSelection).toBeUndefined()
    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })

    expect(bridge.modelSelection).toEqual({ requested: 'deepseek/deepseek-chat', state: 'applied' })
  })

  test('a refused selection is rejected and the turn still runs', async () => {
    const { controller, events, bridge } = harness({ model: route })
    controller.failModel = new Error('no such model')
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await expect(bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })).resolves.toMatchObject({
      text: 'ok',
    })

    expect(bridge.modelSelection).toEqual({ requested: 'deepseek/deepseek-chat', state: 'rejected' })
  })

  test('the state follows the last attempt, not the first', async () => {
    const { controller, events, bridge } = harness({ model: route })
    controller.failModel = new Error('no such model')
    controller.onPrompt = (request) => turn(request.sessionId, events.emit, ['ok'])

    await bridge.runTurn({ peer: 'peer-a', requestId: 'evt-1', text: 'hi' })
    expect(bridge.modelSelection?.state).toBe('rejected')

    controller.failModel = undefined
    await bridge.runTurn({ peer: 'peer-b', requestId: 'evt-2', text: 'there' })

    expect(bridge.modelSelection?.state).toBe('applied')
  })
})
