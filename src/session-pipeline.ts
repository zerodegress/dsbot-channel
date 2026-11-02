import { ConfigError } from './config.js'
import { unboundReason, unboundRuleReason } from './pipeline-bindable.js'
import type { PipelineNodeSpec } from './pipeline-config.js'
import type { PipelineLayer } from './pipeline-scopes.js'
import { resolveAndCheck, resolvePipeline } from './pipeline-scopes.js'

const LAYER_FIELDS: readonly string[] = ['inherit', 'remove', 'insert', 'override']
const INSERT_FIELDS: readonly string[] = ['id', 'type', 'after', 'before']

/** What the host knows about one bot: the pipeline it runs, the rules it can match, and the peers it addresses. */
export interface BotScope {
  /** The nodes this bot runs when no session layer applies. */
  base: readonly PipelineNodeSpec[]
  /** A rule node is bound only when every adapter of this bot can match one. */
  denyRules: boolean
  allowRules: boolean
  /** Every adapter of this bot carries the prepare hook, so a layer may introduce the node. */
  prepare: boolean
}

export interface SessionPipelineOptions {
  /** One entry per bot the profile answers for, keyed by the name its adapters report. */
  bots: ReadonlyMap<string, BotScope>
}

/** Refuses a field nothing reads, so a layer built as plain data cannot write it and see nothing happen. */
function checkShape(layer: PipelineLayer): void {
  const unknown = Object.keys(layer).filter((key) => !LAYER_FIELDS.includes(key))
  if (unknown.length > 0) {
    throw new ConfigError(`a session layer names a field no layer has: ${quote(unknown)}`, ['pipeline'])
  }
  for (const spec of layer.insert ?? []) {
    const extra = Object.keys(spec).filter((key) => !INSERT_FIELDS.includes(key))
    if (extra.length > 0) {
      throw new ConfigError(`insert "${spec.id}" names a field no insert has: ${quote(extra)}`, ['pipeline'])
    }
  }
}

function quote(fields: readonly string[]): string {
  return fields.map((field) => `"${field}"`).join(', ')
}

function copyLayer(layer: PipelineLayer): PipelineLayer {
  const copy: PipelineLayer = {}
  if (layer.inherit !== undefined) copy.inherit = layer.inherit
  if (layer.remove !== undefined) copy.remove = [...layer.remove]
  if (layer.insert !== undefined) copy.insert = layer.insert.map((spec) => ({ ...spec }))
  if (layer.override !== undefined) {
    copy.override = Object.fromEntries(
      Object.entries(layer.override).map(([id, patch]) => [id, { ...patch }]),
    )
  }
  return copy
}

/** Holds the pipeline difference each live session runs, declared at run time rather than in the profile. */
export class SessionPipelines {
  readonly #options: SessionPipelineOptions
  readonly #layers = new Map<string, Map<string, PipelineLayer>>()

  constructor(options: SessionPipelineOptions) {
    this.#options = options
  }

  /** Declares what one session runs; a key the profile could never address, or a bot nobody answers for, is refused. */
  forSession(botName: string, key: string, layer: PipelineLayer): void {
    const bot = this.#bot(botName)
    checkShape(layer)
    const held = copyLayer(layer)
    this.#check(bot, held)
    const sessions = this.#layers.get(botName) ?? new Map<string, PipelineLayer>()
    sessions.set(key, held)
    this.#layers.set(botName, sessions)
  }

  /** Drops a session layer, for a conversation that is gone. */
  forgetSession(botName: string, key: string): void {
    const held = this.#layers.get(botName)
    if (held === undefined) return
    held.delete(key)
    if (held.size === 0) this.#layers.delete(botName)
  }

  /** The nodes a session runs today, which is also the base its difference is applied to; declaring nothing reads the bot pipeline. */
  pipelineFor(botName: string, key?: string): PipelineNodeSpec[] {
    const bot = this.#bot(botName)
    const session = key === undefined ? undefined : this.#layers.get(botName)?.get(key)
    return resolvePipeline({
      global: bot.base,
      ...(session === undefined ? {} : { session }),
    }).nodes
  }

  #bot(botName: string): BotScope {
    const bot = this.#options.bots.get(botName)
    if (bot !== undefined) return bot
    const known = [...this.#options.bots.keys()]
    const whose = known.length === 0 ? '' : `; known: ${known.join(', ')}`
    throw new ConfigError(`no adapter answers for bot "${botName}"${whose}`, ['pipeline'])
  }

  #check(bot: BotScope, layer: PipelineLayer): void {
    const report = resolveAndCheck({ global: bot.base, session: layer })
    const fatal = [...report.layer.fatal, ...report.pipeline.fatal]
    if (fatal.length > 0) throw new ConfigError(fatal.join('; '), ['pipeline'])
    const rules = { deny: bot.denyRules, allow: bot.allowRules }
    const introduced = new Set([...(layer.insert ?? []).map((spec) => spec.id), ...Object.keys(layer.override ?? {})])
    for (const node of report.nodes) {
      if (!introduced.has(node.id)) continue
      if (node.type === 'prepare' && !bot.prepare) {
        throw new ConfigError(
          `node "${node.id}": this bot's adapters supply no prepare hook, so the node could only fail every turn`,
          ['pipeline'],
        )
      }
      const reason = unboundReason(node) ?? unboundRuleReason(node, rules)
      if (reason !== undefined) throw new ConfigError(`node "${node.id}": ${reason}`, ['pipeline'])
    }
  }
}
