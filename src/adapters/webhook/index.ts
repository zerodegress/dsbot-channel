import type { AdapterFactory, AdapterMount } from '../../adapter-registry.js'
import { ConfigError, assertBindHost } from '../../config.js'
import { DEFAULT_WEBHOOK_HOST, DEFAULT_WEBHOOK_PATH, DEFAULT_WEBHOOK_PORT, WebhookAdapter } from './adapter.js'
import type { WebhookConfig } from './adapter.js'
import { WEBHOOK_DIALECTS } from './mapping.js'
import type { WebhookDialect } from './mapping.js'

const FIELDS = new Set(['listen', 'secret', 'token', 'dialect', 'api', 'login', 'bots', 'repos'])

function refuse(message: string, path: (string | number)[] = ['transport']): never {
  throw new ConfigError(message, path)
}

function strings(value: unknown, field: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuse(`transport.${field} must be a list of names`, ['transport', field])
  return value.map((one, index) => {
    if (typeof one !== 'string' || one.length === 0) refuse(`transport.${field}[${index}] must be a non-empty string`, ['transport', field, index])
    return one
  })
}

/** Reads the webhook block; every field is named, so a typo fails at mount. */
export function parseWebhookConfig(mount: AdapterMount): WebhookConfig {
  const raw = mount.transport
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key))
  if (unknown.length > 0) refuse(`transport names a field this adapter does not read: ${unknown.join(', ')}`)
  const listen = (raw.listen ?? {}) as { host?: unknown; port?: unknown; path?: unknown }
  const host = typeof listen.host === 'string' && listen.host.length > 0 ? listen.host : DEFAULT_WEBHOOK_HOST
  assertBindHost(host)
  const port = typeof listen.port === 'number' && Number.isInteger(listen.port) ? listen.port : DEFAULT_WEBHOOK_PORT
  if (port < 0 || port > 65535) refuse(`transport.listen.port must be between 0 and 65535: ${port}`, ['transport', 'listen', 'port'])
  const path = typeof listen.path === 'string' && listen.path.length > 0 ? listen.path : DEFAULT_WEBHOOK_PATH
  if (!path.startsWith('/')) refuse(`transport.listen.path must start with "/": ${path}`, ['transport', 'listen', 'path'])
  const secret = raw.secret
  if (typeof secret !== 'string' || secret.length === 0) refuse('transport.secret must be a credential reference name', ['transport', 'secret'])
  const token = raw.token
  if (typeof token !== 'string' || token.length === 0) refuse('transport.token must be a credential reference name', ['transport', 'token'])
  const dialect = (raw.dialect ?? 'auto') as WebhookDialect
  if (!(WEBHOOK_DIALECTS as readonly string[]).includes(dialect)) {
    refuse(`transport.dialect must be one of ${WEBHOOK_DIALECTS.join(', ')}: ${String(dialect)}`, ['transport', 'dialect'])
  }
  const api = raw.api === undefined ? 'https://api.github.com' : raw.api
  if (typeof api !== 'string' || !/^https?:\/\//.test(api)) {
    refuse(`transport.api must be an absolute http(s) url: ${String(api)}`, ['transport', 'api'])
  }
  const login = raw.login
  if (typeof login !== 'string' || login.length === 0) refuse('transport.login names the bot and is required', ['transport', 'login'])
  return {
    channel: mount.channel,
    botName: mount.botName,
    status: mount.status !== false,
    listen: { host, port, path },
    secret,
    token,
    dialect,
    api: api.replace(/\/+$/, ''),
    login,
    bots: strings(raw.bots, 'bots'),
    repos: strings(raw.repos, 'repos'),
  }
}

export const createWebhookAdapter: AdapterFactory = (mount, options) => new WebhookAdapter(parseWebhookConfig(mount), options)
export { WebhookAdapter }
export { mapWebhook, classOf, mentionsOf, semanticClass } from './mapping.js'
export type { WebhookConfig }
