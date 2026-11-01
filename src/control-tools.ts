import { defineTool } from '@deepseek-ai/dsh-tools'

/** What core knows about the turn a tool is running inside; nothing here is peer specific. */
export interface TurnRef {
  eventId: string
  /** The chain root this turn belongs to. */
  chainId: string
  channel: string
  /** The address this turn answers on, as the adapter named it. */
  target: string
  sender: string
  /** Set by end or decline so the turn that just ran sends nothing back. */
  suppressed: boolean
  /** Set when this turn pushed with send_text, so the reply is not sent twice. */
  pushed: boolean
}

export interface DeclinedResult {
  ok: boolean
  /** False when the channel cannot carry a refusal at all, so the tool closes silently instead. */
  supported?: boolean | undefined
  code?: string | undefined
  reason?: string | undefined
}

export interface ControlPorts {
  turnOf: (sessionId: string | undefined) => TurnRef | undefined
  isClosed: (chainId: string) => boolean
  closeChain: (chainId: string) => void
  decline: (turn: TurnRef, reason: string | undefined) => Promise<DeclinedResult>
}

const NO_TURN = 'this tool is only available while answering a message'

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

/** Closes the conversation without a byte leaving this instance. */
export function createNoReplyTool(ports: ControlPorts) {
  return defineTool({
    name: 'no_reply',
    description:
      'Close this conversation without sending anything back. Use it when the message needs no answer.',
    parameters: {},
    output,
    async execute(_args: unknown, exec: { agent?: { id?: string }; concludeTurn: () => void }): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      ports.closeChain(turn.chainId)
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
      'Refuse this request and tell the sender why. The conversation is not answered further and closes.',
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
      const already = ports.isClosed(turn.chainId)
      ports.closeChain(turn.chainId)
      turn.suppressed = true
      if (already) {
        exec.concludeTurn()
        return JSON.stringify({ ok: true, closed: true, declined: false, already: true })
      }
      const sent = await ports.decline(turn, args.reason)
      exec.concludeTurn()
      if (sent.supported === false) {
        return JSON.stringify({ ok: true, closed: true, declined: false, reason: sent.reason })
      }
      if (!sent.ok) {
        return JSON.stringify({ ok: false, closed: true, declined: false, code: sent.code, reason: sent.reason })
      }
      return JSON.stringify({ ok: true, closed: true, declined: true })
    },
  })
}
