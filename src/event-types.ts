/**
 * Shape bound for any source kind, so a header or a key stays bounded. An adapter kind is
 * shorter in practice: ADAPTER_KIND_MAX (32) caps a kind a profile may mount, and a message's
 * kind must equal the adapter that carried it.
 */
export const SOURCE_KIND_MAX = 64

export const SCOPES = ['c2c', 'group', 'p2p'] as const
export type Scope = (typeof SCOPES)[number]

export const CHARGE_KINDS = ['bot'] as const
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

/** Longest handle a transport may name a media item by; a handle is a token, not free text. */
export const HANDLE_MAX = 256

/** The transport instance that can resolve a handle; core stamps it, an adapter cannot claim it. */
export interface MediaOwner {
  kind: string
  instance: string
}

/** What an adapter reports about one media item: a portable url, a handle of its own, or both. */
export interface MediaInput {
  type: MediaType
  url: string | null
  handle: string | null
}

/** A media reference an event carries, with the instance that owns its handle. */
export interface MediaRef extends MediaInput {
  owner: MediaOwner
}

export interface Body {
  text: string
  media: MediaRef[]
  replyTo: string | null
}

/** What an adapter hands to `buildEvent`, before core stamps the owner. */
export interface BodyInput {
  text: string
  media: readonly MediaInput[]
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

/**
 * The four layers of an event, and who owns each:
 *
 * - `transport` carries the facts a platform can verify (message id, time, mentions, reply,
 *   signature); core knows these field names.
 * - `derived` is computed by core and is the only authority for identity; nobody else writes it.
 * - `declared` is what the sender says about itself (nickname, avatar, claimed identity); it is
 *   untrusted and exists for display only.
 * - `adapter` is the transport's own raw payload: core never parses it and only passes it on, and
 *   a reader may look at it. It takes no part in identity or in any decision.
 */
export interface EventMeta {
  transport: TransportMeta
  derived: DerivedMeta
  declared: DeclaredMeta
  adapter: Record<string, unknown>
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
  body: BodyInput
  transport: TransportMeta
  declared: DeclaredMeta
  /** The transport's raw payload; core only carries it. */
  adapter?: Record<string, unknown> | undefined
}

export interface Target {
  channel: string
  scope: Scope
  target: string
}
