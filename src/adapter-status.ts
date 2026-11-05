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
  /** Whether core may write back to this adapter at all; absent means yes. */
  outbound?: boolean
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
  /** Messages from an instance the roster does not name. */
  unknownInstance: number
  /** Deliveries that ended without one having begun, which is always a bug. */
  underruns: number
  /** Peers that spoke a protocol version this build does not accept. */
  protocolMismatches: number
  /** Messages refused as stale, by the peer instance that sent them. */
  staleSentAt: Record<string, number>
  /** Outbound failures by the code the send path reported. */
  sendFailures: Record<string, number>
  /** The last failure this transport saw, or null when it has none. */
  lastFailure: { at: number; reason: string } | null
  /** Non-message events this transport read, by its own class. */
  events?: Record<string, number> | undefined
  /** Chance nodes that ran over this adapter's messages, by node id. */
  chance?: Record<string, { hit: number; miss: number }> | undefined
}

export type Health = ConnectionHealth | ListenerHealth

export const MODEL_SELECTION_STATES = ['applied', 'unsupported', 'rejected'] as const
export type ModelSelectionState = (typeof MODEL_SELECTION_STATES)[number]

/** The model an adapter asked its host for, and whether the selection took. */
export interface ModelSelection {
  requested: string
  state: ModelSelectionState
}

/** The peer and failure code of the last send that left an adapter and failed. */
export interface SendFailureView {
  at: number
  instance: string
  reason: string
}

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
  /** Absent when the profile names no model, or when the host has not decided yet. */
  modelSelection?: ModelSelection | undefined
  /** When this adapter last completed a send; null when it never has. */
  lastSuccessAt?: number | null | undefined
  /** The peer and failure code of the last send that left this adapter and failed; null when none has. */
  lastSendFailure?: SendFailureView | null | undefined
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
  modelSelection?: ModelSelection | undefined
  lastSuccessAt?: number | null | undefined
  lastSendFailure?: SendFailureView | null | undefined
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
      unknownInstance: input.counters.unknownInstance,
      unknownPaths: input.counters.unknownPaths,
      underruns: input.counters.underruns,
      protocolMismatches: input.counters.protocolMismatches,
      staleSentAt: { ...input.counters.staleSentAt },
      sendFailures: { ...input.counters.sendFailures },
      lastFailure:
        input.counters.lastFailure === null
          ? null
          : { at: input.counters.lastFailure.at, reason: input.counters.lastFailure.reason },
      ...(input.counters.events === undefined ? {} : { events: { ...input.counters.events } }),
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
    ...(input.modelSelection === undefined
      ? {}
      : {
          modelSelection: {
            requested: input.modelSelection.requested,
            state: assertMember('model selection state', MODEL_SELECTION_STATES, input.modelSelection.state),
          },
        }),
    ...(input.lastSuccessAt === undefined ? {} : { lastSuccessAt: input.lastSuccessAt }),
    ...(input.lastSendFailure === undefined
      ? {}
      : {
          lastSendFailure:
            input.lastSendFailure === null
              ? null
              : {
                  at: input.lastSendFailure.at,
                  instance: input.lastSendFailure.instance,
                  reason: input.lastSendFailure.reason,
                },
        }),
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
