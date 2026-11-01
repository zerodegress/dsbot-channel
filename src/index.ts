import { apply } from './plugin.js'
// Composition root: the only place a transport is named, so core never imports one.
import './adapters/p2p/index.js'

/** Multi-channel ingress gateway for ds-bot. */
export const name = 'dsbot-channel'

export const inject = ['credentials', 'sessionController'] as const

export { Config } from './plugin.js'
export { apply }
export type { ChannelConfig } from './plugin.js'

export const plugin = { name, inject, apply }

export default plugin

export * from './event-types.js'
export { contentHash, eventKey } from './event-key.js'
export { LAYERS, LayerViolationError, declareLayer, derivedLayer, readDeclared, transportLayer } from './event-layers.js'
export type { DeclaredLayer, Layer } from './event-layers.js'
export { buildEvent, chargeKey, dedupeKeyFor, replyIdempotencyKey, unstableDedupeKey } from './event-build.js'
export { ConfigError, WILDCARD_HOSTS, assertBindHost, strict, validateConfig } from './config.js'
export {
  ADAPTER_KIND_MAX,
  BUILTIN_KINDS,
  THIRD_PARTY_KIND,
  adapterFactory,
  checkAdapterKind,
  knownAdapterKinds,
  registerAdapter,
  registerBuiltinAdapter,
} from './adapter-registry.js'
export type { AdapterFactory, AdapterMount, AdapterOptions } from './adapter-registry.js'
export { CHAIN_ID_MAX, GUIDANCE_MAX, INBOUND_REJECTIONS, REPLY_TARGET_MAX, REQUEST_ID_MAX, SESSION_KEY_MAX, tokenProblem } from './contract.js'
export type {
  AdapterCheckSettings,
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundRejection,
  InboundVerdict,
  SendFailure,
  SendFailureCode,
  SendInput,
  SendResult,
  SendSuccess,
} from './contract.js'
export { signEnvelope, canonicalEnvelope, verifyRequest, digestBody } from './adapters/p2p/p2p-auth.js'
export type { AuthInput, AuthResult, PeerSecret } from './adapters/p2p/p2p-auth.js'
export { DedupeTable } from './adapters/p2p/p2p-dedupe.js'
export type { DedupeEntry, DedupeOptions } from './adapters/p2p/p2p-dedupe.js'
export { toP2PEvent } from './adapters/p2p/p2p-mapping.js'
export type { P2PInbound } from './adapters/p2p/p2p-mapping.js'
export { MAX_BODY_BYTES, P2P_ROUTE, handleMessage, parseRequest } from './adapters/p2p/p2p-protocol.js'
export type { HandleInput, HandleResult, P2PConfig, P2PPayload, Parsed } from './adapters/p2p/p2p-protocol.js'
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
export { DEFAULT_HARD_LIMIT, DEFAULT_SOFT_LIMIT, createLedger } from './budget-config.js'
export type { BudgetConfig, LedgerOptions } from './budget-config.js'
export { compilePolicy } from './policy-config.js'
export type { CompiledPolicy, PolicyConfig } from './policy-config.js'
export type { CheckReport, PipelineNodeSpec, PipelineSettings } from './pipeline-config.js'
export { BudgetLedger, DEFAULT_BUDGET, sessionKeyFor } from './budget-ledger.js'
export { TurnBilling } from './turn-billing.js'
export type { TurnBillingOptions } from './turn-billing.js'
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
export { DEFAULT_HOST, DEFAULT_PORT, SIGNATURE_HEADER, checkListenerConfig, startListener } from './adapters/p2p/p2p-listener.js'
export type { Listener, ListenerConfig, ListenerOptions } from './adapters/p2p/p2p-listener.js'
export { DEFAULT_TURN_TIMEOUT_MS, PeerSessions, TurnTimeoutError } from './peer-sessions.js'
export type {
  PeerSessionsOptions,
  PeerTurn,
  PeerTurnInput,
  PromptRequest,
  SessionControllerLike,
  SessionEventLike,
  SessionMessagePart,
} from './peer-sessions.js'
export {
  CONNECTION_STATES,
  LISTEN_STATES,
  STALE_AFTER_MS,
  buildConnectionHealth,
  buildListenerHealth,
  buildStatus,
  isFresh,
  mayInformQuota,
  statusNotification,
} from './adapter-status.js'
export type {
  AdapterStatus,
  CapabilitySet,
  ChannelRef,
  ConnectionHealth,
  ConnectionInput,
  ConnectionState,
  Health,
  ListenerHealth,
  ListenerInput,
  ListenState,
  PlatformAttributes,
  QuotaView,
  StatusInput,
  StatusNotification,
} from './adapter-status.js'
export { SecretRefError, assertPeersResolvable, resolvePeers, staticCredentials } from './adapters/p2p/p2p-secrets.js'
export type { CredentialsLike, PeerRef, ResolvedSecret } from './adapters/p2p/p2p-secrets.js'
export { BuildError, buildPipeline } from './build-pipeline.js'
export type { BudgetVerdict, JudgeVerdict, MatchRule, PipelineDeps } from './build-pipeline.js'
export { DEFAULT_SEND_TIMEOUT_MS, sendToPeer } from './adapters/p2p/p2p-send.js'
export type { PeerTarget, P2PSendInput } from './adapters/p2p/p2p-send.js'
export { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from './inbound-gate.js'
export type { AdmitInput, GateDecision, GateOptions, GateReason, LoopConfig } from './inbound-gate.js'
export { ChannelStats } from './channel-stats.js'
export { TurnStats } from './turn-stats.js'
export type { TurnStatsSnapshot } from './turn-stats.js'
export type { ChannelFailure, ChannelState } from './channel-stats.js'
export { STATUS_ROUTE, hasForwardingHeaders, isLoopbackPeer } from './adapters/p2p/p2p-status.js'
