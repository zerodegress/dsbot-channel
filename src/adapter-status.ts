export type ConnectionState = 'online' | 'reconnecting' | 'offline'

export const LISTEN_STATES = ['listening', 'failed', 'stopped'] as const
export type ListenState = (typeof LISTEN_STATES)[number]

/** What one transport can do with one media type, in each direction and from each source. */
export interface MediaCapability {
  in: boolean
  out: boolean
  fromUrl: boolean
  fromHandle: boolean
}

/** A media capability nobody claims: all four answers false. */
export const NO_MEDIA: MediaCapability = { in: false, out: false, fromUrl: false, fromHandle: false }

/** Which conversation kinds a transport can page history for. */
export interface HistoryCapability {
  group: boolean
  private: boolean
}

/** Neither kind: the answer when nothing declares history. */
export const NO_HISTORY: HistoryCapability = { group: false, private: false }

export interface CapabilitySet {
  text: boolean
  image: MediaCapability
  file: MediaCapability
  voice: MediaCapability
  recall: boolean
  history: HistoryCapability
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
  /** sentAt minus this clock on the last authenticated message; null until one arrives. */
  lastSkewMs: number | null
  lastFailure: { at: number; reason: string } | null
  queueDepth: number
}

/** The counters a transport keeps about itself; every field is required so a reader never guesses. */
export interface AdapterCounters {
  /** Requests refused because the caller did not present the right token. */
  authFailures: number
  /** Requests for a path this transport does not serve, which a port scan also produces. */
  unknownPaths: number
  /** Deliveries that ended without one having begun, which is always a bug. */
  underruns: number
  /** Peers that spoke a protocol version this build does not accept. */
  protocolMismatches: number
  /** Outbound failures by the code the send path reported. */
  sendFailures: Record<string, number>
  /** The last failure this transport saw, or null when it has none. */
  lastFailure: { at: number; reason: string } | null
}

export type Health = ConnectionHealth | ListenerHealth

export interface AdapterStatus {
  channel: string
  account: string
  bot: string
  health: Health
  counters: AdapterCounters
  capabilities: CapabilitySet
  attributes: PlatformAttributes
  quota: QuotaView
  sampledAt: number
  queueDepth: number
  /** The replay window a transport keeps, when it keeps one. */
  dedupe?: { epoch: number } | undefined
}

export interface ListenerInput {
  listenState: ListenState
  boundPort: number | null
  lastAuthenticatedAt: number | null
  lastSkewMs?: number | null | undefined
  lastFailure?: { at: number; reason: string } | null | undefined
  queueDepth: number
}

export interface StatusInput {
  channel: string
  account: string
  bot: string
  health: Health
  counters: AdapterCounters
  capabilities: CapabilitySet
  attributes: PlatformAttributes
  quota: QuotaView
  sampledAt: number
  queueDepth: number
  dedupe?: { epoch: number } | undefined
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
    lastSkewMs: input.lastSkewMs ?? null,
    lastFailure: listenState === 'listening' ? null : input.lastFailure ?? null,
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
    counters: {
      authFailures: input.counters.authFailures,
      unknownPaths: input.counters.unknownPaths,
      underruns: input.counters.underruns,
      protocolMismatches: input.counters.protocolMismatches,
      sendFailures: { ...input.counters.sendFailures },
      lastFailure:
        input.counters.lastFailure === null
          ? null
          : { at: input.counters.lastFailure.at, reason: input.counters.lastFailure.reason },
    },
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
    ...(input.dedupe === undefined ? {} : { dedupe: { epoch: input.dedupe.epoch } }),
  }
}

/** True when the connection comes from the loopback interface, which a status read requires. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (typeof address !== 'string') return false
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** True when a proxy in front of us rewrote the request, so a loopback peer cannot be trusted. */
export function hasForwardingHeaders(headers: Record<string, string | string[] | undefined>): boolean {
  return (
    headers['x-forwarded-for'] !== undefined ||
    headers['x-forwarded-host'] !== undefined ||
    headers['x-real-ip'] !== undefined ||
    headers.forwarded !== undefined
  )
}
