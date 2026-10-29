import type { PeerSecret } from './p2p-auth.js'

export interface PeerRef {
  instance: string
  secret: string
  /** The name the peer answers to; an active push needs it, a reply borrows the sender's. */
  botName?: string
  host?: string
}

export interface ResolvedSecret {
  value: string
  source?: string
}

export interface CredentialsLike {
  resolve(reference: string): Promise<ResolvedSecret | undefined>
}

export type SecretRefReason = 'unresolved' | 'blank'

export class SecretRefError extends Error {
  readonly instance: string
  readonly reference: string
  readonly reason: SecretRefReason

  constructor(instance: string, reference: string, reason: SecretRefReason = 'unresolved') {
    super(
      reason === 'blank'
        ? `peer "${instance}" refers to credential "${reference}", which resolved to a blank value`
        : `peer "${instance}" refers to credential "${reference}", which did not resolve`,
    )
    this.name = 'SecretRefError'
    this.instance = instance
    this.reference = reference
    this.reason = reason
  }
}

/** Resolves each peer reference through the host credentials service, at call time. */
export async function resolvePeers(refs: readonly PeerRef[], credentials: CredentialsLike): Promise<PeerSecret[]> {
  const resolved: PeerSecret[] = []
  for (const ref of refs) {
    let found: ResolvedSecret | undefined
    try {
      found = await credentials.resolve(ref.secret)
    } catch {
      throw new SecretRefError(ref.instance, ref.secret, 'unresolved')
    }
    if (!found) throw new SecretRefError(ref.instance, ref.secret, 'unresolved')
    if (!found.value?.trim()) throw new SecretRefError(ref.instance, ref.secret, 'blank')
    resolved.push({ instance: ref.instance, secret: found.value })
  }
  return resolved
}

/** Startup check so a missing reference fails the mount instead of the first request. */
export async function assertPeersResolvable(refs: readonly PeerRef[], credentials: CredentialsLike): Promise<void> {
  if (!refs.length) throw new Error('p2p: at least one peer is required to start')
  await resolvePeers(refs, credentials)
}

/** In-memory source for tests only; a real profile resolves through the host service. */
export function staticCredentials(values: Record<string, string>): CredentialsLike {
  return {
    resolve: async (reference: string) => {
      const value = values[reference]
      if (!value) return undefined
      return { value, source: 'static' }
    },
  }
}
