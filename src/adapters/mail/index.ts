import type { AdapterFactory, AdapterMount } from '../../adapter-registry.js'
import { ConfigError } from '../../config.js'
import { MailAdapter } from './adapter.js'
import type { MailConfig } from './adapter.js'

const FIELDS = new Set([
  'imap',
  'smtp',
  'from',
  'signature',
  'listUnsubscribe',
  'bots',
  'lists',
  'maxAttachmentBytes',
  'attachDir',
])

function refuse(message: string, path: (string | number)[] = ['transport']): never {
  throw new ConfigError(message, path)
}

function block(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse(`transport.${name} must be a mapping`, ['transport', name])
  }
  return value as Record<string, unknown>
}

function host(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse(`transport.${name}.host is required`, ['transport', name, 'host'])
  return value
}

function port(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65535) {
    refuse(`transport.${name}.port must be a whole number between 1 and 65535`, ['transport', name, 'port'])
  }
  return value
}

function user(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) refuse(`transport.${name}.user is required`, ['transport', name, 'user'])
  return value
}

function strings(value: unknown, name: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) refuse(`transport.${name} must be a list of names`, ['transport', name])
  return value.map((one, index) => {
    if (typeof one !== 'string' || one.length === 0) refuse(`transport.${name}[${index}] must be a non-empty string`, ['transport', name, index])
    return one
  })
}

/** Reads the mail block; every named field is checked, so a typo fails at mount. */
export function parseMailConfig(mount: AdapterMount): MailConfig {
  const raw = mount.transport
  const unknown = Object.keys(raw).filter((key) => !FIELDS.has(key))
  if (unknown.length > 0) refuse(`transport names a field this adapter does not read: ${unknown.join(', ')}`)
  const imap = block(raw.imap, 'imap')
  const smtp = block(raw.smtp, 'smtp')
  const from = raw.from
  if (typeof from !== 'string' || !/^[^@\s]+@[^@\s]+$/.test(from)) {
    refuse(`transport.from must be one mail address: ${String(from)}`, ['transport', 'from'])
  }
  const smtpSecure = smtp.secure
  if (smtpSecure !== undefined && typeof smtpSecure !== 'boolean' && smtpSecure !== 'starttls') {
    refuse('transport.smtp.secure must be true, false or "starttls"', ['transport', 'smtp', 'secure'])
  }
  const pollMs = imap.pollMs
  if (pollMs !== undefined && (typeof pollMs !== 'number' || !Number.isInteger(pollMs) || pollMs < 1000)) {
    refuse(`transport.imap.pollMs must be a whole number of milliseconds, at least 1000: ${String(pollMs)}`, ['transport', 'imap', 'pollMs'])
  }
  const maxAttachmentBytes = raw.maxAttachmentBytes
  if (maxAttachmentBytes !== undefined && (typeof maxAttachmentBytes !== 'number' || maxAttachmentBytes < 0)) {
    refuse('transport.maxAttachmentBytes must be a positive number', ['transport', 'maxAttachmentBytes'])
  }
  return {
    channel: mount.channel,
    botName: mount.botName,
    from,
    imap: {
      host: host(imap.host, 'imap'),
      port: port(imap.port, 'imap'),
      secure: imap.secure !== false,
      user: user(imap.user, 'imap'),
      password: user(imap.password, 'imap'),
      mailbox: typeof imap.mailbox === 'string' && imap.mailbox.length > 0 ? imap.mailbox : 'INBOX',
      pollMs: typeof pollMs === 'number' ? pollMs : 30_000,
    },
    smtp: {
      host: host(smtp.host, 'smtp'),
      port: port(smtp.port, 'smtp'),
      secure: smtpSecure === undefined ? true : smtpSecure,
      user: user(smtp.user, 'smtp'),
      password: user(smtp.password, 'smtp'),
    },
    ...(typeof raw.signature === 'string' ? { signature: raw.signature } : {}),
    ...(typeof raw.listUnsubscribe === 'string' ? { listUnsubscribe: raw.listUnsubscribe } : {}),
    bots: strings(raw.bots, 'bots'),
    lists: strings(raw.lists, 'lists'),
    ...(typeof maxAttachmentBytes === 'number' ? { maxAttachmentBytes } : {}),
    ...(typeof raw.attachDir === 'string' ? { attachDir: raw.attachDir } : {}),
  }
}

export const createMailAdapter: AdapterFactory = (mount, options) => new MailAdapter(parseMailConfig(mount), options)
export { MailAdapter }
export type { MailConfig }
