import { apply } from './plugin.js'

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
export { ADAPTER_META_MAX_BYTES, ADAPTER_META_MAX_DEPTH, adapterMetaOf } from './adapter-meta.js'
export { ConfigError, WILDCARD_HOSTS, assertBindHost, strict, validateConfig } from './config.js'
export {
  ADAPTER_KIND_MAX,
  BUILTIN_KINDS,
  THIRD_PARTY_KIND,
  AdapterRegistry,
  REGISTRY_SERVICE,
  checkAdapterKind,
  defineAdapterPlugin,
} from './adapter-registry.js'
export { registryPlugin } from './registry-plugin.js'
export { createWebhookAdapter, parseWebhookConfig, WebhookAdapter } from './adapters/webhook/index.js'
export { classOf as webhookClassOf, mapWebhook } from './adapters/webhook/mapping.js'
export { createMailAdapter, parseMailConfig, MailAdapter } from './adapters/mail/index.js'
export { mapMail } from './adapters/mail/mapping.js'
export { default as systemOneJudge, Config as systemOneJudgeConfig } from './system-one.js'
export { default as llmJudge, Config as llmJudgeConfig } from './llm.js'
export { JUDGE_SERVICE } from './judge-providers.js'
export type { JudgeFn, JudgeVerdictLike } from './judge-providers.js'
export type { AdapterFactory, AdapterMount, AdapterOptions } from './adapter-registry.js'
export { CHAIN_ID_MAX, GUIDANCE_MAX, INBOUND_REJECTIONS, MESSAGE_KINDS, REFUSE_REASONS, REPLY_TARGET_MAX, REQUEST_ID_MAX, SESSION_KEY_MAX, tokenProblem } from './contract.js'
export type {
  AdapterCheckSettings,
  AdapterHandle,
  AdapterPorts,
  ChannelAdapter,
  EventDescriptor,
  InboundMessage,
  MessageKind,
  InboundRejection,
  InboundVerdict,
  PrepareInput,
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
export { DEFAULT_HARD_LIMIT, createLedger } from './budget-config.js'
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
  ModelRoute,
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
  AdapterCounters,
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
  SendFailureView,
  StatusInput,
} from './adapter-status.js'
export { BuildError, buildPipeline } from './build-pipeline.js'
export type { BudgetVerdict, JudgeVerdict, MatchRule, PipelineDeps } from './build-pipeline.js'
export { DEFAULT_LOOP_IDLE_RESET_MS, DEFAULT_LOOP_MAX_TURNS, InboundGate } from './inbound-gate.js'
export type { AdmitInput, GateDecision, GateOptions, GateReason, LoopConfig } from './inbound-gate.js'
export { TURN_OUTCOMES, TurnStats } from './turn-stats.js'
export type { TurnOutcome, TurnRecord, TurnStatsOptions, TurnStatsSnapshot } from './turn-stats.js'
export { usageSnapshot } from './usage-view.js'
export type { BotLedger, BotLimits, BotUsage, SessionUsage, UsageSnapshot } from './usage-view.js'
