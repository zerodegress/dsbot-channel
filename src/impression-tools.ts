import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TurnRef } from './control-tools.js'
import type {
  Impression,
  ImpressionEvidence,
  ImpressionFailureCode,
  ImpressionKind,
  ImpressionScope,
  ImpressionStore,
  ImpressionSubjectKind,
} from './impressions.js'
import {
  IMPRESSION_CONFIDENCE_DEFAULT,
  IMPRESSION_GET_MAX,
  IMPRESSION_INJECT_CUTOFF,
  IMPRESSION_KINDS,
  IMPRESSION_TEXT_MAX,
  SHAREABLE_KINDS,
  effectiveConfidence,
  impressionId,
  mergeEvidence,
} from './impressions.js'

/** What the tools may touch: a store per bot, the turn they run inside, and one clock. */
export interface ImpressionPorts {
  storeOf: (bot: string) => ImpressionStore | undefined
  turnOf: (sessionId: string | undefined) => TurnRef | undefined
  now: () => number
}

const NO_TURN = 'this tool is only available while answering a message'
const P2P = 'a peer-to-peer turn has no impression partition'
const SHAREABLE = SHAREABLE_KINDS.join(', ')

type Failure = { ok: false; code: ImpressionFailureCode; retryable: false; reason: string }

function fail(code: ImpressionFailureCode, reason: string): Failure {
  return { ok: false, code, retryable: false, reason }
}

const output = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
}

interface Subject {
  subject: string
  subjectKind: ImpressionSubjectKind
  scope: ImpressionScope
  groupKey?: string | undefined
}

type Resolved = { ok: true; subject: Subject } | Failure

function groupKeyOf(turn: TurnRef): string {
  return `${turn.channel}|${turn.sessionKey}`
}

function resolveSubject(turn: TurnRef, about: unknown): Resolved {
  if (about !== undefined && about !== 'group') {
    return fail('unsupported_argument', 'about may only be "group"')
  }
  if (about === 'group') {
    if (turn.scope !== 'group') return fail('unsupported', 'a group archive only exists inside a group turn')
    const key = groupKeyOf(turn)
    return { ok: true, subject: { subject: key, subjectKind: 'group', scope: 'group', groupKey: key } }
  }
  if (turn.personId === null) return fail('no_identity', 'this account has no identity binding')
  if (turn.scope === 'group') {
    return {
      ok: true,
      subject: { subject: turn.personId, subjectKind: 'person', scope: 'group', groupKey: groupKeyOf(turn) },
    }
  }
  return { ok: true, subject: { subject: turn.personId, subjectKind: 'person', scope: 'c2c' } }
}

function evidenceOf(turn: TurnRef, at: number): ImpressionEvidence[] {
  return turn.eventKeys.map((eventKey) => ({ eventKey, sessionKey: turn.sessionKey, channel: turn.channel, at }))
}

function textProblem(text: unknown): string | undefined {
  if (typeof text !== 'string' || text.trim().length === 0) return 'text must be a non-empty string'
  const flat = text.trim()
  if (flat.length > IMPRESSION_TEXT_MAX) return `text is longer than ${IMPRESSION_TEXT_MAX} characters`
  for (const character of flat) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) return 'text must stay on one printable line'
  }
  return undefined
}

function kindOf(value: unknown): ImpressionKind | undefined {
  return typeof value === 'string' && (IMPRESSION_KINDS as readonly string[]).includes(value)
    ? (value as ImpressionKind)
    : undefined
}

function confidenceOf(value: unknown): number | undefined {
  if (value === undefined) return IMPRESSION_CONFIDENCE_DEFAULT
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(1, Math.max(0, value))
}

function storeOf(ports: ImpressionPorts, turn: TurnRef): ImpressionStore | Failure {
  const store = ports.storeOf(turn.bot)
  return store ?? fail('storage_error', 'no impression store is configured for this bot')
}

