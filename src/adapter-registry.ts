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

/**
 * A kind names one transport implementation: the registry holds one factory per kind, while any
 * number of adapter instances may mount it. A profile names a kind, not a factory.
 */

/** Kinds the package ships and owns; a profile names them directly. */
export const BUILTIN_KINDS = ['p2p', 'onebot'] as const

/** Longest kind an adapter may declare. */
export const ADAPTER_KIND_MAX = 32

/** A third-party transport keeps to its own namespace, so it cannot pose as a built-in. */
export const THIRD_PARTY_KIND = /^x-[a-z0-9-]+$/

const factories = new Map<string, AdapterFactory>()

function add(kind: string, factory: AdapterFactory): void {
  if (factories.has(kind)) {
    throw new ConfigError(`adapter kind "${kind}" is already registered`, ['adapters', 'kind'])
  }
  factories.set(kind, factory)
}

/** Lets a third-party transport offer itself; its kind must stay in the `x-` namespace. One call per kind. */
export function registerAdapter(kind: string, factory: AdapterFactory): void {
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
  add(kind, factory)
}

/** Registers a kind the package ships; only the composition root calls it. */
export function registerBuiltinAdapter(kind: string, factory: AdapterFactory): void {
  if (!(BUILTIN_KINDS as readonly string[]).includes(kind)) {
    throw new ConfigError(`"${kind}" is not a built-in adapter kind`, ['adapters', 'kind'])
  }
  add(kind, factory)
}

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

/** The factory for a declared kind, or a refusal naming what is available. */
export function adapterFactory(kind: string): AdapterFactory {
  const factory = factories.get(kind)
  if (factory !== undefined) return factory
  const known = [...factories.keys()]
  throw new ConfigError(
    `no adapter serves kind "${kind}"${known.length === 0 ? '' : `; known: ${known.join(', ')}`}`,
    ['adapters', 'kind'],
  )
}

/** The kinds the composition root registered, for a message a user can act on. */
export function knownAdapterKinds(): string[] {
  return [...factories.keys()]
}
