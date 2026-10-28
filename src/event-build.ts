import { contentHash, eventKey } from './event-key.js'
import type { ChargeKind, Event, EventInput, Source, Target } from './event-types.js'
import { AUTHOR_KINDS, CHARGE_KINDS, SCOPES, SOURCE_KINDS } from './event-types.js'

function assertEnum<T extends string>(name: string, allowed: readonly T[], value: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value as T
}

/** Assembles one event and derives its identity fields. */
export function buildEvent(input: EventInput): Event {
  const kind = assertEnum('source.kind', SOURCE_KINDS, input.source.kind)
  const scope = assertEnum('source.scope', SCOPES, input.source.scope)
  const source: Source = { kind, instance: input.source.instance, peer: input.source.peer, scope }
  return {
    source,
    author: { senderId: input.author.senderId, kind: assertEnum('author.kind', AUTHOR_KINDS, input.author.kind), personId: input.author.personId },
    body: { text: input.body.text, media: [...input.body.media], replyTo: input.body.replyTo },
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
