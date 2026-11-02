import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { REGISTRY_SERVICE, checkAdapterKind } from './adapter-registry.js'
import type { AdapterRegistry } from './adapter-registry.js'
import type { AdapterMount } from './adapter-registry.js'
import { buildPipeline } from './build-pipeline.js'
import type { PipelineDeps } from './build-pipeline.js'
import { createLedger } from './budget-config.js'
import type { BudgetConfig } from './budget-config.js'
import type { Hold } from './budget-ledger.js'
import { ClosedChains } from './chain-closer.js'
import { ConfigError, validateConfig } from './config.js'
import type { AdapterCheckSettings, AdapterHandle, ChannelAdapter, InboundMessage, InboundVerdict } from './contract.js'
import { CHAIN_ID_MAX, GUIDANCE_MAX, REPLY_TARGET_MAX, REQUEST_ID_MAX, SESSION_KEY_MAX, tokenProblem } from './contract.js'
import { SOURCE_KIND_MAX } from './event-types.js'
import { createDeclineTool, createNoReplyTool } from './control-tools.js'
import type { ControlPorts, TurnRef } from './control-tools.js'
import { ChainGuard, KeyGuard } from './event-keys.js'
import { InboundGate } from './inbound-gate.js'
import { InjectionLedger, TOOL_MODE_NOTICE, TOOL_MODE_NOTICE_MAX } from './inbound-guidance.js'
import { usageSnapshot } from './usage-view.js'
import type { BotLedger } from './usage-view.js'
import { PeerSessions } from './peer-sessions.js'
import type { SessionControllerLike, SessionEventLike } from './peer-sessions.js'
import type { PipelineEvent } from './pipeline.js'
import { unboundReason, unboundRuleReason } from './pipeline-bindable.js'
import type { PipelineNodeSpec, PipelineSettings } from './pipeline-config.js'
import { DEFAULT_PIPELINE } from './pipeline-config.js'
import type { PipelineLayer, PipelineScopes } from './pipeline-scopes.js'
import { resolveAndCheck, resolvePipeline } from './pipeline-scopes.js'
import { compilePolicy } from './policy-config.js'
import { compileReply } from './reply-config.js'
import type { ReplyFacts } from './reply-config.js'
import type { PolicyConfig } from './policy-config.js'
import { PushRouter, createSendText } from './push-tool.js'
import { CapabilityGate, createReadHistory, createSendFile, createSendImage } from './capability-tools.js'
import type { PushSource, SendTextTool } from './push-tool.js'
import type { BotScope } from './session-pipeline.js'
import { SessionPipelines } from './session-pipeline.js'
import { TurnBilling } from './turn-billing.js'
import { TurnStats } from './turn-stats.js'
import type { TurnOutcome } from './turn-stats.js'
import { createWarn } from './warn.js'

export interface PolicySettings extends PolicyConfig {
  relayLimit: number
  relayResetMs: number
  /** A group message must name this bot or everyone before it may start a turn. */
  requireMention: boolean
  budget?: BudgetConfig | undefined
}

export interface AdapterConfig {
  kind?: string
  channel: string
  instance: string
  botName: string
  /** Runs every turn of this adapter in one existing session instead of one per address. */
  session?: string
  policy: PolicySettings
  pipeline?: PipelineLayer | undefined
  status?: boolean
  /** The transport block; only the adapter of this kind reads it. */
  transport?: Record<string, unknown>
}

export interface ChannelConfig {
  adapters: AdapterConfig[]
  pipeline: PipelineSettings & { global: PipelineNodeSpec[] }
  /** How a turn answers: auto lets it write, tool requires a tool call. */
  reply?: unknown
}

const nodeSpecSchema = Schema.object({
  id: Schema.string().required(),
  type: Schema.string().required(),
  restrictSkip: Schema.any(),
  mayRestrict: Schema.boolean(),
})

const layerSchema = Schema.object({
  inherit: Schema.string(),
  remove: Schema.array(Schema.string()).default([]),
  insert: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      type: Schema.string().required(),
      after: Schema.string(),
      before: Schema.string(),
    }),
  ).default([]),
  override: Schema.dict(Schema.any()).default({}),
})

