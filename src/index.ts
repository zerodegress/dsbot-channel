export type Config = Record<string, never>

/** Multi-channel ingress gateway for ds-bot. */
export const name = 'dsbot-channel'

export function apply() {}

export const plugin = { name, apply }

export default plugin

export * from './event-types.js'
export { contentHash, eventKey } from './event-key.js'
export { LAYERS, LayerViolationError, declareLayer, derivedLayer, readDeclared, transportLayer } from './event-layers.js'
export type { DeclaredLayer, Layer } from './event-layers.js'
export { buildEvent, chargeKey, dedupeKeyFor, replyIdempotencyKey, unstableDedupeKey } from './event-build.js'
export { ConfigError, WILDCARD_HOSTS, assertBindHost, strict, validateConfig } from './config.js'
export { signBody, verifyRequest, digestBody } from './p2p-auth.js'
export type { AuthInput, AuthResult, PeerSecret } from './p2p-auth.js'
export { DedupeTable } from './p2p-dedupe.js'
export type { DedupeEntry, DedupeOptions } from './p2p-dedupe.js'
export { toP2PEvent } from './p2p-mapping.js'
export type { P2PInbound } from './p2p-mapping.js'
export { MAX_BODY_BYTES, P2P_ROUTE, handleMessage, parseRequest } from './p2p-protocol.js'
export type { HandleInput, HandleResult, P2PConfig, P2PPayload, Parsed } from './p2p-protocol.js'
export { Pipeline, NODE_TYPES, SKIP_TARGETS } from './pipeline.js'
export type {
  Decision,
  DenyOutput,
  AllowOutput,
  RestrictOutput,
  ScoreOutput,
  PassOutput,
  NodeOutput,
  NodeType,
  NodeContext,
  PipelineEvent,
  PipelineNode,
  PipelineOptions,
  PipelineResult,
  RuntimeView,
  SkipTarget,
} from './pipeline.js'
export { DEFAULT_PIPELINE, checkPipeline, defaultPipelineNodes } from './pipeline-config.js'
export type { CheckReport, PipelineNodeSpec, PipelineSettings } from './pipeline-config.js'
export { BudgetLedger, DEFAULT_BUDGET, sessionKeyFor } from './budget-ledger.js'
export type {
  BudgetLimits,
  BudgetPoints,
  BudgetSettings,
  Hold,
  Hysteresis,
  LedgerSnapshot,
  LimitLevel,
  LimitState,
  ScopePair,
  Usage,
} from './budget-ledger.js'
export { DEFAULT_HOST, DEFAULT_PORT, SIGNATURE_HEADER, checkListenerConfig, startListener } from './p2p-listener.js'
export type { Listener, ListenerConfig, ListenerOptions } from './p2p-listener.js'
export { SecretRefError, assertPeersResolvable, resolvePeers, staticCredentials } from './p2p-secrets.js'
export type { CredentialsLike, PeerRef, ResolvedSecret } from './p2p-secrets.js'
