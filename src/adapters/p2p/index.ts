import type { AdapterFactory, AdapterMount } from '../../adapter-registry.js'
import { registerBuiltinAdapter } from '../../adapter-registry.js'
import { ConfigError } from '../../config.js'
import { P2PAdapter } from './adapter.js'
import type { P2PAdapterConfig, P2PPeerConfig } from './adapter.js'

const FIELDS = new Set([
  'peers',
  'listen',
  'dedupe',
  'inflightTtlMs',
  'sentAtWindowMs',
  'maxBodyBytes',
  'waitMs',
])

function refuse(message: string, field?: string): never {
  throw new ConfigError(message, field === undefined ? ['adapters', 'p2p'] : ['adapters', 'p2p', field])
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse(`p2p.${field} must be an object`, field)
  return value as Record<string, unknown>
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse(`p2p.${field} must be a non-empty string`, field)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) refuse(`p2p.${field} must be a non-empty string`, field)
  return value
}

function optionalPort(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    refuse(`p2p.${field} must be a whole port number of at least 0`, field)
  }
  return value
}

function optionalWhole(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    refuse(`p2p.${field} must be a whole number of at least 1`, field)
  }
  return value
}

function parsePeers(value: unknown): P2PPeerConfig[] {
  if (!Array.isArray(value) || value.length === 0) refuse('p2p.peers must list at least one peer', 'peers')
  return value.map((entry, index) => {
    const peer = record(entry, `peers[${index}]`)
    return {
      instance: requiredText(peer.instance, `peers[${index}].instance`),
      secret: requiredText(peer.secret, `peers[${index}].secret`),
      ...(optionalText(peer.url, `peers[${index}].url`) === undefined ? {} : { url: peer.url as string }),
      ...(optionalText(peer.host, `peers[${index}].host`) === undefined ? {} : { host: peer.host as string }),
      ...(optionalText(peer.botName, `peers[${index}].botName`) === undefined
        ? {}
        : { botName: peer.botName as string }),
    }
  })
}

function parseListen(value: unknown): { host?: string; port?: number } | undefined {
  if (value === undefined) return undefined
  const listen = record(value, 'listen')
  return {
    ...(optionalText(listen.host, 'listen.host') === undefined ? {} : { host: listen.host as string }),
    ...(optionalPort(listen.port, 'listen.port') === undefined ? {} : { port: listen.port as number }),
  }
}

function parseDedupe(value: unknown): { ttlMs?: number; limit?: number } | undefined {
  if (value === undefined) return undefined
  const dedupe = record(value, 'dedupe')
  return {
    ...(optionalPort(dedupe.ttlMs, 'dedupe.ttlMs') === undefined ? {} : { ttlMs: dedupe.ttlMs as number }),
    ...(optionalWhole(dedupe.limit, 'dedupe.limit') === undefined ? {} : { limit: dedupe.limit as number }),
  }
}

/** Reads the transport block a profile declared, refusing a field this adapter never reads. */
export function parseP2PConfig(mount: AdapterMount): P2PAdapterConfig {
  const raw = mount.transport
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key))
  if (unknown.length > 0) refuse(`p2p names a field this adapter does not read: ${unknown.join(', ')}`)
  return {
    channel: mount.channel,
    instance: mount.instance,
    botName: mount.botName,
    ...(mount.status === undefined ? {} : { status: mount.status }),
    peers: parsePeers(raw.peers),
    ...(parseListen(raw.listen) === undefined ? {} : { listen: parseListen(raw.listen) }),
    ...(parseDedupe(raw.dedupe) === undefined ? {} : { dedupe: parseDedupe(raw.dedupe) }),
    ...(optionalWhole(raw.inflightTtlMs, 'inflightTtlMs') === undefined ? {} : { inflightTtlMs: raw.inflightTtlMs as number }),
    ...(optionalWhole(raw.sentAtWindowMs, 'sentAtWindowMs') === undefined ? {} : { sentAtWindowMs: raw.sentAtWindowMs as number }),
    ...(optionalWhole(raw.maxBodyBytes, 'maxBodyBytes') === undefined ? {} : { maxBodyBytes: raw.maxBodyBytes as number }),
    ...(optionalWhole(raw.waitMs, 'waitMs') === undefined ? {} : { waitMs: raw.waitMs as number }),
  }
}

export const createP2PAdapter: AdapterFactory = (mount, options) => new P2PAdapter(parseP2PConfig(mount), options)

registerBuiltinAdapter('p2p', createP2PAdapter)