/* eslint-disable @typescript-eslint/no-explicit-any */
export const Config: any = Schema.object({
  pipeline: Schema.object({
    global: Schema.array(nodeSpecSchema).default([]),
    maxTurnMs: Schema.number().default(DEFAULT_PIPELINE.maxTurnMs),
    judgeTimeoutMs: Schema.number().default(DEFAULT_PIPELINE.judgeTimeoutMs),
  }).default({}),
  /** Nested shape, enum and regex checks live in reply-config; this schema only claims the key. */
  reply: Schema.any(),
  adapters: Schema
    .array(
      Schema.object({
        kind: Schema.string().default('p2p'),
        channel: Schema.string().required(),
        instance: Schema.string().required(),
        botName: Schema.string().required(),
        session: Schema.string(),
        policy: Schema.object({
          relayLimit: Schema.number().default(3),
          requireMention: Schema.boolean().default(false),
          relayResetMs: Schema.number().default(300_000),
          deny: Schema.object({
            words: Schema.array(Schema.string()).default([]),
            regexes: Schema.array(Schema.string()).default([]),
          }).default({}),
          allow: Schema.object({
            peers: Schema.array(Schema.string()).default([]),
          }).default({}),
          budget: Schema.object({
            capacity: Schema.number(),
            hardLimit: Schema.number(),
          }).default(undefined as never),
        }).default({}),
        pipeline: (layerSchema as any).default(undefined),
        status: Schema.boolean().default(true),
        transport: Schema.any(),
      }),
    )
    .default([]),
})
/* eslint-enable @typescript-eslint/no-explicit-any */

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'undefined'
}

/** The nodes a profile declares, or undefined when it declares no layer at all. */
function declaredNodes(config: ChannelConfig, adapter: AdapterConfig): PipelineNodeSpec[] | undefined {
  if (config.pipeline.global.length === 0 && adapter.pipeline === undefined) return undefined
  const scopes: PipelineScopes = {
    global: config.pipeline.global,
    ...(adapter.pipeline === undefined ? {} : { bot: adapter.pipeline }),
  }
  return resolvePipeline(scopes).nodes
}

/** Refuses a turn timing no pipeline can run with. */
export function checkPipelineSettings(settings: PipelineSettings): void {
  for (const field of ['maxTurnMs', 'judgeTimeoutMs'] as const) {
    const value = settings[field]
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(
        `${field} must be a whole number of milliseconds, at least 1: ${value}`,
        ['pipeline', field],
      )
    }
  }
  if (settings.judgeTimeoutMs > settings.maxTurnMs) {
    throw new ConfigError(
      `judgeTimeoutMs must not exceed maxTurnMs: ${settings.judgeTimeoutMs} > ${settings.maxTurnMs}`,
      ['pipeline', 'judgeTimeoutMs'],
    )
  }
}

/** Refuses a pipeline that cannot load, and reports the ones that only look wrong. */
export function checkPipelineScopes(config: ChannelConfig, warn: (message: string) => void): void {
  const layers = new Map<string, PipelineLayer>()
  for (const adapter of config.adapters) {
    const layer = adapter.pipeline
    if (layer === undefined) continue
    const seen = layers.get(adapter.botName)
    if (seen === undefined) {
      layers.set(adapter.botName, layer)
      continue
    }
    if (stable(seen) !== stable(layer)) {
      throw new ConfigError(
        `two adapters answer for bot "${adapter.botName}" with different pipeline layers; one bot runs one pipeline`,
        ['adapters'],
      )
    }
  }
  const scopes: PipelineScopes[] =
    layers.size === 0
      ? [{ global: config.pipeline.global }]
      : [...layers.values()].map((bot) => ({ global: config.pipeline.global, bot }))
  const fatal: string[] = []
  const warnings = new Set<string>()
  for (const one of scopes) {
    const report = resolveAndCheck(one)
    fatal.push(...report.layer.fatal, ...report.pipeline.fatal)
    for (const warning of [...report.layer.warnings, ...report.pipeline.warnings]) warnings.add(warning)
  }
  for (const one of scopes) {
    for (const node of resolvePipeline(one).nodes) {
      const reason = unboundReason(node)
      if (reason !== undefined) fatal.push(`node "${node.id}": ${reason}`)
    }
  }
  const sources: (AdapterConfig | undefined)[] = config.adapters.length === 0 ? [undefined] : config.adapters
  for (const adapter of sources) {
    const nodes =
      adapter === undefined
        ? config.pipeline.global.length === 0
          ? undefined
          : config.pipeline.global
        : declaredNodes(config, adapter)
    if (nodes === undefined) continue
    const rules = adapter === undefined ? undefined : compilePolicy(adapter.policy).deps
    const whose = adapter?.botName ? `bot "${adapter.botName}": ` : ''
    const bindings = {
      deny: (rules?.denyRules ?? []).length > 0,
      allow: (rules?.allowRules ?? []).length > 0,
    }
    for (const node of nodes) {
      const reason = unboundRuleReason(node, bindings)
      if (reason !== undefined) fatal.push(`${whose}${reason}`)
    }
  }
  const problems = [...new Set(fatal)]
  if (problems.length > 0) throw new ConfigError(`the pipeline cannot load: ${problems.join('; ')}`, ['pipeline'])
  for (const warning of warnings) warn(`dsbot-channel: pipeline warning: ${warning}`)
}

