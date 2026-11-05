import { NO_MEDIA, buildListenerHealth, buildStatus } from '../../adapter-status.js'
import { ConfigError } from '../../config.js'
import type { AdapterStatus, CapabilitySet } from '../../adapter-status.js'
import { ChannelStats, countersOf } from '../../channel-stats.js'
import type { AdapterHandle, AdapterPorts, ChannelAdapter, SendInput, SendResult } from '../../contract.js'
import { parseMail } from './mime.js'
import type { ParsedMail } from './mime.js'
import { mapMail, newMessageId, replyHeadersOf } from './mapping.js'
import { ImapSmtpTransport } from './transport.js'
import type { Cursor, MailTransport } from './transport.js'

export interface MailConfig {
  channel: string
  botName: string
  from: string
  imap: {
    host: string
    port: number
    secure: boolean
    user: string
    password: string
    mailbox: string
    pollMs: number
  }
  smtp: {
    host: string
    port: number
    secure: boolean | 'starttls'
    user: string
    password: string
  }
  signature?: string | undefined
  listUnsubscribe?: string | undefined
  bots: readonly string[]
  lists: readonly string[]
  maxAttachmentBytes?: number | undefined
}

export interface MailOptions {
  warn?: ((message: string) => void) | undefined
  now?: (() => number) | undefined
  transport?: MailTransport | undefined
}

interface Origin {
  subject: string
  messageId: string
  references: string
}

const ORIGINS_MAX = 200

const CAPABILITIES: CapabilitySet = {
  text: true,
  image: NO_MEDIA,
  file: NO_MEDIA,
  voice: NO_MEDIA,
  recall: false,
  history: { group: false, private: false },
  mention: false,
  reply: false,
  stream: false,
  outbound: true,
}

/** A reply is plain text with the headers that hold the thread together. */
export function composeReply(input: {
  from: string
  to: string
  subject: string
  messageId: string
  origin?: Origin | undefined
  text: string
  signature?: string | undefined
  listUnsubscribe?: string | undefined
  date: Date
}): string {
  const headers = [
    `From: ${input.from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Date: ${input.date.toUTCString()}`,
    `Message-ID: ${input.messageId}`,
    ...(input.origin === undefined ? [] : [`In-Reply-To: <${input.origin.messageId}>`, `References: ${input.origin.references}`]),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    ...(input.listUnsubscribe === undefined ? [] : [`List-Unsubscribe: <${input.listUnsubscribe}>`]),
  ]
  const body = input.signature === undefined ? input.text : `${input.text}\n\n-- \n${input.signature}`
  return `${headers.join('\r\n')}\r\n\r\n${body.replace(/\r?\n/g, '\r\n')}\r\n`
}

export class MailAdapter implements ChannelAdapter {
  readonly kind = 'mail'
  readonly capabilities = CAPABILITIES
  readonly guidance = {
    peer: 'Mail is a letter: answer in plain text, keep it short, and never quote a whole thread.',
    group: 'A mailing list is a room: answer in plain text to the list, and do not answer your own mail.',
  }

  readonly #config: MailConfig
  readonly #warn: (message: string) => void
  readonly #now: () => number
  readonly #stats = new ChannelStats()
  readonly #origins = new Map<string, Origin>()
  #transport: MailTransport | undefined
  #cursor: Cursor | undefined
  #timer: ReturnType<typeof setInterval> | undefined
  #polling = false
  #stopped = false
  #lastPollAt: number | null = null

  constructor(config: MailConfig, options: MailOptions = {}) {
    this.#config = config
    this.#warn = options.warn ?? (() => undefined)
    this.#now = options.now ?? Date.now
    this.#transport = options.transport
  }

