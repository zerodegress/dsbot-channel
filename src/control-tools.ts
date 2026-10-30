import { defineTool } from '@deepseek-ai/dsh-tools'

export interface PeerTurnRef {
  eventId: string
  channel: string
  peer: string
  sender: string
  /** Set by end or decline so the turn that just ran sends nothing back. */
  suppressed: boolean
  /** Set when this turn pushed with send_text, so the reply is not sent twice. */
  pushed: boolean
}

export interface DeclinedResult {
  ok: boolean
  code?: string | undefined
  reason?: string | undefined
}

export interface ControlPorts {
  turnOf: (sessionId: string | undefined) => PeerTurnRef | undefined
  isClosed: (eventId: string) => boolean
  closeChain: (eventId: string) => void
  decline: (turn: PeerTurnRef, reason: string | undefined) => Promise<DeclinedResult>
}

const NO_TURN = 'this tool is only available while answering a peer message'

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** Closes the conversation without a byte leaving this instance. */
export function createEndTool(ports: ControlPorts) {
  return defineTool({
    name: 'end',
    description: 'End this peer conversation without sending anything back. Use it when the message needs no answer.',
    parameters: {},
    output,
    async execute(_args: unknown, exec: { agent?: { id?: string }; concludeTurn: () => void }): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      ports.closeChain(turn.eventId)
      turn.suppressed = true
      exec.concludeTurn()
      return JSON.stringify({ ok: true, closed: true })
    },
  })
}

/** Refuses the request, tells the peer why, and closes the conversation. */
export function createDeclineTool(ports: ControlPorts) {
  return defineTool({
    name: 'decline',
    description:
      'Refuse this peer request and tell the peer why. The peer is not answered further and the conversation closes.',
    parameters: {
      reason: { type: 'string', required: true, description: 'Why the request is refused, in one line' },
    },
    output,
    async execute(
      args: { reason: string },
      exec: { agent?: { id?: string }; concludeTurn: () => void },
    ): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      const already = ports.isClosed(turn.eventId)
      ports.closeChain(turn.eventId)
      turn.suppressed = true
      if (already) {
        exec.concludeTurn()
        return JSON.stringify({ ok: true, closed: true, declined: false, already: true })
      }
      const sent = await ports.decline(turn, args.reason)
      exec.concludeTurn()
      if (!sent.ok) {
        return JSON.stringify({ ok: false, closed: true, declined: false, code: sent.code, reason: sent.reason })
      }
      return JSON.stringify({ ok: true, closed: true, declined: true })
    },
  })
}