/** Collects what the host knows per bot: the pipeline it runs and the rules it can match. */
interface BotFacts extends BotScope {
  /** The dependencies the base pipeline is bound with, taken from the adapter that supplied it. */
  deps: PipelineDeps
}

function botScopes(config: ChannelConfig): Map<string, BotFacts> {
  const bots = new Map<string, BotFacts>()
  for (const adapter of config.adapters) {
    const seen = bots.get(adapter.botName)
    const compiled = compilePolicy(adapter.policy)
    const deny = (compiled.deps.denyRules ?? []).length > 0
    const allow = (compiled.deps.allowRules ?? []).length > 0
    const base = declaredNodes(config, adapter) ?? compiled.specs
    if (seen === undefined) {
      bots.set(adapter.botName, { base, denyRules: deny, allowRules: allow, prepare: false, deps: compiled.deps })
      continue
    }
    if (stable(seen.base) !== stable(base)) {
      throw new ConfigError(
        `two adapters answer for bot "${adapter.botName}" with different pipelines; one bot runs one pipeline`,
        ['adapters'],
      )
    }
    if (stable(seen.deps) !== stable(compiled.deps)) {
      throw new ConfigError(
        `two adapters answer for bot "${adapter.botName}" with different rules; one bot runs one pipeline`,
        ['adapters'],
      )
    }
    seen.denyRules &&= deny
    seen.allowRules &&= allow
  }
  return bots
}

/** Refuses a transport that takes its own policy out of the core block. */
function checkPolicy(adapter: AdapterConfig, index: number): void {
  const path = (field: string): string[] => ['adapters', String(index), 'policy', field]
  const { relayLimit, relayResetMs } = adapter.policy
  if (!Number.isInteger(relayLimit) || relayLimit < 1) {
    throw new ConfigError(`relayLimit must be a whole number of rounds, at least 1: ${relayLimit}`, path('relayLimit'))
  }
  if (!Number.isInteger(relayResetMs) || relayResetMs < 1) {
    throw new ConfigError(
      `relayResetMs must be a whole number of milliseconds, at least 1: ${relayResetMs}`,
      path('relayResetMs'),
    )
  }
  const budget = adapter.policy.budget
  if (budget !== undefined && budget.capacity === undefined) {
    throw new ConfigError('policy.budget.capacity is required', path('budget.capacity'))
  }
  if (budget?.capacity !== undefined && (!Number.isInteger(budget.capacity) || budget.capacity < 1)) {
    throw new ConfigError(
      `budget capacity must be a whole number of points, at least 1: ${budget.capacity}`,
      path('budget.capacity'),
    )
  }
  if (budget?.hardLimit !== undefined && (!Number.isFinite(budget.hardLimit) || budget.hardLimit <= 0 || budget.hardLimit > 1)) {
    throw new ConfigError(
      `budget hardLimit must be above 0 and at most 1: ${budget.hardLimit}`,
      path('budget.hardLimit'),
    )
  }
}

/** Binds this turn's hook; the bot level deps stay identical across adapters, which #77 compares.
 *  The node context is not read: the hook sees the event built for this message, not the pipeline's copy. */
function bindPrepare(
  deps: PipelineDeps,
  transport: ChannelAdapter,
  event: PipelineEvent,
  sessionKey: string,
  warn: (message: string) => void,
): PipelineDeps {
  const prepare = transport.prepare
  if (prepare === undefined) return deps
  return {
    ...deps,
    prepare: () => {
      try {
        prepare.call(transport, { event, sessionKey })
      } catch (error) {
        warn(`dsbot-channel: prepare for ${event.eventKey} on ${transport.kind} failed: ${String(error)}`)
      }
    },
  }
}

