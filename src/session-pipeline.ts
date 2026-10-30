import { ConfigError } from './config.js'
import { unboundReason, unboundRuleReason } from './pipeline-bindable.js'
import type { PipelineNodeSpec } from './pipeline-config.js'
import type { PipelineLayer } from './pipeline-scopes.js'
import { resolveAndCheck, resolvePipeline } from './pipeline-scopes.js'

/** A group id and an openid have no registry to check against, so only the shape of those keys is verified. */
export const SESSION_KEY = /^(p2p|group|peer):.+$/

const P2P_PREFIX = 'p2p:'

/** What the host knows about one bot: its profile layer, the rules it can match, and the peers it addresses. */
export interface BotScope {
  layer?: PipelineLayer | undefined
  /** A rule node is bound only when every adapter of this bot can match one. */
  denyRules: boolean
  allowRules: boolean
  peers: readonly string[]
}

export interface SessionPipelineOptions {
  global: readonly PipelineNodeSpec[]
  /** One entry per bot the profile answers for, keyed by the name its adapters report. */
  bots: ReadonlyMap<string, BotScope>
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
    this.#checkKey(key)
    this.#checkPeer(botName, bot, key)
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
    if (key !== undefined) this.#checkKey(key)
    const session = key === undefined ? undefined : this.#layers.get(botName)?.get(key)
    return resolvePipeline({
      global: this.#options.global,
      ...(bot.layer === undefined ? {} : { bot: bot.layer }),
      ...(session === undefined ? {} : { session }),
    }).nodes
  }

  keysFor(botName: string): string[] {
    return [...(this.#layers.get(botName)?.keys() ?? [])]
  }

  #bot(botName: string): BotScope {
    const bot = this.#options.bots.get(botName)
    if (bot !== undefined) return bot
    const known = [...this.#options.bots.keys()]
    const whose = known.length === 0 ? '' : `; known: ${known.join(', ')}`
    throw new ConfigError(`no adapter answers for bot "${botName}"${whose}`, ['pipeline'])
  }

  #checkKey(key: string): void {
    if (!SESSION_KEY.test(key)) {
      throw new ConfigError(`session key must look like p2p:<peer>, group:<id> or peer:<openid>: "${key}"`, ['pipeline'])
    }
  }

  #checkPeer(botName: string, bot: BotScope, key: string): void {
    if (!key.startsWith(P2P_PREFIX)) return
    const peer = key.slice(P2P_PREFIX.length)
    if (bot.peers.includes(peer)) return
    const known = bot.peers.length === 0 ? 'this bot addresses no peer' : `known: ${bot.peers.join(', ')}`
    throw new ConfigError(`bot "${botName}" addresses no peer "${peer}"; ${known}`, ['pipeline'])
  }

  #check(bot: BotScope, layer: PipelineLayer): void {
    const report = resolveAndCheck({
      global: this.#options.global,
      ...(bot.layer === undefined ? {} : { bot: bot.layer }),
      session: layer,
    })
    const fatal = [...report.layer.fatal, ...report.pipeline.fatal]
    if (fatal.length > 0) throw new ConfigError(fatal.join('; '), ['pipeline'])
    const rules = { deny: bot.denyRules, allow: bot.allowRules }
    const introduced = new Set([...(layer.insert ?? []).map((spec) => spec.id), ...Object.keys(layer.override ?? {})])
    for (const node of report.nodes) {
      if (!introduced.has(node.id)) continue
      const reason = unboundReason(node) ?? unboundRuleReason(node, rules)
      if (reason !== undefined) throw new ConfigError(`node "${node.id}": ${reason}`, ['pipeline'])
    }
  }
}
