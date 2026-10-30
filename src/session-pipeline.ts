import { ConfigError } from './config.js'
import { unboundReason } from './pipeline-bindable.js'
import type { PipelineNodeSpec } from './pipeline-config.js'
import type { PipelineLayer } from './pipeline-scopes.js'
import { resolveAndCheck, resolvePipeline } from './pipeline-scopes.js'

export const SESSION_KEY = /^(p2p|group|peer):.+$/

export interface SessionPipelineOptions {
  global: readonly PipelineNodeSpec[]
  /** The bot layer each bot answered for, keyed by the name its adapters report. */
  botLayers: ReadonlyMap<string, PipelineLayer>
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
    this.#check(botName, key, layer)
    const held = this.#layers.get(botName) ?? new Map<string, PipelineLayer>()
    held.set(key, layer)
    this.#layers.set(botName, held)
  }

  /** Drops a session layer, for a conversation that is gone. */
  forgetSession(botName: string, key: string): void {
    const held = this.#layers.get(botName)
    if (held === undefined) return
    held.delete(key)
    if (held.size === 0) this.#layers.delete(botName)
  }

  /** The pipeline this session runs now, or the bot one when it declared nothing. */
  pipelineFor(botName: string, key?: string): PipelineNodeSpec[] {
    const bot = this.#options.botLayers.get(botName)
    const session = key === undefined ? undefined : this.#layers.get(botName)?.get(key)
    return resolvePipeline({
      global: this.#options.global,
      ...(bot === undefined ? {} : { bot }),
      ...(session === undefined ? {} : { session }),
    }).nodes
  }

  keysFor(botName: string): string[] {
    return [...(this.#layers.get(botName)?.keys() ?? [])]
  }

  #check(botName: string, key: string, layer: PipelineLayer): void {
    if (!this.#options.botLayers.has(botName)) {
      const known = [...this.#options.botLayers.keys()].join(', ')
      throw new ConfigError(`no adapter answers for bot "${botName}"; known: ${known}`, ['pipeline'])
    }
    if (!SESSION_KEY.test(key)) {
      throw new ConfigError(`session key must look like p2p:<peer>, group:<id> or peer:<openid>: "${key}"`, ['pipeline'])
    }
    const bot = this.#options.botLayers.get(botName)
    const report = resolveAndCheck({
      global: this.#options.global,
      ...(bot === undefined ? {} : { bot }),
      session: layer,
    })
    const fatal = [...report.layer.fatal, ...report.pipeline.fatal]
    if (fatal.length > 0) throw new ConfigError(fatal.join('; '), ['pipeline'])
    const introduced = new Set([...(layer.insert ?? []).map((spec) => spec.id), ...Object.keys(layer.override ?? {})])
    for (const node of report.nodes) {
      if (!introduced.has(node.id)) continue
      const reason = unboundReason(node)
      if (reason !== undefined) throw new ConfigError(`node "${node.id}": ${reason}`, ['pipeline'])
    }
  }
}
