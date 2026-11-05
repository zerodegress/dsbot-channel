import { createHash } from 'node:crypto'

export interface MailHeaders {
  [key: string]: string[]
}

export interface MailPart {
  headers: MailHeaders
  contentType: string
  body: Buffer
}

export interface MailAttachment {
  name: string
  type: string
  size: number
  handle: string
}

export interface ParsedMail {
  headers: MailHeaders
  from: string
  to: readonly string[]
  subject: string
  messageId: string
  inReplyTo?: string
  references: readonly string[]
  date?: number
  text: string
  attachments: readonly MailAttachment[]
}

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

/** Splits a raw message into unfolded headers and the body; lower-cases the names. */
export function splitMessage(raw: string): { headers: MailHeaders; body: string } {
  const lines = raw.split(/\r?\n/)
  const headers: MailHeaders = {}
  let index = 0
  let current: string | undefined
  for (; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (line === '') {
      index += 1
      break
    }
    if (/^[ \t]/.test(line) && current !== undefined) {
      const list = headers[current]
      if (list !== undefined && list.length > 0) list[list.length - 1] = `${list[list.length - 1]} ${line.trim()}`
      continue
    }
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    const name = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    current = name
    if (headers[name] === undefined) headers[name] = []
    headers[name].push(value)
  }
  return { headers, body: lines.slice(index).join('\n') }
}

export function header(headers: MailHeaders, name: string): string | undefined {
  return headers[name.toLowerCase()]?.[0]
}

/** Decodes RFC 2047 words such as `=?utf-8?B?...?=`. */
export function decodeWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_whole, charset: string, encoding: string, payload: string) => {
    try {
      const bytes =
        encoding.toUpperCase() === 'B'
          ? Buffer.from(payload, 'base64')
          : Buffer.from(
              payload
                .replace(/_/g, ' ')
                .replace(/=([0-9A-Fa-f]{2})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))),
              'binary',
            )
      return bytes.toString(charsetName(charset))
    } catch {
      return payload
    }
  })
}

function charsetName(charset: string): BufferEncoding {
  const name = charset.toLowerCase()
  if (name.includes('utf-8')) return 'utf8'
  if (name.includes('iso-8859-1') || name.includes('latin1')) return 'latin1'
  if (name.includes('ascii')) return 'ascii'
  return 'utf8'
}

/** Decodes a transfer encoding; an unknown one is read as-is. */
export function decodeBody(body: string, encoding: string): Buffer {
  const name = encoding.trim().toLowerCase()
  if (name === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64')
  if (name === 'quoted-printable') {
    const cleaned = body.replace(/=\r?\n/g, '')
    const bytes: number[] = []
    for (let index = 0; index < cleaned.length; index += 1) {
      const char = cleaned[index]!
      if (char === '=') {
        const hex = cleaned.slice(index + 1, index + 3)
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(Number.parseInt(hex, 16))
          index += 2
          continue
        }
      }
      bytes.push(char.charCodeAt(0))
    }
    return Buffer.from(bytes)
  }
  return Buffer.from(body, 'binary')
}

export function contentTypeOf(headers: MailHeaders): string {
  return (header(headers, 'content-type') ?? 'text/plain').trim()
}

export function boundaryOf(headers: MailHeaders): string | undefined {
  const matched = /boundary="?([^";]+)"?/i.exec(contentTypeOf(headers))
  return matched?.[1]
}

export function dispositionOf(headers: MailHeaders): string {
  return (header(headers, 'content-disposition') ?? '').trim().toLowerCase()
}

export function fileNameOf(headers: MailHeaders): string | undefined {
  const disposition = dispositionOf(headers)
  const fromDisposition = /filename\*?=(?:utf-8'')?"?([^";]+)"?/i.exec(disposition)
  if (fromDisposition !== null) return decodeWords(fromDisposition[1]!)
  const fromType = /name="?([^";]+)"?/i.exec(contentTypeOf(headers))
  return fromType === null ? undefined : decodeWords(fromType[1]!)
}

/** Splits a multipart body into its parts, keeping each part's own headers. */
export function splitParts(body: string, boundary: string): MailPart[] {
  const marker = `--${boundary}`
  const parts: MailPart[] = []
  const segments = body.split(marker)
  for (const segment of segments.slice(1)) {
    if (segment.startsWith('--')) break
    const trimmed = segment.replace(/^\r?\n/, '')
    const { headers, body: content } = splitMessage(trimmed)
    parts.push({
      headers,
      contentType: contentTypeOf(headers),
      body: decodeBody(content, header(headers, 'content-transfer-encoding') ?? '7bit'),
    })
  }
  return parts
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
}

