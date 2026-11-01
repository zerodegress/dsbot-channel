import type { AdapterStatus, CapabilitySet } from './adapter-status.js'
import type { Author, Body, DeclaredMeta, Source, TransportMeta } from './event-types.js'

/** Why core refused to take an inbound message; the adapter maps it onto its own error. */
export const INBOUND_REJECTIONS = [
  'session_key_invalid',
  'source_kind_invalid',
  'request_id_invalid',
  'reply_target_invalid',
  'event_key_conflict',
  'chain_conflict',
  'busy',
  'rejected',
] as const
export type InboundRejection = (typeof INBOUND_REJECTIONS)[number]

export interface InboundMessage {
  /** Built by the adapter; core only consumes it. */
  eventKey: string
  /** Opaque dictionary key; core never parses it. */
  sessionKey: string
  /** The address of the conversation this message came from; core never parses it. */
  replyTarget: string
  /** The platform's own id for this message; core hands it to the host as rpcId, unparsed. */
  requestId: string
  /** The adapter already knows this turn must not answer: the sender declined, or it answered elsewhere. */
  suppressed?: boolean | undefined
  /** The root event of the conversation, from the adapter; core never derives it. */
  chainId: string
  source: Source
  author: Author
  /** What the platform sent, before the adapter adds its own header; core matches policy on this. */
  rawText: string
  body: Body
  transport: TransportMeta
  declared: DeclaredMeta
  receivedAt: number
}

export type InboundVerdict =
  | { ok: true }
  | { ok: false; code: InboundRejection; reason: string }

export type SendFailureCode =
  | 'no_url'
  | 'protocol_mismatch'
  | 'credential'
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'busy'
  | 'rejected'

export interface SendSuccess {
  ok: true
  messageId: string
  duplicate: boolean
}

export interface SendFailure {
  ok: false
  code: SendFailureCode
  retryable: boolean
  reason: string
}

export type SendResult = SendSuccess | SendFailure

/** Why a turn is refused; closed, so every transport tells the sender the same story. */
export const REFUSE_REASONS = ['unsupported', 'unavailable', 'unauthorized', 'too-busy', 'policy'] as const
export type RefuseReason = (typeof REFUSE_REASONS)[number]

export interface RefuseInput {
  /** The address the refusal goes back on; the adapter supplied it with the inbound message. */
  target: string
  /** Who to tell inside that conversation; same meaning as in SendInput. */
  to?: string | undefined
  /** The message being refused, so the sender can correlate it: the inbound requestId. */
  inReplyTo: string
  /** The chain it belongs to, so a refusal stays inside one conversation. */
  chainId: string
  /** Machine-readable; the adapter turns it into its platform's own wording. */
  reason: RefuseReason
  /** One bounded human line, optional; the adapter may trim it for its wire. */
  note?: string | undefined
}

export type RefuseResult = { ok: true } | { ok: false; code: SendFailureCode; reason: string }

export interface SendInput {
  /** The adapter's own address for the recipient; core never parses it. */
  target: string
  /** The bot identity the message is addressed to; an adapter may ignore it. */
  to?: string | undefined
  eventId: string
  chainId?: string | undefined
  inReplyTo?: string | undefined
  /** The text being answered; the adapter trims it for the peer's header. */
  inReplyToText?: string | undefined
  body: string
  sender: string
  instance: string
  sentAt?: number | undefined
  timeoutMs?: number | undefined
}

export interface AdapterPorts {
  /** Takes one inbound message; resolves once core has accepted or refused it, never when the turn ends. */
  onMessage(message: InboundMessage): Promise<InboundVerdict>
  resolveSecret(ref: string): Promise<string | undefined>
}

export interface AdapterHandle {
  stop(): Promise<void>
  /** The bound address, for a transport that listens on one; core only passes it to its host. */
  address?: (() => { port: number }) | undefined
}

export interface AdapterCheckSettings {
  /** The turn ceiling core enforces, so an adapter can size its own in-flight window above it. */
  maxTurnMs: number
}

export interface ChannelAdapter {
  /**
   * Names this transport's implementation: one kind has one factory, while many adapters may
   * reuse it (two p2p links are two adapters of `p2p`). Every message it delivers must carry
   * this same kind in `source.kind`.
   */
  kind: string
  /**
   * What this transport can carry, known at mount time. Unlike `status().capabilities`,
   * which samples the live link, this answers "may core rely on it" before any message.
   */
  readonly capabilities: CapabilitySet
  /** Checks what the transport needs at mount time and throws ConfigError on a bad profile. */
  checkConfig(settings: AdapterCheckSettings): void
  /** Returns why a session key is unusable, or undefined when it is; core never parses the key. */
  checkSessionKey(key: string): string | undefined
  /** Returns why an explicitly named target is unusable, or undefined when it is. */
  checkTarget(target: string): string | undefined
  /** One line naming the addresses this adapter accepts, for an error message. */
  describeTargets(): string
  guidance: { peer: string; group: string }
  status(): AdapterStatus
  send(input: SendInput): Promise<SendResult>
  /**
   * Tells the sender this turn is refused. Present only when the transport can carry a
   * refusal; core falls back to closing silently when it is absent.
   */
  refuse?(input: RefuseInput): Promise<RefuseResult>
  start(ports: AdapterPorts): Promise<AdapterHandle>
}

/** Longest session key core accepts before asking the adapter. */
export const SESSION_KEY_MAX = 128

/** Longest platform message id core hands to the host untouched. */
export const REQUEST_ID_MAX = 256

/** Longest chain root core accepts from an adapter. */
export const CHAIN_ID_MAX = 256

/** The guidance an adapter may inject once per session, bounded so a profile cannot blow the context. */
export const GUIDANCE_MAX = 400

/** Longest reply address core accepts before asking the adapter. */
export const REPLY_TARGET_MAX = 256

/** Why a token is unusable, or undefined when it is: non-empty, one line, printable, bounded. */
export function tokenProblem(name: string, value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return `${name} must be a non-empty string`
  if (Array.from(value).length > max) return `${name} is longer than ${max} characters`
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) return `${name} must be one line of printable characters without spaces`
  }
  return undefined
}
