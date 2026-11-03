import { describe, expect, test } from 'vitest'
import { createDeclineTool, createNoReplyTool } from '../src/control-tools.js'
import type { ControlPorts, TurnRef } from '../src/control-tools.js'

function harness(options: { declined?: { ok: boolean; code?: string; reason?: string } } = {}) {
  const closed: string[] = []
  const declined: { turn: TurnRef; reason: string; note: string | undefined }[] = []
  const concluded: number[] = []
  const turn: TurnRef = {
    eventId: 'probe-1',
    eventKey: 'p2p:orca:1',
    eventKeys: ['p2p:orca:1'],
    chainId: 'chain-1',
    channel: 'p2p:orca',
    target: 'seal',
    sender: 'seal',
    bot: 'bot-a',
    sessionKey: 'p2p:orca',
    kind: 'p2p',
    scope: 'p2p',
    personId: null,
    sideEffect: false,
    suppressed: false,
    pushed: false,
  }
  const closedNow = new Set<string>()
  const ports: ControlPorts = {
    turnOf: (sessionId) => (sessionId === 'session-1' ? turn : undefined),
    isClosed: (eventId) => closedNow.has(eventId),
    closeChain: (eventId) => {
      closed.push(eventId)
      closedNow.add(eventId)
    },
    decline: async (target, reason, note) => {
      declined.push({ turn: target, reason, note })
      return options.declined ?? { ok: true }
    },
  }
  const exec = (sessionId: string) =>
    ({
      agent: { id: sessionId },
      concludeTurn: () => {
        concluded.push(1)
      },
    }) as never
  return { turn, closed, declined, concluded, ports, exec }
}

describe('no_reply', () => {
  test('closes the chain, keeps the turn silent and concludes it', async () => {
    const { turn, closed, concluded, ports, exec } = harness()

    const raw = await createNoReplyTool(ports).execute({}, exec('session-1'))

    expect(JSON.parse(String(raw))).toEqual({ ok: true, closed: true, outcome: 'ended' })
    expect(closed).toEqual(['chain-1'])
    expect(turn.suppressed).toBe(true)
    expect(concluded).toHaveLength(1)
  })

  test('is refused outside a turn, so a session without one cannot close a chain', async () => {
    const { ports, exec } = harness()

    await expect(createNoReplyTool(ports).execute({}, exec('group-session'))).rejects.toThrow(
      'this tool is only available while answering a message',
    )
  })
})

describe('decline on a channel that cannot tell the sender', () => {
  test('closes the turn silently and says the refusal was not delivered', async () => {
    const { ports, exec, concluded } = harness()
    const unable: ControlPorts = {
      ...ports,
      decline: async () => ({ ok: false, supported: false, reason: 'this channel cannot carry a refusal' }),
    }

    const raw = await createDeclineTool(unable).execute({ reason: 'policy', note: 'no' }, exec('session-1'))
    const result = JSON.parse(raw as string) as Record<string, unknown>

    expect(result).toMatchObject({ ok: true, closed: true, declined: false })
    expect(concluded).toHaveLength(1)
  })
})

describe('decline', () => {
  test('tells the sender why, then keeps the turn silent', async () => {
    const { turn, closed, declined, concluded, ports, exec } = harness()

    const raw = await createDeclineTool(ports).execute({ reason: 'policy', note: 'not my job' }, exec('session-1'))

    expect(JSON.parse(String(raw))).toEqual({ ok: true, closed: true, declined: true, outcome: 'refused' })
    expect(declined).toHaveLength(1)
    expect(declined[0]?.reason).toBe('policy')
    expect(declined[0]?.note).toBe('not my job')
    expect(closed).toEqual(['chain-1'])
    expect(turn.suppressed).toBe(true)
    expect(concluded).toHaveLength(1)
  })

  test('reports a refusal that could not be delivered, and still closes the chain', async () => {
    const { closed, ports, exec } = harness({ declined: { ok: false, code: 'unreachable', reason: 'ECONNREFUSED' } })

    const raw = await createDeclineTool(ports).execute({ reason: 'policy', note: 'no' }, exec('session-1'))

    expect(JSON.parse(String(raw))).toMatchObject({ ok: false, closed: true, declined: false, code: 'unreachable' })
    expect(closed).toEqual(['chain-1'])
  })

  test('a reason outside the closed set is refused without sending or closing', async () => {
    const { closed, declined, ports, exec } = harness()

    await expect(createDeclineTool(ports).execute({ reason: 'because' }, exec('session-1'))).rejects.toThrow(
      /must be one of/,
    )
    expect(declined).toHaveLength(0)
    expect(closed).toHaveLength(0)
  })

  test('is refused outside a turn', async () => {
    const { ports, exec } = harness()

    await expect(createDeclineTool(ports).execute({ reason: 'policy' }, exec('group-session'))).rejects.toThrow()
  })
})