  checkConfig(): void {
    if (this.#config.from.length === 0) this.#fail('transport.from is required', ['transport', 'from'])
    if (this.#config.imap.pollMs < 1000) this.#fail('transport.imap.pollMs must be at least 1000', ['transport', 'imap', 'pollMs'])
  }

  checkSessionKey(key: string): string | undefined {
    if (!key.startsWith('mail:') || key.length <= 'mail:'.length) return 'a mail session key reads "mail:<thread-root>"'
    return undefined
  }

  checkTarget(target: string): string | undefined {
    return /^[^@\s]+@[^@\s]+$/.test(target) ? undefined : 'a mail reply target is one address'
  }

  describeTargets(): string {
    return 'mail:<address>'
  }

  status(): AdapterStatus {
    const snapshot = this.#stats.snapshot()
    const counters = countersOf(snapshot)
    return buildStatus({
      channel: this.#config.channel,
      account: this.#config.imap.user,
      bot: this.#config.botName,
      health: buildListenerHealth({
        listenState: this.#stopped ? 'stopped' : this.#lastPollAt === null ? 'stopped' : 'listening',
        boundPort: null,
        lastAuthenticatedAt: snapshot.lastAuthenticatedAt,
        queueDepth: 0,
      }),
      counters,
      capabilities: this.capabilities,
      attributes: { stableMessageId: true },
      quota: { softLimit: 0, hardLimit: 0 },
      sampledAt: this.#now(),
      queueDepth: 0,
    })
  }

  async start(ports: AdapterPorts): Promise<AdapterHandle> {
    const imapPassword = await ports.resolveSecret(this.#config.imap.password)
    if (imapPassword === undefined) this.#fail(`credential "${this.#config.imap.password}" did not resolve`, ['transport', 'imap', 'password'])
    const smtpPassword = await ports.resolveSecret(this.#config.smtp.password)
    if (smtpPassword === undefined) this.#fail(`credential "${this.#config.smtp.password}" did not resolve`, ['transport', 'smtp', 'password'])
    if (this.#transport === undefined) {
      this.#transport = new ImapSmtpTransport(
        { ...this.#config.imap, password: imapPassword },
        { ...this.#config.smtp, password: smtpPassword },
      )
    }
    this.#timer = setInterval(() => {
      void this.#poll(ports)
    }, this.#config.imap.pollMs)
    this.#timer.unref?.()
    void this.#poll(ports)
    return {
      stop: async () => {
        this.#stopped = true
        if (this.#timer !== undefined) clearInterval(this.#timer)
        this.#timer = undefined
        await this.#transport?.close()
        this.#stats.closed()
      },
    }
  }

  async send(input: SendInput): Promise<SendResult> {
    const transport = this.#transport
    if (transport === undefined) return { ok: false, code: 'no_url', reason: 'the mail link is not running', retryable: false }
    if (!/^[^@\s]+@[^@\s]+$/.test(input.target)) {
      return { ok: false, code: 'no_url', reason: `"${input.target}" is not a mail address`, retryable: false }
    }
    const origin = this.#origins.get(input.eventId)
    const subject = origin === undefined ? `Re: ${input.body.split('\n')[0]?.slice(0, 60) ?? ''}` : `${origin.subject}`
    const data = composeReply({
      from: this.#config.from,
      to: input.target,
      subject,
      messageId: newMessageId(this.#config.from),
      origin,
      text: input.body,
      signature: this.#config.signature,
      listUnsubscribe: this.#config.listUnsubscribe,
      date: new Date(this.#now()),
    })
    try {
      await transport.send({ from: this.#config.from, to: [input.target] }, Buffer.from(data))
      return { ok: true, messageId: `mail:${this.#now()}`, duplicate: false }
    } catch (error) {
      this.#stats.sendFailed('unreachable')
      return { ok: false, code: 'unreachable', reason: String(error), retryable: true }
    }
  }

  async #poll(ports: AdapterPorts): Promise<void> {
    if (this.#polling || this.#stopped || this.#transport === undefined) return
    this.#polling = true
    try {
      const mailbox = this.#config.imap.mailbox
      const batch = await this.#transport.fetch(mailbox, this.#cursor)
      this.#lastPollAt = this.#now()
      this.#stats.authenticated()
      for (const item of batch.messages) {
        if (this.#stopped) break
        const mail = parseMail(item.raw.toString('utf8'), this.#config.maxAttachmentBytes)
        const message = mapMail({
          mail,
          config: { channel: this.#config.channel, from: this.#config.from, bots: this.#config.bots, lists: this.#config.lists },
          receivedAt: this.#now(),
        })
        this.#remember(message.requestId, mail)
        this.#stats.event(`mail.${message.source.scope}`)
        const verdict = await ports.onMessage(message)
        if (!verdict.ok && verdict.code === 'busy') {
          this.#warn(`dsbot-channel: mail ${message.requestId} was not taken while busy; it stays for the next poll`)
          break
        }
        if (verdict.ok) {
          await this.#transport.markSeen(mailbox, [item.uid]).catch((error: unknown) => {
            this.#warn(`dsbot-channel: mail ${message.requestId} was taken but could not be marked seen: ${String(error)}`)
          })
        }
        this.#cursor = { uidValidity: batch.uidValidity, uid: item.uid }
      }
      this.#cursor = { uidValidity: batch.uidValidity, uid: this.#cursor?.uid ?? 0 }
    } catch (error) {
      this.#stats.rejected(`poll failed: ${String(error)}`)
      this.#warn(`dsbot-channel: mail poll failed: ${String(error)}`)
    } finally {
      this.#polling = false
    }
  }

  #remember(requestId: string, mail: ParsedMail): void {
    const headers = replyHeadersOf(mail)
    this.#origins.set(requestId, {
      subject: headers.subject,
      messageId: headers.inReplyTo ?? '',
      references: headers.references ?? '',
    })
    while (this.#origins.size > ORIGINS_MAX) {
      const oldest = this.#origins.keys().next()
      if (oldest.done === true) break
      this.#origins.delete(oldest.value)
    }
  }

  #fail(message: string, path: (string | number)[]): never {
    throw new ConfigError(message, path)
  }
}
