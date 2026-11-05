import { ConfigError } from './config.js'
import type { AuthorKind, MediaRef, Mentioned, Scope } from './event-types.js'
import { AUTHOR_KINDS, SCOPES } from './event-types.js'

export const REPLY_MODES = ['auto', 'tool'] as const
export type ReplyMode = (typeof REPLY_MODES)[number]

/** How deep `not`/`any` may nest inside a `when`, so the schema stays finite. */
export const REPLY_WHEN_DEPTH_MAX = 4

export interface ReplyWhenSource {
  kind?: string | undefined
  instance?: string | undefined
  peer?: string | undefined
  scope?: Scope | undefined
}

export interface ReplyWhenAuthor {
  kind?: AuthorKind | undefined
  senderId?: string | undefined
}

export interface ReplyWhenTransport {
  mentioned?: Mentioned | undefined
  isReply?: boolean | undefined
}

export interface ReplyWhenBody {
  text?: { words?: readonly string[] | undefined; regexes?: readonly string[] | undefined } | undefined
  media?: 'any' | 'none' | undefined
}

export interface ReplyWhen {
  source?: ReplyWhenSource | undefined
  author?: ReplyWhenAuthor | undefined
  transport?: ReplyWhenTransport | undefined
  body?: ReplyWhenBody | undefined
  not?: ReplyWhen | undefined
  any?: readonly ReplyWhen[] | undefined
}

export interface ReplyRule {
  when: ReplyWhen
  mode: ReplyMode
}

export interface ReplyConfig {
  default?: ReplyMode | undefined
  byScope?: Partial<Record<Scope, ReplyMode>> | undefined
  rules?: readonly ReplyRule[] | undefined
}

/** The facts a rule may look at, all of them taken from the inbound message. */
export interface ReplyFacts {
  source: { kind: string; instance: string; peer: string | null; scope: Scope }
  author: { kind: AuthorKind; senderId: string }
  transport: { mentioned: Mentioned; isReply: boolean }
  body: { text: string; media: readonly MediaRef[] }
}

export interface ReplyPlan {
  /** Whether any path through this config can choose `tool`, so a host without tools fails at load. */
  readonly possibleTool: boolean
  /** Whether every path chooses `tool`, so a turn can answer without writing to its own adapter. */
  readonly alwaysTool: boolean
  modeFor(facts: ReplyFacts): ReplyMode
}

type Matcher = (facts: ReplyFacts) => boolean

const WHEN_KEYS = new Set(['source', 'author', 'transport', 'body', 'not', 'any'])
const SOURCE_KEYS = new Set(['kind', 'instance', 'peer', 'scope'])
const AUTHOR_KEYS = new Set(['kind', 'senderId'])
const TRANSPORT_KEYS = new Set(['mentioned', 'isReply'])
const BODY_KEYS = new Set(['text', 'media'])
const TEXT_KEYS = new Set(['words', 'regexes'])
const REPLY_KEYS = new Set(['default', 'byScope', 'rules'])

function fail(message: string, path: readonly (string | number)[]): never {
  throw new ConfigError(message, path)
}

function record(value: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('must be an object', path)
  return value as Record<string, unknown>
}

function noUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: readonly (string | number)[]): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) fail(`unknown field: ${unknown.join(', ')}`, path)
}

function optionalText(value: unknown, path: readonly (string | number)[]): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) fail('must be a non-empty string', path)
  return value
}

function modeOf(value: unknown, path: readonly (string | number)[]): ReplyMode {
  if (typeof value !== 'string' || !(REPLY_MODES as readonly string[]).includes(value)) {
    fail(`mode must be one of ${REPLY_MODES.join(', ')}`, path)
  }
  return value as ReplyMode
}

function boolOf(value: unknown, path: readonly (string | number)[]): boolean {
  if (typeof value !== 'boolean') fail('must be a boolean', path)
  return value
}

function scopeOf(value: unknown, path: readonly (string | number)[]): Scope {
  if (typeof value !== 'string' || !(SCOPES as readonly string[]).includes(value)) {
    fail(`scope must be one of ${SCOPES.join(', ')}`, path)
  }
  return value as Scope
}

