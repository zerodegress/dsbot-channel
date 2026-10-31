import { describe, expect, test } from 'vitest'
import { createDeclineTool, createNoReplyTool } from '../src/control-tools.js'
import type { ControlPorts, PeerTurnRef } from '../src/control-tools.js'

function harness(options: { declined?: { ok: boolean; code?: string; reason?: string } } = {}) {
  const closed: string[] = []
  const declined: { turn: PeerTurnRef; reason: string | undefined }[] = []
  const concluded: number[] = []
  const turn: PeerTurnRef = { eventId: 'probe-1', chainId: 'chain-1', channel: 'p2p:orca', target: 'seal', sender: 'seal', suppressed: false, pushed: false }
  const closedNow = new Set<string>()
  const ports: ControlPorts = {
    turnOf: (sessionId) => (sessionId === 'session-1' ? turn : undefined),
    isClosed: (eventId) => closedNow.has(eventId),
    closeChain: (eventId) => {
      closed.push(eventId)
      closedNow.add(eventId)
    },
    decline: async (target, reason) => {
      declined.push({ turn: target, reason })
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

    expect(JSON.parse(String(raw))).toEqual({ ok: true, closed: true })
    expect(closed).toEqual(['chain-1'])
    expect(turn.suppressed).toBe(true)
    expect(concluded).toHaveLength(1)
  })

  test('is refused outside a peer turn, so a group turn cannot close a chain', async () => {
    const { ports, exec } = harness()

    await expect(createNoReplyTool(ports).execute({}, exec('group-session'))).rejects.toThrow(
      'this tool is only available while answering a peer message',
    )
  })
})

describe('decline', () => {
  test('tells the peer why, then keeps the turn silent', async () => {
    const { turn, closed, declined, concluded, ports, exec } = harness()

    const raw = await createDeclineTool(ports).execute({ reason: 'not my job' }, exec('session-1'))

    expect(JSON.parse(String(raw))).toEqual({ ok: true, closed: true, declined: true })
    expect(declined).toHaveLength(1)
    expect(declined[0]?.reason).toBe('not my job')
    expect(closed).toEqual(['chain-1'])
    expect(turn.suppressed).toBe(true)
    expect(concluded).toHaveLength(1)
  })

  test('reports a refusal that could not be delivered, and still closes the chain', async () => {
    const { closed, ports, exec } = harness({ declined: { ok: false, code: 'unreachable', reason: 'ECONNREFUSED' } })

    const raw = await createDeclineTool(ports).execute({ reason: 'no' }, exec('session-1'))

    expect(JSON.parse(String(raw))).toMatchObject({ ok: false, closed: true, declined: false, code: 'unreachable' })
    expect(closed).toEqual(['chain-1'])
  })

  test('is refused outside a peer turn', async () => {
    const { ports, exec } = harness()

    await expect(createDeclineTool(ports).execute({ reason: 'no' }, exec('group-session'))).rejects.toThrow()
  })
})
