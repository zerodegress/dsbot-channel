import type { PipelineEvent } from './pipeline.js'
import type { Scope } from './event-types.js'

export const MATCH_KEYS = ['scope', 'peer', 'mentioned', 'replyToMe', 'ownRecent'] as const

export type PeerTest = string | { in: readonly string[] } | { notIn: readonly string[] }

/** One condition a `when` node or a guarded `chance` node reads; every key present must hold. */
export interface MatchSpec {
  scope?: Scope
  peer?: PeerTest
  mentioned?: boolean
  replyToMe?: boolean
  ownRecent?: boolean
}

const SCOPES: readonly Scope[] = ['c2c', 'group', 'p2p']

/** What is wrong with a written matcher, as sentences that name the field. */
export function matchProblems(raw: unknown): string[] {
  const problems: string[] = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return ['a matcher must be a mapping']
  const spec = raw as Record<string, unknown>
  const keys = Object.keys(spec)
  if (keys.length === 0) return ['a matcher needs at least one key']
  for (const key of keys) {
    if (!(MATCH_KEYS as readonly string[]).includes(key)) problems.push(`a matcher has no key "${key}"`)
  }
  if (spec.scope !== undefined && !SCOPES.includes(spec.scope as Scope)) {
    problems.push(`scope must be one of ${SCOPES.join(', ')}`)
  }
  if (spec.peer !== undefined) {
    const peer = spec.peer
    if (typeof peer === 'string') {
      if (peer.length === 0) problems.push('peer must not be empty')
    } else if (peer !== null && typeof peer === 'object' && !Array.isArray(peer)) {
      const shape = peer as Record<string, unknown>
      const hasIn = Array.isArray(shape.in)
      const hasNotIn = Array.isArray(shape.notIn)
      if (hasIn === hasNotIn) problems.push('peer must name exactly one of in or notIn')
      for (const [name, list] of [
        ['in', shape.in],
        ['notIn', shape.notIn],
      ] as const) {
        if (!Array.isArray(list)) continue
        if (list.length === 0) problems.push(`peer.${name} must not be empty`)
        for (const one of list) {
          if (typeof one !== 'string' || one.length === 0) problems.push(`peer.${name} names a non-string`)
        }
      }
      for (const key of Object.keys(shape)) {
        if (key !== 'in' && key !== 'notIn') problems.push(`peer has no key "${key}"`)
      }
    } else {
      problems.push('peer must be a string or an in/notIn mapping')
    }
  }
  for (const key of ['mentioned', 'replyToMe', 'ownRecent'] as const) {
    if (spec[key] !== undefined && typeof spec[key] !== 'boolean') problems.push(`${key} must be true or false`)
  }
  return problems
}

function peerMatches(test: PeerTest, peer: string | undefined): boolean {
  if (typeof test === 'string') return peer === test
  if ('in' in test) return peer !== undefined && test.in.includes(peer)
  return peer === undefined || !test.notIn.includes(peer)
}

/** One predicate over the event a node sees, built once at mount. */
export function compileMatch(raw: MatchSpec): (event: PipelineEvent) => boolean {
  return (event) => {
    if (raw.scope !== undefined && event.scope !== raw.scope) return false
    if (raw.peer !== undefined && !peerMatches(raw.peer, event.peer)) return false
    if (raw.mentioned !== undefined) {
      const said = event.mentioned.self || event.mentioned.all
      if (said !== raw.mentioned) return false
    }
    if (raw.replyToMe !== undefined && (event.replyToMe === true) !== raw.replyToMe) return false
    if (raw.ownRecent !== undefined && (event.ownRecent === true) !== raw.ownRecent) return false
    return true
  }
}
