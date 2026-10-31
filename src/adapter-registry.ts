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

const factories = new Map<string, AdapterFactory>()

/** Lets a transport offer itself by kind; the composition root does the registering. */
export function registerAdapter(kind: string, factory: AdapterFactory): void {
  factories.set(kind, factory)
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
