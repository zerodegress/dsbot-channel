import { ImapFlow } from 'imapflow'
import nodemailer from 'nodemailer'
import type { Transporter } from 'nodemailer'

export interface ImapSettings {
  host: string
  port: number
  secure: boolean
  user: string
  password: string
  mailbox: string
}

export interface SmtpSettings {
  host: string
  port: number
  secure: boolean | 'starttls'
  user?: string | undefined
  password?: string | undefined
}

export interface Cursor {
  uidValidity: number
  uid: number
}

export interface FetchedMail {
  uid: number
  raw: Buffer
}

/** The wire layers behind one interface, so a test can stand in for both protocols. */
export interface MailTransport {
  fetch(mailbox: string, cursor: Cursor | undefined): Promise<{ uidValidity: number; maxUid: number; messages: FetchedMail[] }>
  markSeen(mailbox: string, uids: readonly number[]): Promise<void>
  append(mailbox: string, raw: Buffer): Promise<void>
  send(envelope: { from: string; to: readonly string[] }, raw: Buffer): Promise<void>
  close(): Promise<void>
}

/** Reads with imapflow and writes with nodemailer; the MIME layer stays core's own. */
export class ImapSmtpTransport implements MailTransport {
  readonly #imap: ImapFlow
  readonly #smtp: Transporter

  constructor(imap: ImapSettings, smtp: SmtpSettings) {
    this.#imap = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.secure,
      auth: { user: imap.user, pass: imap.password },
      logger: false,
    })
    this.#smtp = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure === true,
      ...(smtp.secure === 'starttls' ? { requireTLS: true } : {}),
      ...(smtp.user === undefined ? {} : { auth: { user: smtp.user, pass: smtp.password } }),
    })
  }

  async fetch(mailbox: string, cursor: Cursor | undefined): Promise<{ uidValidity: number; maxUid: number; messages: FetchedMail[] }> {
    const lock = await this.#imap.getMailboxLock(mailbox)
    try {
      const opened = this.#imap.mailbox
      const uidValidity = Number(opened === false ? 0 : opened.uidValidity)
      const maxUid = opened === false ? 0 : Math.max(0, Number(opened.uidNext) - 1)
      if (cursor === undefined) return { uidValidity, maxUid, messages: [] }
      const start = cursor.uidValidity === uidValidity && cursor.uid > 0 ? cursor.uid + 1 : maxUid + 1
      const messages: FetchedMail[] = []
      for await (const message of this.#imap.fetch(`${start}:*`, { uid: true, source: true })) {
        const source = message.source
        if (source === undefined) continue
        messages.push({ uid: Number(message.uid), raw: Buffer.from(source) })
      }
      messages.sort((left, right) => left.uid - right.uid)
      return { uidValidity, maxUid, messages }
    } finally {
      lock.release()
    }
  }

  async markSeen(mailbox: string, uids: readonly number[]): Promise<void> {
    if (uids.length === 0) return
    const lock = await this.#imap.getMailboxLock(mailbox)
    try {
      await this.#imap.messageFlagsAdd([...uids], ['\\Seen'], { uid: true })
    } finally {
      lock.release()
    }
  }

  async append(mailbox: string, raw: Buffer): Promise<void> {
    await this.#imap.append(mailbox, raw, ['\\Seen'])
  }

  async send(envelope: { from: string; to: readonly string[] }, raw: Buffer): Promise<void> {
    await this.#smtp.sendMail({ envelope: { from: envelope.from, to: [...envelope.to] }, raw })
  }

  async close(): Promise<void> {
    this.#smtp.close()
    await this.#imap.logout().catch(() => undefined)
  }
}
