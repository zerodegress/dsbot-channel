import { createHash, randomUUID } from 'node:crypto'
import type { InboundMessage } from '../../contract.js'
import { addressOf, cleanId } from './mime.js'
import type { MailAttachment, ParsedMail } from './mime.js'

export interface MailView {
  channel: string
  from: string
  bots: readonly string[]
  lists: readonly string[]
}

export const SESSION_MAX = 128
export const MAIL_ID_MAX = 256
export const REFERENCES_MAX = 20

function hashOf(value: string, length = 32): string {
  return createHash('sha256').update(value).digest('hex').slice(0, length)
}

/** The thread a message belongs to: the first reference, else the parent, else the message itself. */
export function threadRootOf(mail: ParsedMail): string {
  const root = cleanId(mail.references[0]) || cleanId(mail.inReplyTo) || cleanId(mail.messageId)
  return root === '' ? hashOf(`${addressOf(mail.from)}|${mail.subject}|${mail.date ?? 0}`, 16) : root
}

/** The message id core carries: no angle brackets, bounded, and stable for a redelivery. */
export function messageIdOf(mail: ParsedMail): string {
  const cleaned = cleanId(mail.messageId)
  if (cleaned === '') return hashOf(`${addressOf(mail.from)}|${mail.subject}|${mail.date ?? 0}|${mail.text.slice(0, 64)}`)
  return cleaned.length > MAIL_ID_MAX ? hashOf(cleaned) : cleaned
}

/** The address a reply goes to: the list when one is named, the sender otherwise. */
export function replyAddressOf(mail: ParsedMail, lists: readonly string[]): string {
  const listPost = mail.headers['list-post']?.[0]
  const posted = listPost === undefined ? undefined : /<mailto:([^>]+)>/i.exec(listPost)?.[1]
  if (posted !== undefined && posted.trim() !== '') return posted.trim()
  const replyTo = cleanId(mail.headers['reply-to']?.[0])
  if (replyTo !== '') return addressOf(replyTo)
  const from = addressOf(mail.from)
  const listed = lists.find((one) => one.toLowerCase() === from.toLowerCase())
  return listed ?? from
}

/** A list is a room: it names itself in the headers, or the profile lists its address. */
export function isList(mail: ParsedMail, lists: readonly string[]): boolean {
  if (mail.headers['list-post'] !== undefined || mail.headers['list-id'] !== undefined) return true
  const from = addressOf(mail.from).toLowerCase()
  return lists.some((one) => one.toLowerCase() === from)
}

function attachmentMeta(attachments: readonly MailAttachment[]): { name: string; type: string; size: number }[] {
  return attachments.map((one) => ({ name: one.name, type: one.type, size: one.size }))
}

export interface MailMappingInput {
  mail: ParsedMail
  config: MailView
  receivedAt: number
}

/** One mail on the wire becomes one inbound event. */
export function mapMail(input: MailMappingInput): InboundMessage {
  const { mail, config } = input
  const messageId = messageIdOf(mail)
  const root = threadRootOf(mail)
  const sessionBase = `mail:${root}`
  const sessionKey = sessionBase.length > SESSION_MAX ? `mail:${hashOf(root, 32)}` : sessionBase
  const list = isList(mail, config.lists)
  const target = replyAddressOf(mail, config.lists)
  const from = addressOf(mail.from)
  const isBot = config.bots.some((one) => one.toLowerCase() === from.toLowerCase())
  const references = mail.references.map((one) => cleanId(one)).filter((one) => one !== '').slice(0, REFERENCES_MAX)
  return {
    eventKey: `mail:${hashOf(messageId, 32)}`,
    kind: 'message',
    event: { postType: 'mail', type: list ? 'list' : 'direct' },
    sessionKey,
    replyTarget: target,
    requestId: messageId,
    chainId: sessionKey,
    source: {
      kind: 'mail',
      instance: config.channel,
      peer: list ? target : from,
      scope: list ? 'group' : 'c2c',
    },
    author: { senderId: from, kind: isBot ? 'bot' : 'person', personId: null },
    rawText: mail.text,
    body: { text: mail.text, media: [], replyTo: cleanId(mail.inReplyTo) || null },
    transport: {
      messageId,
      timestamp: mail.date ?? input.receivedAt,
      mentioned: { self: false, others: false, all: false },
      isReply: mail.inReplyTo !== undefined,
      signature: null,
    },
    declared: { nickname: mail.from, avatar: '' },
    adapter: {
      subject: mail.subject,
      messageId,
      references,
      ...(list ? { list: target } : {}),
      ...(mail.attachments.length === 0 ? {} : { attachments: attachmentMeta(mail.attachments) }),
    },
    receivedAt: input.receivedAt,
  }
}

export interface ReplyHeaders {
  subject: string
  inReplyTo?: string
  references?: string
}

/** The headers a reply carries so the thread stays one chain. */
export function replyHeadersOf(mail: ParsedMail): ReplyHeaders {
  const subject = /^re:/i.test(mail.subject.trim()) ? mail.subject.trim() : `Re: ${mail.subject.trim()}`
  const messageId = cleanId(mail.messageId)
  if (messageId === '') return { subject }
  const chain = [...mail.references.map((one) => cleanId(one)).filter((one) => one !== ''), messageId].join(' ')
  return { subject, inReplyTo: messageId, references: chain }
}

/** A fresh message id on the configured domain. */
export function newMessageId(from: string): string {
  const domain = from.includes('@') ? from.slice(from.indexOf('@') + 1) : 'localhost'
  return `<${randomUUID()}@${domain}>`
}