/** Reads an html body as plain text: no scripts, no images, no tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_whole, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_whole, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name: string) => ENTITIES[name.toLowerCase()] ?? whole)
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function charsetOf(headers: MailHeaders): BufferEncoding {
  const matched = /charset="?([^";]+)"?/i.exec(contentTypeOf(headers))
  return matched === null ? 'utf8' : charsetName(matched[1]!)
}

function textOf(part: MailPart): string {
  const type = part.contentType.toLowerCase()
  const body = part.body.toString(charsetOf(part.headers))
  if (type.startsWith('text/html')) return htmlToText(body)
  return body
}

function isText(part: MailPart): boolean {
  const type = part.contentType.toLowerCase()
  return type.startsWith('text/plain') || type.startsWith('text/html')
}

function isAttachment(part: MailPart): boolean {
  return dispositionOf(part.headers).startsWith('attachment') || fileNameOf(part.headers) !== undefined
}

/** Picks the readable body: plain text wins over html, and inline images never count. */
export function chooseBody(part: MailPart, depth = 0): string {
  if (depth > 8) return ''
  const type = part.contentType.toLowerCase()
  if (type.startsWith('multipart/')) {
    const boundary = boundaryOf(part.headers)
    if (boundary === undefined) return ''
    const children = splitParts(part.body.toString('binary'), boundary)
    if (type.startsWith('multipart/alternative')) {
      const plain = children.find((one) => one.contentType.toLowerCase().startsWith('text/plain'))
      if (plain !== undefined) return textOf(plain)
      const html = children.find((one) => one.contentType.toLowerCase().startsWith('text/html'))
      return html === undefined ? '' : textOf(html)
    }
    if (type.startsWith('multipart/related')) {
      const first = children.find((one) => !isAttachment(one))
      return first === undefined ? '' : chooseBody(first, depth + 1)
    }
    const text = children.find((one) => isText(one) && !isAttachment(one))
    if (text !== undefined) return textOf(text)
    for (const child of children) {
      if (isAttachment(child)) continue
      const nested = chooseBody(child, depth + 1)
      if (nested !== '') return nested
    }
    return ''
  }
  return isText(part) ? textOf(part) : ''
}

function attachmentsOf(part: MailPart, depth = 0): MailAttachment[] {
  if (depth > 8) return []
  const type = part.contentType.toLowerCase()
  if (type.startsWith('multipart/')) {
    const boundary = boundaryOf(part.headers)
    if (boundary === undefined) return []
    return splitParts(part.body.toString('binary'), boundary).flatMap((child) => attachmentsOf(child, depth + 1))
  }
  if (!isAttachment(part)) return []
  const name = fileNameOf(part.headers) ?? 'attachment'
  const size = part.body.length
  return [
    {
      name,
      type: type.split(';')[0] ?? 'application/octet-stream',
      size,
      handle: `mail:${createHash('sha256').update(part.body).digest('hex').slice(0, 16)}`,
    },
  ]
}

/** Reads the headers a thread and a reply need, then the body and attachments. */
export function parseMail(input: Buffer | string, maxAttachmentBytes = MAX_ATTACHMENT_BYTES): ParsedMail {
  const raw = Buffer.isBuffer(input) ? input.toString('latin1') : input
  const root = splitMessage(raw)
  const top: MailPart = { headers: root.headers, contentType: contentTypeOf(root.headers), body: Buffer.from(root.body, 'binary') }
  const text = chooseBody(top).trimEnd()
  const attachments = attachmentsOf(top).filter((one) => one.size <= maxAttachmentBytes)
  const references = (header(root.headers, 'references') ?? '')
    .split(/\s+/)
    .map((one) => one.trim())
    .filter((one) => one.length > 0)
  const messageId = cleanId(header(root.headers, 'message-id'))
  const inReplyTo = cleanId(header(root.headers, 'in-reply-to'))
  const date = Date.parse(header(root.headers, 'date') ?? '')
  const from = decodeWords(header(root.headers, 'from') ?? '')
  const to = (header(root.headers, 'to') ?? '')
    .split(',')
    .map((one) => decodeWords(one).trim())
    .filter((one) => one.length > 0)
  return {
    headers: root.headers,
    from,
    to,
    subject: decodeWords(header(root.headers, 'subject') ?? ''),
    messageId,
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
    ...(Number.isFinite(date) ? { date } : {}),
    text,
    attachments,
  }
}

/** The address inside angle brackets, without them. */
export function cleanId(value: string | undefined): string {
  if (value === undefined) return ''
  const matched = /<([^>]+)>/.exec(value)
  return matched === null ? value.trim() : matched[1]!.trim()
}

/** The address part of `Name <user@host>`. */
export function addressOf(value: string): string {
  const matched = /<([^>]+)>/.exec(value)
  return matched === null ? value.trim() : matched[1]!.trim()
}
