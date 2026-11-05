import { describe, expect, test } from 'vitest'
import { parseMail, splitMessage, htmlToText, decodeWords } from '../src/adapters/mail/mime.js'
import { isList, mapMail, messageIdOf, replyAddressOf, replyHeadersOf, threadRootOf } from '../src/adapters/mail/mapping.js'

const CRLF = '\r\n'

function raw(headers: readonly string[], body: string): string {
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body.replace(/\n/g, CRLF)}`
}

const plain = raw(
  [
    'From: Seal <seal@example.test>',
    'To: bot@example.test',
    'Subject: Plain text thread root',
    'Message-ID: <root-100@example.test>',
    'Date: Thu, 01 Jan 2026 00:00:00 +0000',
    'Content-Type: text/plain; charset=utf-8',
  ],
  'hello thread\nsecond line',
)

const reply = raw(
  [
    'From: Seal <seal@example.test>',
    'To: bot@example.test',
    'Subject: Re: Plain text thread root',
    'Message-ID: <reply-101@example.test>',
    'In-Reply-To: <root-100@example.test>',
    'References: <root-100@example.test>',
    'Content-Type: text/plain; charset=utf-8',
  ],
  'a reply',
)

const html = raw(
  [
    'From: Seal <seal@example.test>',
    'To: bot@example.test',
    'Subject: HTML body',
    'Message-ID: <html-200@example.test>',
    'Content-Type: text/html; charset=utf-8',
  ],
  '<html><head><style>p{}</style></head><body><p>Hello <b>world</b></p>' +
    '<img src="https://track.example.test/pixel.gif" width="1" height="1">' +
    '<script>alert(1)</script></body></html>',
)

const alternative = raw(
  [
    'From: Seal <seal@example.test>',
    'To: bot@example.test',
    'Subject: Alternative',
    'Message-ID: <alt-300@example.test>',
    'Content-Type: multipart/alternative; boundary="alt"',
  ],
  ['--alt', 'Content-Type: text/plain; charset=utf-8', '', 'plain body', '', '--alt', 'Content-Type: text/html; charset=utf-8', '', '<p>html body</p>', '', '--alt--', ''].join('\n'),
)

const withAttachment = raw(
  [
    'From: Seal <seal@example.test>',
    'To: bot@example.test',
    'Subject: With attachment',
    'Message-ID: <att-400@example.test>',
    'Content-Type: multipart/mixed; boundary="mix"',
  ],
  [
    '--mix',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'see the file',
    '',
    '--mix',
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from('%PDF-1.4 fake').toString('base64'),
    '',
    '--mix--',
    '',
  ].join('\n'),
)

const listMail = raw(
  [
    'From: Someone <someone@example.test>',
    'To: list@example.test',
    'Subject: [dev] a thread',
    'Message-ID: <list-500@example.test>',
    'List-Id: <dev.example.test>',
    'List-Post: <mailto:list@example.test>',
    'Content-Type: text/plain; charset=utf-8',
  ],
  'list traffic',
)

const config = { channel: 'mail:bot', from: 'bot@example.test', bots: ['bot@example.test'], lists: ['list@example.test'] }

describe('a raw message splits into headers and a body', () => {
  test('folded headers are joined and names are lower case', () => {
    const parsed = splitMessage(raw(['Subject: a folded', ' header line', 'Message-ID: <x@example.test>'], 'body here'))
    expect(parsed.headers.subject).toEqual(['a folded header line'])
    expect(parsed.headers['message-id']).toEqual(['<x@example.test>'])
    expect(parsed.body).toBe('body here')
  })

  test('rfc2047 words are decoded', () => {
    expect(decodeWords('=?utf-8?B?5L2g5aW9?=')).toBe('你好')
    expect(decodeWords('plain')).toBe('plain')
  })
})

describe('the body a reader gets', () => {
  test('plain text is read as it stands', () => {
    const mail = parseMail(plain)
    expect(mail.text).toBe('hello thread\nsecond line')
    expect(mail.subject).toBe('Plain text thread root')
    expect(mail.messageId).toBe('root-100@example.test')
    expect(mail.attachments).toHaveLength(0)
  })

  test('html loses its pixels, scripts and tags', () => {
    const mail = parseMail(html)
    expect(mail.text).toContain('Hello world')
    expect(mail.text).not.toContain('track.example.test')
    expect(mail.text).not.toContain('alert')
    expect(htmlToText('<p>a</p><img src="https://track.example.test/x"><p>b</p>')).toBe('a\nb')
  })

  test('an alternative part prefers plain text', () => {
    const mail = parseMail(alternative)
    expect(mail.text).toBe('plain body')
    expect(mail.text).not.toContain('html body')
  })

  test('an attachment is recorded, never handed to the model', () => {
    const mail = mapMail({ mail: parseMail(withAttachment), config, receivedAt: 1 })
    expect(mail.body.media).toEqual([])
    expect(mail.body.text).toBe('see the file')
    expect((mail.adapter.attachments as { name: string }[])[0]?.name).toBe('report.pdf')
  })

  test('a latin-1 body is read with its own charset', () => {
    const mail = parseMail(
      raw(
        [
          'From: Seal <seal@example.test>',
          'To: bot@example.test',
          'Subject: latin',
          'Message-ID: <latin-1@example.test>',
          'Content-Type: text/plain; charset=iso-8859-1',
        ],
        'caf\xe9',
      ),
    )
    expect(mail.text).toBe('café')
  })

  test('an attachment is a media item, never body text', () => {
    const mail = parseMail(withAttachment)
    expect(mail.text).toBe('see the file')
    expect(mail.attachments).toHaveLength(1)
    expect(mail.attachments[0]).toMatchObject({ name: 'report.pdf', type: 'application/pdf' })
    expect(mail.attachments[0]?.handle).toMatch(/^mail:[0-9a-f]{16}$/)
  })
})

describe('a thread is one chain', () => {
  test('the root is the first reference', () => {
    expect(threadRootOf(parseMail(reply))).toBe('root-100@example.test')
    expect(threadRootOf(parseMail(plain))).toBe('root-100@example.test')
  })

  test('the session and the chain start at the root', () => {
    const message = mapMail({ mail: parseMail(reply), config, receivedAt: 1 })
    expect(message.sessionKey).toBe('mail:root-100@example.test')
    expect(message.chainId).toBe('mail:root-100@example.test')
    expect(message.body.replyTo).toBe('root-100@example.test')
    expect(message.source).toMatchObject({ kind: 'mail', instance: 'mail:bot', scope: 'c2c' })
    expect(message.transport.isReply).toBe(true)
  })

  test('a replay carries the same event key', () => {
    const one = mapMail({ mail: parseMail(reply), config, receivedAt: 1 })
    const two = mapMail({ mail: parseMail(reply), config, receivedAt: 2 })
    expect(one.eventKey).toBe(two.eventKey)
    expect(one.requestId).toBe(messageIdOf(parseMail(reply)))
  })

  test('a list is a room and replies go back to it', () => {
    const mail = parseMail(listMail)
    expect(isList(mail, config.lists)).toBe(true)
    expect(replyAddressOf(mail, config.lists)).toBe('list@example.test')
    const message = mapMail({ mail, config, receivedAt: 1 })
    expect(message.source.scope).toBe('group')
    expect(message.replyTarget).toBe('list@example.test')
    expect(message.sessionKey).toBe('mail:list-500@example.test')
  })

  test('a direct mail answers the sender', () => {
    const mail = parseMail(plain)
    expect(isList(mail, config.lists)).toBe(false)
    expect(replyAddressOf(mail, config.lists)).toBe('seal@example.test')
    const message = mapMail({ mail, config, receivedAt: 1 })
    expect(message.source.scope).toBe('c2c')
    expect(message.replyTarget).toBe('seal@example.test')
  })
})

describe('a reply keeps the thread together', () => {
  test('it answers the parent and carries the whole chain', () => {
    const mail = parseMail(reply)
    expect(replyHeadersOf(mail)).toEqual({
      subject: 'Re: Plain text thread root',
      inReplyTo: 'reply-101@example.test',
      references: 'root-100@example.test reply-101@example.test',
    })
  })

  test('a second reply extends the references', () => {
    const second = parseMail(
      raw(
        [
          'From: Seal <seal@example.test>',
          'To: bot@example.test',
          'Subject: Re: Plain text thread root',
          'Message-ID: <reply-102@example.test>',
          'In-Reply-To: <reply-101@example.test>',
          'References: <root-100@example.test> <reply-101@example.test>',
          'Content-Type: text/plain',
        ],
        'again',
      ),
    )
    expect(replyHeadersOf(second).references).toBe('root-100@example.test reply-101@example.test reply-102@example.test')
    expect(threadRootOf(second)).toBe('root-100@example.test')
  })

  test('a subject that already says re is not doubled', () => {
    expect(replyHeadersOf(parseMail(reply)).subject).toBe('Re: Plain text thread root')
  })
})
