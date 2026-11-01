import type { AdapterFactory, AdapterMount } from '../../adapter-registry.js'
import { registerBuiltinAdapter } from '../../adapter-registry.js'
import { ConfigError, assertBindHost } from '../../config.js'
import { OneBotAdapter } from './adapter.js'
import type { OneBotAdapterConfig } from './adapter.js'

const FIELDS = new Set(['selfId', 'listen', 'api', 'accessToken', 'sendTimeoutMs', 'bots'])

/** Longest token the transport may carry for its OneBot callback. */
export const DEFAULT_ONEBOT_SEND_TIMEOUT_MS = 10_000

export const DEFAULT_ONEBOT_PORT = 7331

export const DEFAULT_ONEBOT_PATH = '/onebot/event'

function refuse(message: string, field?: string): never {
  throw new ConfigError(message, field === undefined ? ['adapters', 'transport'] : ['adapters', 'transport', field])
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`transport.${field} must be an object`, field)
  }
  return value as Record<string, unknown>
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse(`transport.${field} must be a non-empty string`, field)
  return value
}

function optionalText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) refuse(`transport.${field} must be a non-empty string`, field)
  return value
}

function whole(value: unknown, field: string, atLeast: number): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < atLeast) {
    refuse(`transport.${field} must be a whole number of at least ${atLeast}`, field)
  }
  return value
}

function parseListen(value: unknown): { host: string; port: number; path: string } {
  const raw = value === undefined ? {} : record(value, 'listen')
  const host = optionalText(raw.host, 'listen.host') ?? '127.0.0.1'
  assertBindHost(host, ['adapters', 'transport', 'listen', 'host'])
  const port = whole(raw.port, 'listen.port', 0) ?? DEFAULT_ONEBOT_PORT
  const path = optionalText(raw.path, 'listen.path') ?? DEFAULT_ONEBOT_PATH
  if (!path.startsWith('/')) refuse('transport.listen.path must start with "/"', 'listen.path')
  return { host, port, path }
}

function parseApi(value: unknown, timeoutMs: number): { url: string; timeoutMs: number } {
  if (value === undefined) refuse('transport.api is required', 'api')
  const raw = record(value, 'api')
  const url = requiredText(raw.url, 'api.url')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    refuse('transport.api.url must be an absolute http(s) url', 'api.url')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    refuse('transport.api.url must be an absolute http(s) url', 'api.url')
  }
  return { url: url.replace(/\/$/, ''), timeoutMs }
}

function parseBots(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuse('transport.bots must be a list of ids', 'bots')
  return value.map((item, index) => requiredText(item, `bots[${index}]`))
}

/** Reads the transport block an OneBot adapter is mounted with. */
export function parseOneBotConfig(mount: AdapterMount): OneBotAdapterConfig {
  const raw = mount.transport
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key))
  if (unknown.length > 0) refuse(`transport names a field this adapter does not read: ${unknown.join(', ')}`)
  const sendTimeoutMs = whole(raw.sendTimeoutMs, 'sendTimeoutMs', 1) ?? DEFAULT_ONEBOT_SEND_TIMEOUT_MS
  return {
    channel: mount.channel,
    instance: mount.instance,
    botName: mount.botName,
    ...(optionalText(raw.selfId, 'selfId') === undefined ? {} : { selfId: raw.selfId as string }),
    listen: parseListen(raw.listen),
    api: parseApi(raw.api, sendTimeoutMs),
    sendTimeoutMs,
    ...(optionalText(raw.accessToken, 'accessToken') === undefined ? {} : { accessToken: raw.accessToken as string }),
    bots: parseBots(raw.bots),
  }
}

export const createOneBotAdapter: AdapterFactory = (mount, options) => new OneBotAdapter(parseOneBotConfig(mount), options)

registerBuiltinAdapter('onebot', createOneBotAdapter)