/** A prepare node runs only when every adapter answering for that bot carries the hook. */
function checkPrepareSupport(bots: Map<string, BotFacts>, channels: readonly MountedChannel[]): void {
  const perBot = new Map<string, MountedChannel[]>()
  for (const channel of channels) {
    const list = perBot.get(channel.config.botName) ?? []
    list.push(channel)
    perBot.set(channel.config.botName, list)
  }
  for (const [bot, facts] of bots) {
    const missing = (perBot.get(bot) ?? []).filter((channel) => typeof channel.adapter.prepare !== 'function')
    facts.prepare = missing.length === 0
    const node = facts.base.find((one) => one.type === 'prepare')
    if (node === undefined || missing.length === 0) continue
    const names = missing.map((channel) => `"${channel.config.channel}" (${channel.adapter.kind})`).join(', ')
    throw new ConfigError(
      `node "${node.id}": bot "${bot}" declares a prepare node, but adapter ${names} cannot prepare; every adapter answering for a bot must carry the hook`,
      ['adapters'],
    )
  }
}

/** One bot speaks with one voice: every adapter answering for it hands core the same guidance. */
function checkGuidance(channels: readonly MountedChannel[]): void {
  const byBot = new Map<string, { peer: string; group: string }>()
  for (const { config, adapter } of channels) {
    const guidance = adapter.guidance
    for (const [field, text] of [
      ['peer', guidance.peer],
      ['group', guidance.group],
    ] as const) {
      if (typeof text !== 'string' || text.length === 0) {
        throw new ConfigError(`guidance.${field} must be a non-empty string`, ['adapters', 'guidance', field])
      }
      if (Array.from(text).length > GUIDANCE_MAX) {
        throw new ConfigError(`guidance.${field} is longer than ${GUIDANCE_MAX} characters`, [
          'adapters',
          'guidance',
          field,
        ])
      }
    }
    const seen = byBot.get(config.botName)
    if (seen === undefined) {
      byBot.set(config.botName, { peer: guidance.peer, group: guidance.group })
      continue
    }
    if (seen.peer !== guidance.peer || seen.group !== guidance.group) {
      throw new ConfigError(
        `two adapters answer for bot "${config.botName}" with different guidance; one bot speaks with one voice`,
        ['adapters'],
      )
    }
  }
}

interface MountedChannel {
  config: AdapterConfig
  adapter: ChannelAdapter
  index: number
}

interface ChannelRuntime {
  channel: MountedChannel
  sessions: PeerSessions
  gate: InboundGate
  billing: TurnBilling
  deps: PipelineDeps
}

/** Reads the profile, pointing an old `p2p` key at the block that replaced it. */
function readConfig(raw: unknown): ChannelConfig {
  try {
    return validateConfig<ChannelConfig>(Config, raw)
  } catch (error) {
    if (error instanceof ConfigError && error.fields.includes('p2p')) {
      throw new ConfigError(
        `${error.message}; the transport block is now named "transport"`,
        error.path,
        error.fields,
      )
    }
    throw error
  }
}

