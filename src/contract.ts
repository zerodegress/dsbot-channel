import type { AdapterStatus, CapabilitySet } from './adapter-status.js'
import type { Author, Body, DeclaredMeta, Scope, Source, TransportMeta } from './event-types.js'
import type { MediaOwner, MediaType } from './event-types.js'
import type { PipelineEvent } from './pipeline.js'

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

export const MESSAGE_KINDS = ['message', 'notice', 'request', 'meta'] as const
export type MessageKind = (typeof MESSAGE_KINDS)[number]

/** What a non-message event is, in the transport's own class names, never the raw payload. */
export interface EventDescriptor {
  postType: string
  /**
   * The transport's own event type inside that post type, e.g. `group_recall`.
   * A self echo reads as `notice` + `sent` here; the status counts it as `message_sent`.
   */
  type: string
  subType?: string | undefined
}

export interface InboundMessage {
  /** Built by the adapter; core only consumes it. */
  eventKey: string
  /** What this event is; an adapter that does not say carries a message. */
  kind?: MessageKind | undefined
  /** The transport's class for a non-message event. */
  event?: EventDescriptor | undefined
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
  /** The transport's raw payload; core carries it and never reads it. */
  adapter: Record<string, unknown>
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
  /** The transport cannot carry this request at all: no such action, or no way to read the source. */
  | 'unsupported'

export interface SendSuccess {
  ok: true
  /** The transport's receipt for this send; opaque, never parsed, and `local:` when it gives none. */
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

/** One message read back from a transport. */
export interface HistoryRecord {
  messageId: string
  /** The adapter's own cursor for this record; the same value travels back as `before`. */
  cursor: string
  /** Milliseconds since the epoch, as the transport stamped it. */
  timestamp: number
  senderId: string
  /** Display name the transport reported, when it reports one. */
  nickname?: string | undefined
  /** What the sender said, without the transport's own header. */
  text: string
}

export interface HistoryInput {
  /** The address to read, as the adapter spells it. */
  target: string
  /** The adapter's own cursor; core never parses it. */
  before?: string | undefined
  limit: number
}

/** A page of history, or why the transport could not read one. */
export type HistoryResult =
  | { ok: true; records: HistoryRecord[]; next?: string | undefined }
  | { ok: false; code: SendFailureCode; reason: string }

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

/** One media item on the way out: a url anyone can fetch, a handle only its owner can resolve. */
export interface OutboundMedia {
  type: MediaType
  url: string | null
  handle: string | null
  /** The name a file carries; required when `type` is `file`, ignored otherwise. */
  name?: string | undefined
  /** Required with a handle: the instance that issued it, which must be the one sending. */
  owner?: MediaOwner | undefined
}

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
  /** Media to carry with the text, in order; an adapter drops what it cannot carry. */
  media?: readonly OutboundMedia[] | undefined
  sender: string
  instance: string
  sentAt?: number | undefined
  timeoutMs?: number | undefined
}

export interface AdapterPorts {
  /**
   * Takes one inbound message; resolves once core has accepted or refused it, never when the turn
   * ends. A 2xx answer means the transport claimed and recorded the event, not that a turn ran:
   * a refusal, a failed turn or a fault of ours afterwards does not change that status. Only a
   * request that is itself unusable (credentials, address, window, size, not JSON) earns a 4xx, or
   * a 5xx when the first delivery of the same event is still being processed and a retry may help.
   */
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
  /** Names the scope a session key belongs to, when the adapter can tell; core never parses the key. */
  sessionScope?(key: string): Scope | undefined
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
  /**
   * Reads earlier messages from an address. Present only when the transport can page
   * history; `capabilities.history` says for which kind of address.
   */
  history?(input: HistoryInput): Promise<HistoryResult>
  /**
   * Runs before every turn that reaches the prepare node, as a side effect only: it cannot
   * answer, cannot see the prompt and is never charged. Synchronous by contract.
   */
  prepare?(input: PrepareInput): void
  start(ports: AdapterPorts): Promise<AdapterHandle>
}

/** Everything an adapter's per-turn hook may read: the event and the conversation it belongs to. */
export interface PrepareInput {
  event: PipelineEvent
  sessionKey: string
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