function compileSource(value: unknown, path: readonly (string | number)[]): (facts: ReplyFacts) => boolean {
  const raw = record(value, path)
  noUnknown(raw, SOURCE_KEYS, path)
  const kind = optionalText(raw.kind, [...path, 'kind'])
  const instance = optionalText(raw.instance, [...path, 'instance'])
  const peer = optionalText(raw.peer, [...path, 'peer'])
  const scope = raw.scope === undefined ? undefined : scopeOf(raw.scope, [...path, 'scope'])
  return (facts) =>
    (kind === undefined || facts.source.kind === kind) &&
    (instance === undefined || facts.source.instance === instance) &&
    (peer === undefined || facts.source.peer === peer) &&
    (scope === undefined || facts.source.scope === scope)
}

function compileAuthor(value: unknown, path: readonly (string | number)[]): (facts: ReplyFacts) => boolean {
  const raw = record(value, path)
  noUnknown(raw, AUTHOR_KEYS, path)
  const kind = optionalText(raw.kind, [...path, 'kind'])
  if (kind !== undefined && !(AUTHOR_KINDS as readonly string[]).includes(kind)) {
    fail(`author.kind must be one of ${AUTHOR_KINDS.join(', ')}`, [...path, 'kind'])
  }
  const senderId = optionalText(raw.senderId, [...path, 'senderId'])
  return (facts) =>
    (kind === undefined || facts.author.kind === kind) && (senderId === undefined || facts.author.senderId === senderId)
}

function compileTransport(value: unknown, path: readonly (string | number)[]): (facts: ReplyFacts) => boolean {
  const raw = record(value, path)
  noUnknown(raw, TRANSPORT_KEYS, path)
  let mentioned: Mentioned | undefined
  if (raw.mentioned !== undefined) {
    const one = record(raw.mentioned, [...path, 'mentioned'])
    noUnknown(one, new Set(['self', 'others', 'all']), [...path, 'mentioned'])
    mentioned = {
      self: boolOf(one.self, [...path, 'mentioned', 'self']),
      others: boolOf(one.others, [...path, 'mentioned', 'others']),
      all: boolOf(one.all, [...path, 'mentioned', 'all']),
    }
  }
  const isReply = raw.isReply === undefined ? undefined : boolOf(raw.isReply, [...path, 'isReply'])
  return (facts) =>
    (mentioned === undefined ||
      (facts.transport.mentioned.self === mentioned.self &&
        facts.transport.mentioned.others === mentioned.others &&
        facts.transport.mentioned.all === mentioned.all)) &&
    (isReply === undefined || facts.transport.isReply === isReply)
}

function compileText(value: unknown, path: readonly (string | number)[]): (facts: ReplyFacts) => boolean {
  const raw = record(value, path)
  noUnknown(raw, TEXT_KEYS, path)
  const words = raw.words === undefined ? undefined : stringList(raw.words, [...path, 'words'])
  const regexes =
    raw.regexes === undefined
      ? undefined
      : stringList(raw.regexes, [...path, 'regexes']).map((source, index) => {
          try {
            return { source, pattern: new RegExp(source, 'i') }
          } catch {
            return fail(`not a valid regular expression: ${source}`, [...path, 'regexes', index])
          }
        })
  return (facts) => {
    const text = facts.body.text.toLowerCase()
    if (words !== undefined && !words.some((word) => text.includes(word))) return false
    if (regexes !== undefined && !regexes.some((one) => one.pattern.test(facts.body.text))) return false
    return true
  }
}

function stringList(value: unknown, path: readonly (string | number)[]): string[] {
  if (!Array.isArray(value)) fail('must be a list of strings', path)
  return value.map((item, index) => {
    if (typeof item !== 'string' || item.length === 0) fail('must be a non-empty string', [...path, index])
    return item
  })
}

function compileBody(value: unknown, path: readonly (string | number)[]): (facts: ReplyFacts) => boolean {
  const raw = record(value, path)
  noUnknown(raw, BODY_KEYS, path)
  const text = raw.text === undefined ? undefined : compileText(raw.text, [...path, 'text'])
  let media: 'any' | 'none' | undefined
  if (raw.media !== undefined) {
    if (raw.media !== 'any' && raw.media !== 'none') fail('media must be one of any, none', [...path, 'media'])
    media = raw.media
  }
  return (facts) => {
    if (text !== undefined && !text(facts)) return false
    if (media === 'any' && facts.body.media.length === 0) return false
    if (media === 'none' && facts.body.media.length > 0) return false
    return true
  }
}

