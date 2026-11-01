import { apply } from './plugin.js'
// Composition root: the only place a transport is named, so core never imports one.
import './adapters/p2p/index.js'
import './adapters/onebot/index.js'

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
export { buildEvent, chargeKey } from './event-build.js'
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
export { CHAIN_ID_MAX, GUIDANCE_MAX, INBOUND_REJECTIONS, REFUSE_REASONS, REPLY_TARGET_MAX, REQUEST_ID_MAX, SESSION_KEY_MAX, tokenProblem } from './contract.js'
export type {
  AdapterCheckSettings,
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  InboundMessage,
  InboundRejection,
  InboundVerdict,
  RefuseInput,
  RefuseReason,
  RefuseResult,
  SendFailure,
  SendFailureCode,
  SendInput,
  SendResult,
  SendSuccess,
} from './contract.js'
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
export { DEFAULT_PIPELINE, checkPipeline } from './pipeline-config.js'
export { DEFAULT_HARD_LIMIT, DEFAULT_SOFT_LIMIT, createLedger } from './budget-config.js'
export type { BudgetConfig, LedgerOptions } from './budget-config.js'
export { compilePolicy } from './policy-config.js'
export type { CompiledPolicy, PolicyConfig } from './policy-config.js'
export type { CheckReport, PipelineNodeSpec, PipelineSettings } from './pipeline-config.js'
export { BudgetLedger, DEFAULT_BUDGET } from './budget-ledger.js'
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
  Usage,
} from './budget-ledger.js'
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
  LISTEN_STATES,
  buildListenerHealth,
  buildStatus,
} from './adapter-status.js'
export type {
  AdapterStatus,
  CapabilitySet,
  ConnectionHealth,
  ConnectionState,
  Health,
  ListenerHealth,
  ListenerInput,
  ListenState,
  PlatformAttributes,
  QuotaView,
  StatusInput,
} from './adapter-status.js'
export { BuildError, buildPipeline } from './build-pipeline.js'
export type { BudgetVerdict, JudgeVerdict, MatchRule, PipelineDeps } from './build-pipeline.js'
export { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from './inbound-gate.js'
export type { AdmitInput, GateDecision, GateOptions, GateReason, LoopConfig } from './inbound-gate.js'
export { ChannelStats } from './channel-stats.js'
export { TurnStats } from './turn-stats.js'
export type { TurnStatsSnapshot } from './turn-stats.js'
export type { ChannelFailure, ChannelState } from './channel-stats.js'
