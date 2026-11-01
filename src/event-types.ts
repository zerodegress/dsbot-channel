/** Longest source kind an event may carry, so a header or a key stays bounded. */
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

export interface MediaRef {
  type: 'image' | 'file' | 'voice'
  url: string
}

export interface Body {
  text: string
  media: MediaRef[]
  replyTo: string | null
}

export interface TransportMeta {
  messageId: string
  timestamp: number
  mentioned: boolean
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
