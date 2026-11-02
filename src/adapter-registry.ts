import type { Context } from '@deepseek-ai/cordis'
import { ConfigError } from './config.js'
import type { ChannelAdapter } from './contract.js'

/** What core knows about an adapter before it asks the transport to validate itself. */
export interface AdapterMount {
  kind: string
  channel: string
  instance: string
  botName: string
  /** The transport block the profile declared; only the adapter knows its shape. */
  transport: Record<string, unknown>
  /** Whether this adapter answers its own status route; the transport decides what that means. */
  status?: boolean | undefined
}

export interface AdapterOptions {
  warn(message: string): void
}

export type AdapterFactory = (mount: AdapterMount, options: AdapterOptions) => ChannelAdapter

/** Kinds the package ships and owns; a profile names them directly. */
export const BUILTIN_KINDS = ['p2p', 'onebot'] as const

/** Longest kind an adapter may declare. */
export const ADAPTER_KIND_MAX = 32

/** A third-party transport keeps to its own namespace, so it cannot pose as a built-in. */
export const THIRD_PARTY_KIND = /^x-[a-z0-9-]+$/

/** The service one context's registry lives under; a second copy of this package sees another. */
export const REGISTRY_SERVICE = 'dsbot-channel.registry'

const ORDER = `mount the adapter plugin between "dsbot-channel/registry" and "dsbot-channel"`

/** Refuses a kind a profile declared that cannot identify a transport. */
export function checkAdapterKind(kind: string): void {
  if ((BUILTIN_KINDS as readonly string[]).includes(kind)) return
  if (kind.length > ADAPTER_KIND_MAX || !THIRD_PARTY_KIND.test(kind)) {
    throw new ConfigError(
      `adapter kind "${kind}" must be a built-in name or match x-[a-z0-9-]+ within ${ADAPTER_KIND_MAX} characters`,
      ['adapters', 'kind'],
    )
  }
}

/** One context's transports: a third-party plugin and the gateway share this instance, no module state. */
export class AdapterRegistry {
  readonly #factories = new Map<string, AdapterFactory>()

  /** Lets a third-party transport offer itself; its kind must stay in the `x-` namespace. One call per kind. */
  register(kind: string, factory: AdapterFactory): void {
    if ((BUILTIN_KINDS as readonly string[]).includes(kind)) {
      throw new ConfigError(
        `adapter kind "${kind}" is reserved for the built-in transport; a third-party kind starts with "x-"`,
        ['adapters', 'kind'],
      )
    }
    if (kind.length > ADAPTER_KIND_MAX || !THIRD_PARTY_KIND.test(kind)) {
      throw new ConfigError(
        `a third-party adapter kind must match x-[a-z0-9-]+ and be at most ${ADAPTER_KIND_MAX} characters: "${kind}"`,
        ['adapters', 'kind'],
      )
    }
    this.add(kind, factory)
  }

  /** Registers a kind the package ships; only the gateway calls it, with its own copies. */
  builtin(kind: string, factory: AdapterFactory): void {
    if (!(BUILTIN_KINDS as readonly string[]).includes(kind)) {
      throw new ConfigError(`"${kind}" is not a built-in adapter kind`, ['adapters', 'kind'])
    }
    this.add(kind, factory)
  }

  has(kind: string): boolean {
    return this.#factories.has(kind)
  }

  /** The kinds registered in this context, for a message a user can act on. */
  known(): string[] {
    return [...this.#factories.keys()]
  }

  /** The factory for a declared kind, or a refusal naming what is available and where the plugin goes. */
  factory(kind: string): AdapterFactory {
    const factory = this.#factories.get(kind)
    if (factory !== undefined) return factory
    const known = this.known()
    throw new ConfigError(
      `no adapter serves kind "${kind}"${known.length === 0 ? '' : `; known: ${known.join(', ')}`}; ${ORDER}`,
      ['adapters', 'kind'],
    )
  }

  private add(kind: string, factory: AdapterFactory): void {
    if (this.#factories.has(kind)) {
      throw new ConfigError(`adapter kind "${kind}" is already registered`, ['adapters', 'kind'])
    }
    this.#factories.set(kind, factory)
  }
}

export interface AdapterPluginOptions {
  kind: string
  create: AdapterFactory
}

/** The only supported way for a third-party package to offer a transport. */
export function defineAdapterPlugin(options: AdapterPluginOptions): {
  name: string
  inject: readonly string[]
  apply(ctx: Context): void
} {
  return {
    name: `dsbot-channel/adapter/${options.kind}`,
    inject: [REGISTRY_SERVICE],
    apply(ctx: Context): void {
      const registry = ctx.get(REGISTRY_SERVICE) as AdapterRegistry | undefined
      if (registry === undefined) {
        throw new ConfigError(
          `adapter "${options.kind}" found no registry: mount "dsbot-channel/registry" before this plugin`,
          ['adapters', 'kind'],
        )
      }
      registry.register(options.kind, options.create)
    },
  }
}