function limitOf(value: unknown): { ok: true; limit: number } | Failure {
  if (value === undefined) return { ok: true, limit: IMPRESSION_GET_MAX }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > IMPRESSION_GET_MAX) {
    return fail('unsupported_argument', `limit must be a whole number between 1 and ${IMPRESSION_GET_MAX}`)
  }
  return { ok: true, limit: value }
}

function partitionProblem(turn: TurnRef, subject: Subject, scope: ImpressionScope | 'cross'): string | undefined {
  if (scope === 'cross') return undefined
  if (subject.subjectKind === 'group') {
    return scope === 'group' ? undefined : 'a group archive has no c2c partition'
  }
  if (scope === 'c2c' && turn.scope === 'group') return 'c2c impressions are only read in a private chat'
  if (scope === 'group' && turn.scope !== 'group') return 'group impressions are only read in the group they came from'
  return undefined
}

/** Writes one note about the turn's counterpart, with the turn's messages as evidence. */
export function createImpressionPut(ports: ImpressionPorts) {
  return defineTool({
    name: 'impression_put',
    description:
      'Keep one short note about the person this turn answers, or with about "group" about this group. The note is stored with the messages that support it; it does not answer the message.',
    parameters: {
      text: { type: 'string', required: true, description: 'One printable line, at most 240 characters' },
      kind: { type: 'string', required: true, description: `One of ${IMPRESSION_KINDS.join(', ')}` },
      confidence: { type: 'number', description: 'How sure you are, from 0 to 1; defaults to 0.6' },
      share: {
        type: 'string',
        description: `local (default) keeps it on this platform; cross shares only ${SHAREABLE} across platforms`,
      },
      about: { type: 'string', description: 'Write "group" to note something about this group instead of its sender' },
    },
    output,
    async execute(
      args: { text?: string; kind?: string; confidence?: number; share?: string; about?: string },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      if (turn.kind === 'p2p') return JSON.stringify(fail('unsupported', P2P))
      const resolved = resolveSubject(turn, args.about)
      if (!resolved.ok) return JSON.stringify(resolved)
      const target = resolved.subject
      const problem = textProblem(args.text)
      if (problem !== undefined) return JSON.stringify(fail('unsupported_argument', problem))
      const kind = kindOf(args.kind)
      if (kind === undefined) return JSON.stringify(fail('unsupported_argument', `kind must be one of ${IMPRESSION_KINDS.join(', ')}`))
      const confidence = confidenceOf(args.confidence)
      if (confidence === undefined) return JSON.stringify(fail('unsupported_argument', 'confidence must be a number between 0 and 1'))
      const share = args.share ?? 'local'
      if (share !== 'local' && share !== 'cross') {
        return JSON.stringify(fail('unsupported_argument', 'share must be "local" or "cross"'))
      }
      if (share === 'cross' && !(SHAREABLE_KINDS as readonly string[]).includes(kind)) {
        return JSON.stringify(fail('unsupported_argument', `share "cross" is only for ${SHAREABLE}`))
      }
      const store = storeOf(ports, turn)
      if ('ok' in store) return JSON.stringify(store)
      const text = args.text!.trim()
      const now = ports.now()
      const evidence = evidenceOf(turn, now)
      const id = impressionId({ ...target, kind, text })
      const written = await store.transact(target.subjectKind, target.subject, (records) => {
        const existing = records.find((record) => record.id === id)
        if (existing !== undefined) {
          return records.map((record) => (record.id === id ? mergeEvidence(record, evidence, now) : record))
        }
        const record: Impression = {
          id,
          subject: target.subject,
          subjectKind: target.subjectKind,
          scope: target.scope,
          ...(target.groupKey === undefined ? {} : { groupKey: target.groupKey }),
          text,
          kind,
          confidence,
          share,
          evidence,
          bot: turn.bot,
          createdAt: now,
          updatedAt: now,
        }
        return [...records, record]
      })
      if (!written.ok) return JSON.stringify(written)
      turn.sideEffect = true
      return JSON.stringify({ ok: true, id, records: written.records.length })
    },
  })
}