/** Starts only the adapters the profile declares; an empty list starts nothing. */
export async function apply(ctx: Context, raw: unknown): Promise<void> {
  const registry = ctx.get(REGISTRY_SERVICE) as AdapterRegistry | undefined
  if (registry === undefined) {
    throw new ConfigError(
      `dsbot-channel found no adapter registry: mount "dsbot-channel/registry" before "dsbot-channel"`,
      ['adapters'],
    )
  }
  const config = readConfig(raw)
  const warn = createWarn(ctx)
  const settings: PipelineSettings = {
    maxTurnMs: config.pipeline.maxTurnMs,
    judgeTimeoutMs: config.pipeline.judgeTimeoutMs,
  }
  checkPipelineSettings(settings)
  checkPipelineScopes(config, warn)
  const bots = botScopes(config)
  const pipelines = new SessionPipelines({ bots })
  const channels = mountAdapters(config, settings, warn, registry)
  checkGuidance(channels)
  checkPrepareSupport(bots, channels)
  const reply = compileReply(config.reply)
  // A guard against a future edit to the notice text, not profile validation: the block is core-owned.
  if (TOOL_MODE_NOTICE.length > TOOL_MODE_NOTICE_MAX) {
    throw new ConfigError(`the tool-mode block is longer than ${TOOL_MODE_NOTICE_MAX} characters`, ['reply'])
  }
  type AnyTool = SendTextTool | ReturnType<typeof createNoReplyTool> | ReturnType<typeof createDeclineTool>
  const tools = ctx.get('tools') as { register: (definition: AnyTool) => () => void } | undefined
  if (reply.possibleTool && (tools === undefined || typeof tools.register !== 'function')) {
    throw new ConfigError('the tools service is required when a profile can choose tool mode', ['reply'])
  }
  const byBot = new Map<string, MountedChannel>()
  for (const channel of channels) {
    if (!byBot.has(channel.config.botName)) byBot.set(channel.config.botName, channel)
  }
  ctx.provide('dsbot-channel.pipeline')
  ctx.set('dsbot-channel.pipeline', {
    forSession: (botName: string, key: string, layer: PipelineLayer) => {
      const channel = byBot.get(botName)
      const problem = channel === undefined ? `no adapter answers for bot "${botName}"` : channel.adapter.checkSessionKey(key)
      if (problem !== undefined) throw new ConfigError(problem, ['pipeline'])
      pipelines.forSession(botName, key, layer)
    },
    forgetSession: (botName: string, key: string) => pipelines.forgetSession(botName, key),
    pipelineFor: (botName: string, key?: string) => pipelines.pipelineFor(botName, key),
  })
  if (config.adapters.length === 0) return
  const credentials = ctx.get('credentials') as
    | { resolve?: (reference: string) => Promise<{ value: string } | undefined> }
    | undefined
  if (typeof credentials?.resolve !== 'function') {
    throw new ConfigError('the credentials service is required to resolve peer secrets', ['adapters'])
  }
  const controller = ctx.get('sessionController') as SessionControllerLike | undefined
  if (controller === undefined || typeof controller.create !== 'function' || typeof controller.prompt !== 'function') {
    throw new ConfigError('the sessionController service is required to run peer messages', ['adapters'])
  }
  const observe = (listener: (sessionId: string, event: SessionEventLike) => void): (() => void) =>
    ctx.on('session/event', (session, event) => listener(session.id, event as unknown as SessionEventLike))
  const sources = new Map<string, PushSource>()
  const chains = new ClosedChains()
  const injected = new InjectionLedger()
  const activeTurns = new Map<string, TurnRef>()
  const eventKeys = new KeyGuard()
  const chainKeys = new ChainGuard()
  const turns = new TurnStats()
  const resolveSecret = async (reference: string): Promise<string | undefined> => {
    const found = await credentials.resolve?.(reference)
    return found?.value
  }

  const runTurn = async (runtime: ChannelRuntime, message: InboundMessage, sessionId: string): Promise<void> => {
    const { config: adapter, adapter: transport } = runtime.channel
    const turnRef: TurnRef = {
      eventId: message.requestId,
      chainId: message.chainId,
      channel: adapter.channel,
      target: message.replyTarget,
      sender: message.author.senderId,
      suppressed: message.suppressed === true || chains.isClosed(message.chainId),
      pushed: false,
    }
    activeTurns.set(sessionId, turnRef)
    turns.started()
    turns.open(message.eventKey)
    const ended = (outcome: TurnOutcome, code?: string): void => {
      turns.close({
        eventKey: message.eventKey,
        bot: adapter.botName,
        channel: adapter.channel,
        sessionKey: message.sessionKey,
        outcome,
        ...(code === undefined ? {} : { code }),
      })
    }
    let hold: Hold | undefined
    try {
      hold = runtime.billing.begin(adapter.botName, message.sessionKey, message.eventKey)
      const mode = reply.modeFor(replyFactsOf(message))
      const blocks: string[] = []
      if (injected.claim(message.sessionKey)) {
        const guidance = transport.guidance[message.source.scope === 'group' ? 'group' : 'peer']
        blocks.push(`[${transport.kind}] ${guidance}`)
      }
      if (injected.claimMode(message.sessionKey, mode)) blocks.push(TOOL_MODE_NOTICE)
      const turn = await runtime.sessions.runTurn({
        peer: message.sessionKey,
        requestId: message.requestId,
        text: blocks.length === 0 ? message.body.text : `${blocks.join('\n')}\n\n${message.body.text}`,
      })
      if (turnRef.suppressed) {
        if (turnRef.declined === true) {
          turns.suppressed('refused')
          ended('refused', turnRef.declinedCode)
          if (turnRef.declinedCode === undefined) {
            runtime.gate.recordReply(adapter.botName, message.sessionKey)
          }
          runtime.billing.reject(hold)
        } else {
          turns.suppressed('ended')
          ended('ended')
          runtime.billing.refund(hold)
        }
        hold = undefined
        return
      }
      if (turnRef.pushed) {
        turns.pushed()
        ended('pushed')
        runtime.billing.accept(hold)
        hold = undefined
        return
      }
      if (mode === 'tool' && turn.text.length > 0) {
        warn(
          `dsbot-channel: dropped the plain text answer for ${message.requestId} from ${message.replyTarget}: tool mode requires a tool call`,
        )
        turns.dropped()
        ended('dropped')
        runtime.billing.reject(hold)
        hold = undefined
        return
      }
      if (turn.text.length === 0) {
        warn(`dsbot-channel: the turn for ${message.requestId} from ${message.replyTarget} ended with no text and no tool call`)
        turns.empty()
        ended('empty')
        runtime.billing.reject(hold)
        hold = undefined
        return
      }
      const sent = await transport.send({
        target: message.replyTarget,
        to: message.author.senderId,
        body: turn.text,
        eventId: `reply:${randomUUID()}`,
        chainId: message.chainId,
        sender: adapter.botName,
        instance: adapter.instance,
        inReplyTo: message.requestId,
        inReplyToText: message.rawText,
      })
      if (sent.ok) {
        turns.replied()
        ended('replied')
        runtime.gate.recordReply(adapter.botName, message.sessionKey)
        runtime.billing.accept(hold)
        hold = undefined
        return
      }
      turns.sendFailed(sent.code)
      ended('failed', sent.code)
      runtime.billing.reject(hold)
      hold = undefined
      warn(`dsbot-channel: reply to ${message.replyTarget} was not delivered: ${sent.code} ${sent.reason}`)
    } finally {
      if (hold !== undefined) runtime.billing.refund(hold)
    }
  }

  const replyFactsOf = (message: InboundMessage): ReplyFacts => ({
    source: {
      kind: message.source.kind,
      instance: message.source.instance,
      peer: message.source.peer,
      scope: message.source.scope,
    },
    author: { kind: message.author.kind, senderId: message.author.senderId },
    transport: { mentioned: message.transport.mentioned, isReply: message.transport.isReply },
    body: { text: message.rawText, media: message.body.media },
  })

  const ledgers: BotLedger[] = []
  const reporting = new Set(channels.map((channel) => channel.adapter))
  const started: AdapterHandle[] = []
  ctx.effect(() => async () => {
    await Promise.allSettled(started.map((handle) => handle.stop()))
    reporting.clear()
    started.length = 0
  }, 'dsbot-channel: peer listeners')
  try {
    for (const channel of channels) {
      const { config: adapter, adapter: transport } = channel
      const sessions = new PeerSessions({
        controller,
        observe,
        ...(adapter.session === undefined ? {} : { session: adapter.session }),
      })
      const compiled = compilePolicy(adapter.policy)
      const budget = adapter.policy.budget
      const ledger = budget === undefined ? undefined : createLedger(budget)
      if (!ledgers.some((one) => one.bot === adapter.botName)) ledgers.push({ bot: adapter.botName, ledger })
      const runtime: ChannelRuntime = {
        channel,
        sessions,
        gate: new InboundGate({
          loop: { relayLimit: adapter.policy.relayLimit, relayResetMs: adapter.policy.relayResetMs },
          requireMention: adapter.policy.requireMention === true,
          ledger,
        }),
        billing: new TurnBilling({ ledger }),
        deps: bots.get(adapter.botName)?.deps ?? compiled.deps,
      }
      const onMessage = async (message: InboundMessage): Promise<InboundVerdict> => {
        const kindProblem = tokenProblem('source.kind', message.source.kind, SOURCE_KIND_MAX)
        if (kindProblem !== undefined) return { ok: false, code: 'source_kind_invalid', reason: kindProblem }
        if (message.source.kind !== transport.kind) {
          return {
            ok: false,
            code: 'source_kind_invalid',
            reason: `message claims source.kind "${message.source.kind}", but this adapter is "${transport.kind}"`,
          }
        }
        const keyProblem =
          tokenProblem('session key', message.sessionKey, SESSION_KEY_MAX) ?? transport.checkSessionKey(message.sessionKey)
        if (keyProblem !== undefined) return { ok: false, code: 'session_key_invalid', reason: keyProblem }
        const requestProblem = tokenProblem('requestId', message.requestId, REQUEST_ID_MAX)
        if (requestProblem !== undefined) return { ok: false, code: 'request_id_invalid', reason: requestProblem }
        const targetProblem = tokenProblem('replyTarget', message.replyTarget, REPLY_TARGET_MAX)
        if (targetProblem !== undefined) return { ok: false, code: 'reply_target_invalid', reason: targetProblem }
        const conflict = eventKeys.check(message.eventKey, message.body.text)
        if (conflict !== undefined) return { ok: false, code: 'event_key_conflict', reason: conflict }
        const chainProblem = tokenProblem('chainId', message.chainId, CHAIN_ID_MAX)
        if (chainProblem !== undefined) return { ok: false, code: 'chain_conflict', reason: chainProblem }
        const chainConflict = chainKeys.check(message.chainId, message.eventKey)
        if (chainConflict !== undefined) return { ok: false, code: 'chain_conflict', reason: chainConflict }
        const specs = pipelines.pipelineFor(adapter.botName, message.sessionKey)
        const event: PipelineEvent = {
          eventKey: message.eventKey,
          scope: message.source.scope,
          mentioned: message.transport.mentioned,
          text: message.rawText,
          ...(message.source.peer === null ? {} : { peer: message.source.peer }),
        }
        const pipeline =
          specs.length > 0
            ? buildPipeline(specs, bindPrepare(runtime.deps, transport, event, message.sessionKey, warn), settings)
            : undefined
        if (message.author.kind === 'person') runtime.gate.resetPeer(message.sessionKey, adapter.botName)
        const decision = await runtime.gate.admit({
          event,
          peer: message.source.peer ?? message.replyTarget,
          botId: adapter.botName,
          session: message.sessionKey,
          ...(pipeline === undefined ? {} : { pipeline }),
        })
        if (!decision.allow) {
          const detail = decision.detail === undefined ? '' : ` (${decision.detail})`
          turns.close({
            eventKey: message.eventKey,
            bot: adapter.botName,
            channel: adapter.channel,
            sessionKey: message.sessionKey,
            outcome: 'rejected',
            code: decision.reason,
          })
          return { ok: false, code: 'rejected', reason: `${decision.reason}${detail}` }
        }
        const sessionId = await sessions.sessionFor(message.sessionKey)
        sources.set(sessionId, {
          channel: adapter.channel,
          replyTarget: message.replyTarget,
          sender: message.author.senderId,
        })
        setTimeout(() => {
          void runTurn(runtime, message, sessionId).catch((error: unknown) => {
            turns.failed()
            turns.close({
              eventKey: message.eventKey,
              bot: adapter.botName,
              channel: adapter.channel,
              sessionKey: message.sessionKey,
              outcome: 'failed',
            })
            warn(`dsbot-channel: peer turn for ${message.replyTarget} failed: ${String(error)}`)
          })
        }, 0)
        return { ok: true }
      }
      started.push(await transport.start({ onMessage, resolveSecret }))
    }
  } catch (error) {
    await Promise.allSettled(started.map((handle) => handle.stop()))
    throw error
  }
  ctx.provide('dsbot-channel.status')
  ctx.set('dsbot-channel.status', {
    snapshot: () => ({ sampledAt: Date.now(), adapters: [...reporting].map((adapter) => adapter.status()) }),
  })
  ctx.provide('dsbot-channel.turns')
  ctx.set('dsbot-channel.turns', { snapshot: () => turns.snapshot() })
  ctx.provide('dsbot-channel.usage')
  ctx.set('dsbot-channel.usage', { snapshot: () => usageSnapshot(ledgers) })
  ctx.provide('dsbot-channel.peers')
  ctx.set('dsbot-channel.peers', started)
  if (tools !== undefined && typeof tools.register === 'function') {
    const byChannel = new Map(channels.map((channel) => [channel.config.channel, channel]))
    const router = new PushRouter({
      channels: channels.map((channel) => ({
        channel: channel.config.channel,
        instance: channel.config.instance,
        botName: channel.config.botName,
      })),
      source: (sessionId) => (sessionId === undefined ? undefined : sources.get(sessionId)),
      checkTarget: (channel, target) => byChannel.get(channel)?.adapter.checkTarget(target),
      describeTargets: (channel) => byChannel.get(channel)?.adapter.describeTargets() ?? '',
      delivered: (sessionId) => {
        if (sessionId === undefined) return
        const turn = activeTurns.get(sessionId)
        if (turn !== undefined) turn.pushed = true
      },
      send: async (delivery) => {
        const channel = byChannel.get(delivery.channel)
        if (channel === undefined) {
          return {
            ok: false,
            code: 'no_url',
            retryable: false,
            reason: `channel "${delivery.channel}" is no longer configured`,
          }
        }
        return channel.adapter.send({
          target: delivery.target,
          to: delivery.to,
          body: delivery.text,
          eventId: delivery.eventId,
          chainId: delivery.eventId,
          sender: channel.config.botName,
          instance: channel.config.instance,
        })
      },
    })
    ctx.effect(() => tools.register(createSendText(router)), 'dsbot-channel: send_text tool')
    const gate = new CapabilityGate({
      router,
      capabilities: (channel) => byChannel.get(channel)?.adapter.capabilities,
    })
    ctx.effect(() => tools.register(createSendImage(gate)), 'dsbot-channel: send_image tool')
    ctx.effect(() => tools.register(createSendFile(gate)), 'dsbot-channel: send_file tool')
    ctx.effect(() => tools.register(createReadHistory(gate)), 'dsbot-channel: read_history tool')
    const ports: ControlPorts = {
      turnOf: (sessionId) => (sessionId === undefined ? undefined : activeTurns.get(sessionId)),
      isClosed: (eventId) => chains.isClosed(eventId),
      closeChain: (eventId) => {
        chains.close(eventId)
      },
      decline: async (turn, reason, note) => {
        const channel = byChannel.get(turn.channel)
        if (channel === undefined) {
          return { ok: false, code: 'no_url', reason: `channel "${turn.channel}" is gone` }
        }
        const refuse = channel.adapter.refuse?.bind(channel.adapter)
        if (refuse === undefined) {
          return { ok: false, supported: false, code: 'rejected', reason: 'this channel cannot carry a refusal' }
        }
        const sent = await refuse({
          target: turn.target,
          ...(turn.sender.length === 0 ? {} : { to: turn.sender }),
          inReplyTo: turn.eventId,
          chainId: turn.chainId,
          reason,
          ...(note === undefined ? {} : { note }),
        })
        return sent.ok ? { ok: true } : { ok: false, code: sent.code, reason: sent.reason }
      },
    }
    ctx.effect(() => tools.register(createNoReplyTool(ports)), 'dsbot-channel: no_reply tool')
    ctx.effect(() => tools.register(createDeclineTool(ports)), 'dsbot-channel: decline tool')
  }
}

