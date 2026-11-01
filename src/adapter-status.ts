export type ConnectionState = 'online' | 'reconnecting' | 'offline'

export const LISTEN_STATES = ['listening', 'failed', 'stopped'] as const
export type ListenState = (typeof LISTEN_STATES)[number]

export interface CapabilitySet {
  text: boolean
  image: boolean
  file: boolean
  voice: boolean
  recall: boolean
  history: boolean
  /** The platform can tell this bot's own mentions from mentions of others and of everyone. */
  mention: boolean
  reply: boolean
  stream: boolean
}

export interface PlatformAttributes {
  stableMessageId: boolean
}

export interface QuotaView {
  softLimit: number
  hardLimit: number
}

export interface ConnectionHealth {
  kind: 'connection'
  state: ConnectionState
  lastFailure: string | null
  lastFailureAt: number | null
  reconnectCount: number
  lastConnectedAt: number | null
  queueDepth: number
}

export interface ListenerHealth {
  kind: 'listener'
  listenState: ListenState
  boundPort: number | null
  lastAuthenticatedAt: number | null
  queueDepth: number
}

export type Health = ConnectionHealth | ListenerHealth

export interface AdapterStatus {
  channel: string
  account: string
  bot: string
  health: Health
  capabilities: CapabilitySet
  attributes: PlatformAttributes
  quota: QuotaView
  sampledAt: number
  queueDepth: number
}

export interface ListenerInput {
  listenState: ListenState
  boundPort: number | null
  lastAuthenticatedAt: number | null
  queueDepth: number
}

export interface StatusInput {
  channel: string
  account: string
  bot: string
  health: Health
  capabilities: CapabilitySet
  attributes: PlatformAttributes
  quota: QuotaView
  sampledAt: number
  queueDepth: number
}

function assertMember<T extends string>(name: string, allowed: readonly T[], value: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(', ')}, got "${value}"`)
  }
  return value as T
}

/** Listener-typed health; a stopped listener holds no port. */
export function buildListenerHealth(input: ListenerInput): ListenerHealth {
  const listenState = assertMember('listen state', LISTEN_STATES, input.listenState)
  return {
    kind: 'listener',
    listenState,
    boundPort: listenState === 'listening' ? input.boundPort : null,
    lastAuthenticatedAt: input.lastAuthenticatedAt,
    queueDepth: input.queueDepth,
  }
}

/** Copies only the documented fields, so stray credentials never travel. */
export function buildStatus(input: StatusInput): AdapterStatus {
  return {
    channel: input.channel,
    account: input.account,
    bot: input.bot,
    health: input.health,
    capabilities: {
      text: input.capabilities.text,
      image: input.capabilities.image,
      file: input.capabilities.file,
      voice: input.capabilities.voice,
      recall: input.capabilities.recall,
      history: input.capabilities.history,
      mention: input.capabilities.mention,
      reply: input.capabilities.reply,
      stream: input.capabilities.stream,
    },
    attributes: { stableMessageId: input.attributes.stableMessageId },
    quota: { softLimit: input.quota.softLimit, hardLimit: input.quota.hardLimit },
    sampledAt: input.sampledAt,
    queueDepth: input.queueDepth,
  }
}
