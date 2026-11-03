import { defineTool } from '@deepseek-ai/dsh-tools'
import { REFUSE_REASONS } from './contract.js'
import type { RefuseReason } from './contract.js'
import type { Scope } from './event-types.js'

/** What core knows about the turn a tool is running inside; nothing here is peer specific. */
export interface TurnRef {
  eventId: string
  /** The triggering message, which also names the batch's author. */
  eventKey: string
  /** Every event key the turn read, so evidence covers a merged batch. */
  eventKeys: string[]
  /** The chain root this turn belongs to. */
  chainId: string
  channel: string
  /** The address this turn answers on, as the adapter named it. */
  target: string
  sender: string
  /** The bot answering; one bot's notes never sit in another's directory. */
  bot: string
  sessionKey: string
  /** The adapter kind; a peer-to-peer turn has no impression partition. */
  kind: string
  scope: Scope
  /** The stamped identity of the triggering author, or null when the account is unbound. */
  personId: string | null
  /** Set when a side-effect tool wrote something, so the empty-turn warn tells the truth. */
  sideEffect: boolean
  /** Set by end or decline so the turn that just ran sends nothing back. */
  suppressed: boolean
  /** Set by decline, so a reader can tell a refusal from a quiet end. */
  declined?: boolean | undefined
  /** Why the refusal did not reach the sender, when it did not. */
  declinedCode?: string | undefined
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
  decline: (turn: TurnRef, reason: RefuseReason, note?: string) => Promise<DeclinedResult>
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
      return JSON.stringify({ ok: true, closed: true, outcome: 'ended' })
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
      reason: {
        type: 'string',
        required: true,
        enum: [...REFUSE_REASONS],
        description: 'Why the request is refused, from the closed set the channel can tell the sender',
      },
      note: { type: 'string', description: 'One optional line the sender sees with the refusal' },
    },
    output,
    async execute(
      args: { reason: string; note?: string },
      exec: { agent?: { id?: string }; concludeTurn: () => void },
    ): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      if (!(REFUSE_REASONS as readonly string[]).includes(args.reason)) {
        return JSON.stringify({
          ok: false,
          code: 'unsupported_argument',
          reason: `reason must be one of ${REFUSE_REASONS.join(', ')}, not "${args.reason}"`,
        })
      }
      const reason = args.reason as RefuseReason
      const already = ports.isClosed(turn.chainId)
      ports.closeChain(turn.chainId)
      turn.suppressed = true
      turn.declined = true
      if (already) {
        exec.concludeTurn()
        return JSON.stringify({ ok: true, closed: true, declined: false, already: true, outcome: 'refused' })
      }
      const sent = await ports.decline(turn, reason, args.note)
      exec.concludeTurn()
      if (sent.supported === false) {
        turn.declinedCode = 'unsupported'
        return JSON.stringify({ ok: true, closed: true, declined: false, reason: sent.reason, outcome: 'refused' })
      }
      if (!sent.ok) {
        turn.declinedCode = sent.code
        return JSON.stringify({ ok: false, closed: true, declined: false, code: sent.code, reason: sent.reason, outcome: 'refused' })
      }
      return JSON.stringify({ ok: true, closed: true, declined: true, outcome: 'refused' })
    },
  })
}
