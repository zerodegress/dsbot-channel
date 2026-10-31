import type { AdapterStatus } from './adapter-status.js'
import type { Author, Body, DeclaredMeta, Source, TransportMeta } from './event-types.js'

/** Why core refused to take an inbound message; the adapter maps it onto its own error. */
export const INBOUND_REJECTIONS = [
  'session_key_invalid',
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
  chainId: string
  source: Source
  author: Author
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

export interface SendInput {
  /** The adapter's own address for the recipient; core never parses it. */
  target: string
  eventId: string
  chainId?: string | undefined
  inReplyTo?: string | undefined
  body: string
  sender: string
  instance: string
  sentAt?: number | undefined
  timeoutMs?: number | undefined
  status?: 'declined' | undefined
  reason?: string | undefined
  final?: boolean | undefined
}

export interface AdapterPorts {
  /** Takes one inbound message; resolves once core has accepted or refused it, never when the turn ends. */
  onMessage(message: InboundMessage): Promise<InboundVerdict>
  resolveSecret(ref: string): Promise<string | undefined>
}

export interface AdapterHandle {
  stop(): Promise<void>
}

export interface ChannelAdapter {
  kind: string
  /** Checks what the transport needs at mount time and throws ConfigError on a bad profile. */
  checkConfig(): void
  /** Returns why a session key is unusable, or undefined when it is; core never parses the key. */
  checkSessionKey(key: string): string | undefined
  guidance: { peer: string; group: string }
  status(): AdapterStatus
  send(input: SendInput): Promise<SendResult>
  start(ports: AdapterPorts): Promise<AdapterHandle>
}

/** Longest session key core accepts before asking the adapter. */
export const SESSION_KEY_MAX = 128