/** Creates every adapter the profile declares, before any of them opens a socket. */
function mountAdapters(
  config: ChannelConfig,
  settings: AdapterCheckSettings,
  warn: (message: string) => void,
  registry: AdapterRegistry,
): MountedChannel[] {
  const seen = new Set<string>()
  return config.adapters.map((adapter, index) => {
    if (!adapter.botName) throw new ConfigError('botName is required for each adapter', ['adapters', String(index)])
    if (seen.has(adapter.channel)) {
      throw new ConfigError(`duplicate adapter channel: ${adapter.channel}`, ['adapters', String(index), 'channel'])
    }
    seen.add(adapter.channel)
    checkPolicy(adapter, index)
    const kind = adapter.kind ?? 'p2p'
    checkAdapterKind(kind)
    const mount: AdapterMount = {
      kind,
      channel: adapter.channel,
      instance: adapter.instance,
      botName: adapter.botName,
      transport: adapter.transport ?? {},
      ...(adapter.status === undefined ? {} : { status: adapter.status }),
    }
    const transport = registry.factory(kind)(mount, { warn })
    if (adapter.policy.requireMention === true && transport.capabilities.mention !== true) {
      throw new ConfigError(
        `policy.requireMention needs a transport that can tell mentions apart; "${kind}" cannot`,
        ['adapters', String(index), 'policy', 'requireMention'],
      )
    }
    if (transport.kind !== kind) {
      throw new ConfigError(
        `adapter mounted as kind "${kind}" reports kind "${transport.kind}"; a transport answers to the kind it registered`,
        ['adapters', String(index), 'kind'],
      )
    }
    transport.checkConfig(settings)
    return { config: adapter, adapter: transport, index }
  })
}
