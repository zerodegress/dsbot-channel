import { contentHash, eventKey } from './event-key.js'
import type { ChargeKind, Event, EventInput, MediaRef, Source, Target } from './event-types.js'
import { MEDIA_HANDLE_MAX, MEDIA_TYPES } from './event-types.js'
import { AUTHOR_KINDS, CHARGE_KINDS, SCOPES, SOURCE_KIND_MAX } from './event-types.js'

function assertEnum<T extends string>(name: string, allowed: readonly T[], value: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value as T
}

/** A source kind is one line of printable characters, not a closed list: adapters add their own. */
function assertKind(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('source.kind must be a non-empty string')
  if (Array.from(value).length > SOURCE_KIND_MAX) {
    throw new Error(`source.kind must be at most ${SOURCE_KIND_MAX} characters`)
  }
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) {
      throw new Error('source.kind must be one line of printable characters without spaces')
    }
  }
  return value
}

/** Refuses a media reference core could not describe or carry. */
function assertMedia(media: readonly MediaRef[]): MediaRef[] {
  return media.map((item, index) => {
    if (!(MEDIA_TYPES as readonly string[]).includes(item.type)) {
      throw new Error(`media[${index}].type must be one of ${MEDIA_TYPES.join(', ')}, got "${String(item.type)}"`)
    }
    const url = item.url ?? null
    const handle = item.handle ?? null
    if (url === null && handle === null) throw new Error(`media[${index}] needs a url or a handle`)
    if (url !== null && (typeof url !== 'string' || url.length === 0)) {
      throw new Error(`media[${index}].url must be a non-empty string when it is present`)
    }
    if (handle !== null) {
      if (typeof handle !== 'string' || handle.length === 0) {
        throw new Error(`media[${index}].handle must be a non-empty string when it is present`)
      }
      if (Array.from(handle).length > MEDIA_HANDLE_MAX) {
        throw new Error(`media[${index}].handle must be at most ${MEDIA_HANDLE_MAX} characters`)
      }
      for (const char of handle) {
        const code = char.codePointAt(0) ?? 0
        if (code < 0x21 || code > 0x7e) {
          throw new Error(`media[${index}].handle must be one line of printable characters without spaces`)
        }
      }
    }
    return { type: item.type, url, handle }
  })
}

/** Assembles one event and derives its identity fields. */
export function buildEvent(input: EventInput): Event {
  const kind = assertKind(input.source.kind)
  const scope = assertEnum('source.scope', SCOPES, input.source.scope)
  const source: Source = { kind, instance: input.source.instance, peer: input.source.peer, scope }
  return {
    source,
    author: { senderId: input.author.senderId, kind: assertEnum('author.kind', AUTHOR_KINDS, input.author.kind), personId: input.author.personId },
    body: { text: input.body.text, media: assertMedia(input.body.media), replyTo: input.body.replyTo },
    meta: {
      transport: { ...input.transport },
      derived: {
        eventKey: eventKey(source.instance, input.transport.messageId),
        contentHash: contentHash(input.body),
      },
      declared: { ...input.declared },
    },
  }
}

/** Billing dedupe key: one event can charge several bots separately. */
export function chargeKey(key: string, botId: string, chargeKind: ChargeKind): string {
  assertEnum('chargeKind', CHARGE_KINDS, chargeKind)
  return `${key}|${botId}|${chargeKind}`
}

export function replyIdempotencyKey(key: string, target: Target, hash: string): string {
  return `${key}|${target.channel}|${target.scope}|${target.target}|${hash}`
}

export function unstableDedupeKey(senderId: string, hash: string): string {
  return `${senderId}|${hash}`
}

export interface DedupeKeyInput {
  stableMessageId: boolean
  senderId: string
  contentHash: string
  eventKey: string
}

/** Content-only keys are used only when the platform message id is unstable. */
export function dedupeKeyFor(input: DedupeKeyInput): string {
  if (input.stableMessageId) return input.eventKey
  return unstableDedupeKey(input.senderId, input.contentHash)
}
