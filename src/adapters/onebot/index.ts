import type { AdapterFactory, AdapterMount } from '../../adapter-registry.js'
import { ConfigError, assertBindHost } from '../../config.js'
import { OneBotAdapter } from './adapter.js'
import type { OneBotAdapterConfig } from './adapter.js'

const FIELDS = new Set([
  'selfId',
  'protocol',
  'listen',
  'api',
  'event',
  'reconnect',
  'heartbeat',
  'accessToken',
  'sendTimeoutMs',
  'bots',
  'history',
  'fileFromUrl',
])

/** How this link carries OneBot: one protocol per adapter, never two at once. */
export const ONEBOT_PROTOCOLS = ['http', 'ws-forward', 'ws-reverse'] as const
export type OneBotProtocol = (typeof ONEBOT_PROTOCOLS)[number]

export const DEFAULT_ONEBOT_WS_PATH = '/onebot/ws'

export interface OneBotReconnectConfig {
  initialMs: number
  maxMs: number
  factor: number
}

export interface OneBotHeartbeatConfig {
  intervalMs: number
  timeoutMs: number
}

/** The two address kinds history may be opened for, each off unless the profile says so. */
export interface OneBotHistoryConfig {
  group: boolean
  private: boolean
}

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

function parseProtocol(value: unknown): OneBotProtocol {
  if (value === undefined) return 'http'
  if (typeof value !== 'string' || !(ONEBOT_PROTOCOLS as readonly string[]).includes(value)) {
    refuse(`transport.protocol must be one of ${ONEBOT_PROTOCOLS.join(', ')}`, 'protocol')
  }
  return value as OneBotProtocol
}

function parseListen(
  value: unknown,
  defaultPath: string,
): { host: string; port: number; path: string } {
  const raw = value === undefined ? {} : record(value, 'listen')
  const host = optionalText(raw.host, 'listen.host') ?? '127.0.0.1'
  assertBindHost(host, ['adapters', 'transport', 'listen', 'host'])
  const port = whole(raw.port, 'listen.port', 0) ?? DEFAULT_ONEBOT_PORT
  const path = optionalText(raw.path, 'listen.path') ?? defaultPath
  if (!path.startsWith('/')) refuse('transport.listen.path must start with "/"', 'listen.path')
  return { host, port, path }
}

function parseSocketUrl(value: unknown, field: string): string {
  const url = requiredText(value, field)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    refuse(`transport.${field} must be an absolute ws(s) url`, field)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    refuse(`transport.${field} must be an absolute ws(s) url`, field)
  }
  return url
}

function parseReconnect(value: unknown): OneBotReconnectConfig | false {
  if (value === false) return false
  const raw = value === undefined ? {} : record(value, 'reconnect')
  const initialMs = whole(raw.initialMs, 'reconnect.initialMs', 1) ?? 500
  const maxMs = whole(raw.maxMs, 'reconnect.maxMs', 1) ?? 30_000
  const factor = raw.factor
  if (factor !== undefined && (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 1)) {
    refuse('transport.reconnect.factor must be a number of at least 1', 'reconnect.factor')
  }
  if (initialMs > maxMs) refuse('transport.reconnect.initialMs must not exceed maxMs', 'reconnect.initialMs')
  return { initialMs, maxMs, factor: (factor as number | undefined) ?? 2 }
}

function parseHeartbeat(value: unknown): OneBotHeartbeatConfig | undefined {
  if (value === undefined) return undefined
  const raw = record(value, 'heartbeat')
  const intervalMs = whole(raw.intervalMs, 'heartbeat.intervalMs', 0) ?? 0
  const timeoutMs = whole(raw.timeoutMs, 'heartbeat.timeoutMs', 1) ?? 0
  if (intervalMs > 0 && timeoutMs === 0) {
    refuse('transport.heartbeat.timeoutMs is required when intervalMs is above 0', 'heartbeat.timeoutMs')
  }
  if (intervalMs > 0 && timeoutMs <= intervalMs) {
    refuse('transport.heartbeat.timeoutMs must be above intervalMs', 'heartbeat.timeoutMs')
  }
  return { intervalMs, timeoutMs }
}