/** Reads back one partition of what the bot noted, with decayed confidence and no evidence keys. */
export function createImpressionGet(ports: ImpressionPorts) {
  return defineTool({
    name: 'impression_get',
    description:
      'Read what this bot noted about the person this turn answers, or with about "group" about this group, in one partition.',
    parameters: {
      scope: { type: 'string', required: true, description: 'One of c2c, group, cross' },
      about: { type: 'string', description: 'Read the group archive instead of the sender' },
      limit: { type: 'number', description: `How many records to return, at most ${IMPRESSION_GET_MAX}` },
    },
    output,
    async execute(
      args: { scope?: string; about?: string; limit?: number },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      if (turn.kind === 'p2p') return JSON.stringify({ ok: true, records: [] })
      const resolved = resolveSubject(turn, args.about)
      if (!resolved.ok) return JSON.stringify(resolved)
      const target = resolved.subject
      const scope = args.scope
      if (scope !== 'c2c' && scope !== 'group' && scope !== 'cross') {
        return JSON.stringify(fail('unsupported_argument', 'scope must be one of c2c, group, cross'))
      }
      const problem = partitionProblem(turn, target, scope)
      if (problem !== undefined) return JSON.stringify(fail('unsupported', problem))
      const sized = limitOf(args.limit)
      if (!sized.ok) return JSON.stringify(sized)
      const store = storeOf(ports, turn)
      if ('ok' in store) return JSON.stringify(store)
      const read = await store.read(target.subjectKind, target.subject)
      if (!read.ok) return JSON.stringify(read)
      const now = ports.now()
      const records = read.records
        .filter((record) => {
          if (scope === 'cross') return record.share === 'cross'
          if (record.scope !== scope) return false
          if (scope === 'group' && target.groupKey !== undefined) return record.groupKey === target.groupKey
          return true
        })
        .map((record) => ({ record, effective: effectiveConfidence(record.confidence, record.updatedAt, now) }))
        .filter((entry) => entry.effective >= IMPRESSION_INJECT_CUTOFF)
        .sort((left, right) => right.effective - left.effective || right.record.updatedAt - left.record.updatedAt)
        .slice(0, sized.limit)
        .map((entry) => ({
          id: entry.record.id,
          text: entry.record.text,
          kind: entry.record.kind,
          effectiveConfidence: Number(entry.effective.toFixed(3)),
          updatedAt: entry.record.updatedAt,
        }))
      return JSON.stringify({ ok: true, records })
    },
  })
}

/** Forgets one id, or everything about the subject; evidence goes with the record. */
export function createImpressionForget(ports: ImpressionPorts) {
  return defineTool({
    name: 'impression_forget',
    description:
      'Forget one impression by id, or with all: true everything about the person this turn answers or, with about "group", about this group. Its evidence goes with it.',
    parameters: {
      id: { type: 'string', description: 'The id impression_get returned' },
      about: { type: 'string', description: 'Forget about this group instead of its sender' },
      all: { type: 'boolean', description: 'Forget every record about this subject' },
    },
    output,
    async execute(
      args: { id?: string; about?: string; all?: boolean },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const turn = ports.turnOf(exec?.agent?.id)
      if (turn === undefined) throw new Error(NO_TURN)
      if (turn.kind === 'p2p') return JSON.stringify(fail('unsupported', P2P))
      if (typeof args.id !== 'string' && args.all !== true) {
        return JSON.stringify(fail('unsupported_argument', 'give an id, or all: true'))
      }
      const resolved = resolveSubject(turn, args.about)
      if (!resolved.ok) return JSON.stringify(resolved)
      const target = resolved.subject
      const store = storeOf(ports, turn)
      if ('ok' in store) return JSON.stringify(store)
      let removed = 0
      const written = await store.transact(target.subjectKind, target.subject, (records) => {
        if (args.all === true) {
          removed = records.length
          return []
        }
        const kept = records.filter((record) => record.id !== args.id)
        removed = records.length - kept.length
        return kept
      })
      if (!written.ok) return JSON.stringify(written)
      if (removed === 0) return JSON.stringify(fail('not_found', 'no impression with that id under this subject'))
      turn.sideEffect = true
      return JSON.stringify({ ok: true, removed })
    },
  })
}