/** Compiles one `when`; the outer object is AND, `not` inverts, `any` is OR. */
function compileWhen(value: unknown, path: readonly (string | number)[], depth: number): Matcher {
  if (depth > REPLY_WHEN_DEPTH_MAX) {
    fail(`when nests deeper than ${REPLY_WHEN_DEPTH_MAX}`, path)
  }
  const raw = record(value, path)
  noUnknown(raw, WHEN_KEYS, path)
  const parts: Matcher[] = []
  if (raw.source !== undefined) parts.push(compileSource(raw.source, [...path, 'source']))
  if (raw.author !== undefined) parts.push(compileAuthor(raw.author, [...path, 'author']))
  if (raw.transport !== undefined) parts.push(compileTransport(raw.transport, [...path, 'transport']))
  if (raw.body !== undefined) parts.push(compileBody(raw.body, [...path, 'body']))
  let inverted: Matcher | undefined
  if (raw.not !== undefined) {
    const inner = compileWhen(raw.not, [...path, 'not'], depth + 1)
    inverted = (facts) => !inner(facts)
  }
  let alternatives: Matcher[] | undefined
  if (raw.any !== undefined) {
    if (!Array.isArray(raw.any) || raw.any.length === 0) fail('any must list at least one when', [...path, 'any'])
    alternatives = raw.any.map((item, index) => compileWhen(item, [...path, 'any', index], depth + 1))
  }
  return (facts) =>
    parts.every((part) => part(facts)) &&
    (inverted === undefined || inverted(facts)) &&
    (alternatives === undefined || alternatives.some((one) => one(facts)))
}

/** Validates a whole `reply` block and turns it into one pure decision function. */
export function compileReply(raw: unknown, path: readonly (string | number)[] = ['reply']): ReplyPlan {
  const factsToMode: { matcher: Matcher; mode: ReplyMode }[] = []
  let fallback: ReplyMode = 'auto'
  const byScope = new Map<Scope, ReplyMode>()
  let possibleTool = false

  if (raw !== undefined) {
    const block = record(raw, path)
    noUnknown(block, REPLY_KEYS, path)
    if (block.default !== undefined) {
      const mode = modeOf(block.default, [...path, 'default'])
      fallback = mode
      if (mode === 'tool') possibleTool = true
    }
    if (block.byScope !== undefined) {
      const scopes = record(block.byScope, [...path, 'byScope'])
      noUnknown(scopes, new Set(SCOPES), [...path, 'byScope'])
      for (const scope of SCOPES) {
        const value = scopes[scope]
        if (value === undefined) continue
        const mode = modeOf(value, [...path, 'byScope', scope])
        byScope.set(scope, mode)
        if (mode === 'tool') possibleTool = true
      }
    }
    if (block.rules !== undefined) {
      if (!Array.isArray(block.rules)) fail('rules must be a list', [...path, 'rules'])
      block.rules.forEach((item, index) => {
        const one = record(item, [...path, 'rules', index])
        noUnknown(one, new Set(['when', 'mode']), [...path, 'rules', index])
        if (one.when === undefined) fail('a rule needs a when', [...path, 'rules', index, 'when'])
        if (one.mode === undefined) fail('a rule needs a mode', [...path, 'rules', index, 'mode'])
        const mode = modeOf(one.mode, [...path, 'rules', index, 'mode'])
        const matcher = compileWhen(one.when, [...path, 'rules', index, 'when'], 1)
        factsToMode.push({ matcher, mode })
        if (mode === 'tool') possibleTool = true
      })
    }
  }

  const alwaysTool =
    fallback === 'tool' &&
    [...byScope.values()].every((mode) => mode === 'tool') &&
    factsToMode.every((rule) => rule.mode === 'tool')

  return {
    possibleTool,
    alwaysTool,
    modeFor(facts: ReplyFacts): ReplyMode {
      for (const rule of factsToMode) {
        if (rule.matcher(facts)) return rule.mode
      }
      const byFacts = byScope.get(facts.source.scope)
      if (byFacts !== undefined) return byFacts
      return fallback
    },
  }
}
