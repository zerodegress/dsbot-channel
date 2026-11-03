import { describe, expect, test } from 'vitest'
import type { TurnRef } from '../src/control-tools.js'
import { markToolRan } from '../src/tool-mark.js'

function turnRef(): TurnRef {
  return {
    eventId: 'req-1',
    eventKey: 'inst:1',
    eventKeys: ['inst:1'],
    chainId: 'chain-1',
    channel: 'p2p:orca',
    target: 'seal',
    sender: 'seal',
    bot: 'bot-a',
    sessionKey: 'p2p:orca',
    kind: 'p2p',
    scope: 'p2p',
    personId: null,
    toolRan: false,
    suppressed: false,
    pushed: false,
  }
}

type Call = (args: unknown, exec: unknown) => Promise<unknown>

describe('marking the turn a tool runs in', () => {
  test('marks before the tool body runs, so a failing tool still counts', async () => {
    const turn = turnRef()
    let seenInside = false
    const tool = markToolRan(
      {
        async execute(): Promise<unknown> {
          seenInside = turn.toolRan
          throw new Error('boom')
        },
      },
      (sessionId) => (sessionId === 'session-1' ? turn : undefined),
    )
    await expect((tool.execute as unknown as Call)({}, { agent: { id: 'session-1' } })).rejects.toThrow('boom')
    expect(seenInside).toBe(true)
    expect(turn.toolRan).toBe(true)
  })

  test('passes the result through', async () => {
    const turn = turnRef()
    const tool = markToolRan({ async execute(): Promise<unknown> { return 'done' } }, () => turn)
    await expect((tool.execute as unknown as Call)({}, { agent: { id: 'session-1' } })).resolves.toBe('done')
    expect(turn.toolRan).toBe(true)
  })

  test('leaves the turn alone when the session is unknown', async () => {
    const turn = turnRef()
    const tool = markToolRan(
      { async execute(): Promise<unknown> { return 1 } },
      (sessionId) => (sessionId === 'session-1' ? turn : undefined),
    )
    await (tool.execute as unknown as Call)({}, { agent: { id: 'other' } })
    expect(turn.toolRan).toBe(false)
    await (tool.execute as unknown as Call)({}, undefined)
    expect(turn.toolRan).toBe(false)
  })
})
