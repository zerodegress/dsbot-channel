import { adapterMetaOf } from './adapter-meta.js'
import { contentHash, eventKey } from './event-key.js'
import type { ChargeKind, Event, EventInput, MediaInput, MediaOwner, MediaRef, Mentioned, Source } from './event-types.js'
import { HANDLE_MAX, MEDIA_TYPES } from './event-types.js'
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

/** A handle is a token the owning transport can resolve: printable, one line, bounded. */
export function handleProblem(value: string): string | undefined {
  if (value.length === 0) return 'empty'
  if (value.length > HANDLE_MAX) return `longer than ${HANDLE_MAX} characters`
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x21 || code > 0x7e) return 'not a printable token'
  }
  return undefined
}

/** Keeps the references core can describe; a handle it cannot read drops that item, not the message. */
function assertMedia(media: readonly MediaInput[], owner: MediaOwner): MediaRef[] {
  const kept: MediaRef[] = []
  media.forEach((item, index) => {
    if (!(MEDIA_TYPES as readonly string[]).includes(item.type)) {
      throw new Error(`media[${index}].type must be one of ${MEDIA_TYPES.join(', ')}, got "${String(item.type)}"`)
    }
    const url = item.url ?? null
    const rawHandle = item.handle ?? null
    if (url === null && rawHandle === null) {
      throw new Error(`media[${index}] needs a url or a handle`)
    }
    if (url !== null && (typeof url !== 'string' || url.length === 0)) {
      throw new Error(`media[${index}].url must be a non-empty string or null`)
    }
    const handle =
      rawHandle !== null && typeof rawHandle === 'string' && handleProblem(rawHandle) === undefined ? rawHandle : null
    if (url === null && handle === null) return
    kept.push({ type: item.type, url, handle, owner })
  })
  return kept
}

/** Refuses a mention report that is not the three explicit booleans; a missing field is never read as false. */
function assertMentioned(value: unknown): Mentioned {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('transport.mentioned must be an object with self, others and all')
  }
  const record = value as Record<string, unknown>
  for (const field of ['self', 'others', 'all'] as const) {
    if (typeof record[field] !== 'boolean') {
      throw new Error(`transport.mentioned.${field} must be a boolean`)
    }
  }
  return { self: record.self as boolean, others: record.others as boolean, all: record.all as boolean }
}

/** Assembles one event and derives its identity fields. */
export function buildEvent(input: EventInput): Event {
  const kind = assertKind(input.source.kind)
  const scope = assertEnum('source.scope', SCOPES, input.source.scope)
  const source: Source = { kind, instance: input.source.instance, peer: input.source.peer, scope }
  return {
    source,
    author: { senderId: input.author.senderId, kind: assertEnum('author.kind', AUTHOR_KINDS, input.author.kind), personId: input.author.personId },
    body: {
      text: input.body.text,
      media: assertMedia(input.body.media, { kind: source.kind, instance: source.instance }),
      replyTo: input.body.replyTo,
    },
    meta: {
      transport: { ...input.transport, mentioned: assertMentioned(input.transport.mentioned) },
      derived: {
        eventKey: eventKey(source.instance, input.transport.messageId),
        contentHash: contentHash(input.body),
      },
      declared: { ...input.declared },
      adapter: adapterMetaOf(input.adapter),
    },
  }
}

/** Billing dedupe key: one event can charge several bots separately. */
export function chargeKey(key: string, botId: string, chargeKind: ChargeKind): string {
  assertEnum('chargeKind', CHARGE_KINDS, chargeKind)
  return `${key}|${botId}|${chargeKind}`
}