function parseApi(value: unknown, timeoutMs: number, socket: boolean): { url: string; timeoutMs: number } {
  if (value === undefined) refuse('transport.api is required', 'api')
  const raw = record(value, 'api')
  const url = requiredText(raw.url, 'api.url')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    refuse(`transport.api.url must be an absolute ${socket ? 'ws(s)' : 'http(s)'} url`, 'api.url')
  }
  const allowed = socket ? ['ws:', 'wss:'] : ['http:', 'https:']
  if (!allowed.includes(parsed.protocol)) {
    refuse(`transport.api.url must be an absolute ${socket ? 'ws(s)' : 'http(s)'} url`, 'api.url')
  }
  return { url: url.replace(/\/$/, ''), timeoutMs }
}

function parseHistory(value: unknown): OneBotHistoryConfig {
  const raw = value === undefined ? {} : record(value, 'history')
  const unknown = Object.keys(raw).filter((key) => key !== 'group' && key !== 'private')
  if (unknown.length > 0) refuse(`transport.history names a field this adapter does not read: ${unknown.join(', ')}`, 'history')
  const flag = (field: 'group' | 'private'): boolean => {
    const one = raw[field]
    if (one === undefined) return false
    if (typeof one !== 'boolean') refuse(`transport.history.${field} must be true or false`, `history.${field}`)
    return one
  }
  return { group: flag('group'), private: flag('private') }
}

function parseFileFromUrl(value: unknown): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') refuse('transport.fileFromUrl must be true or false', 'fileFromUrl')
  return value
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
  const protocol = parseProtocol(raw.protocol)
  const sendTimeoutMs = whole(raw.sendTimeoutMs, 'sendTimeoutMs', 1) ?? DEFAULT_ONEBOT_SEND_TIMEOUT_MS
  const only = (field: string, why: string): void => {
    if (raw[field] !== undefined) refuse(why, field)
  }

  let api: { url: string; timeoutMs: number } | undefined
  let event: { url: string } | undefined
  let reconnect: OneBotReconnectConfig | false | undefined
  let heartbeat: OneBotHeartbeatConfig | undefined
  let listen: { host: string; port: number; path: string } | undefined
  if (protocol === 'http') {
    only('event', 'transport.event is only read by ws-forward')
    only('reconnect', 'transport.reconnect is only read by ws-forward')
    only('heartbeat', 'transport.heartbeat is only read by a websocket protocol')
    api = parseApi(raw.api, sendTimeoutMs, false)
    listen = parseListen(raw.listen, DEFAULT_ONEBOT_PATH)
  } else if (protocol === 'ws-forward') {
    only('listen', 'transport.listen is not read by ws-forward, which connects out')
    api = parseApi(raw.api, sendTimeoutMs, true)
    event = raw.event === undefined ? undefined : { url: parseSocketUrl(raw.event, 'event.url') }
    reconnect = parseReconnect(raw.reconnect)
    heartbeat = parseHeartbeat(raw.heartbeat)
  } else {
    only('api', 'transport.api is not read by ws-reverse, which answers on a socket')
    only('event', 'transport.event is only read by ws-forward')
    only('reconnect', 'transport.reconnect is only read by ws-forward')
    heartbeat = parseHeartbeat(raw.heartbeat)
    listen = parseListen(raw.listen, DEFAULT_ONEBOT_WS_PATH)
  }

  return {
    channel: mount.channel,
    instance: mount.channel,
    botName: mount.botName,
    ...(mount.status === undefined ? {} : { status: mount.status }),
    ...(optionalText(raw.selfId, 'selfId') === undefined ? {} : { selfId: raw.selfId as string }),
    protocol,
    ...(listen === undefined ? {} : { listen }),
    ...(api === undefined ? {} : { api }),
    ...(event === undefined ? {} : { event }),
    ...(reconnect === undefined ? {} : { reconnect }),
    ...(heartbeat === undefined ? {} : { heartbeat }),
    sendTimeoutMs,
    history: parseHistory(raw.history),
    fileFromUrl: parseFileFromUrl(raw.fileFromUrl),
    ...(optionalText(raw.accessToken, 'accessToken') === undefined ? {} : { accessToken: raw.accessToken as string }),
    bots: parseBots(raw.bots),
  }
}

export const createOneBotAdapter: AdapterFactory = (mount, options) => new OneBotAdapter(parseOneBotConfig(mount), options)

