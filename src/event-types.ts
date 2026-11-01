/**
 * Shape bound for any source kind, so a header or a key stays bounded. An adapter kind is
 * shorter in practice: ADAPTER_KIND_MAX (32) caps a kind a profile may mount, and a message's
 * kind must equal the adapter that carried it.
 */
export const SOURCE_KIND_MAX = 64

export const SCOPES = ['c2c', 'group', 'p2p'] as const
export type Scope = (typeof SCOPES)[number]

export const CHARGE_KINDS = ['judge', 'bot', 'push'] as const
export type ChargeKind = (typeof CHARGE_KINDS)[number]

export interface Source {
  /** The transport that carried the message, declared by its adapter; core checks only its shape. */
  kind: string
  instance: string
  peer: string | null
  scope: Scope
}

export const AUTHOR_KINDS = ['person', 'bot'] as const
export type AuthorKind = (typeof AUTHOR_KINDS)[number]

export interface Author {
  senderId: string
  kind: AuthorKind
  personId: string | null
}

export const MEDIA_TYPES = ['image', 'file', 'voice'] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

/** Longest platform handle a media reference may carry; the adapter interprets it. */
export const MEDIA_HANDLE_MAX = 256

/** A media reference is either addressable (a url) or named by the transport (a handle), never neither. */
export interface MediaRef {
  type: MediaType
  /** A public address, when the transport has one to hand out. */
  url: string | null
  /** The adapter's own opaque token; core carries it and never parses it. */
  handle: string | null
}

export interface Body {
  text: string
  media: MediaRef[]
  replyTo: string | null
}

/** Who a message named: the three facts a transport can report, all of them required. */
export interface Mentioned {
  /** The bot itself was named. */
  self: boolean
  /** Someone else was named. */
  others: boolean
  /** Everyone was named. */
  all: boolean
}

/** The mention state of a message that named nobody. */
export function noMention(): Mentioned {
  return { self: false, others: false, all: false }
}

export interface TransportMeta {
  messageId: string
  timestamp: number
  mentioned: Mentioned
  isReply: boolean
  signature: string | null
}

export interface DerivedMeta {
  eventKey: string
  contentHash: string
}

export interface DeclaredMeta {
  nickname: string
  avatar: string
  claimedIdentity: string | null
}

export interface EventMeta {
  transport: TransportMeta
  derived: DerivedMeta
  declared: DeclaredMeta
}

export interface Event {
  source: Source
  author: Author
  body: Body
  meta: EventMeta
}

export interface EventInput {
  source: Source
  author: Author
  body: Body
  transport: TransportMeta
  declared: DeclaredMeta
}

export interface Target {
  channel: string
  scope: Scope
  target: string
}
