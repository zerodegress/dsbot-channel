import { describe, expect, test } from 'vitest'
import { MailAdapter } from '../src/adapters/mail/adapter.js'
import type { MailConfig } from '../src/adapters/mail/adapter.js'
import type { Cursor, FetchedMail, MailTransport } from '../src/adapters/mail/transport.js'
import type { AdapterPorts, InboundMessage, InboundVerdict } from '../src/contract.js'

const CRLF = '\r\n'

const raw = (overrides: { messageId?: string; references?: string[]; subject?: string } = {}): Buffer =>
  Buffer.from(
    [
      'From: Seal <seal@example.test>',
      'To: bot@example.test',
      `Subject: ${overrides.subject ?? 'Plain text thread root'}`,
      `Message-ID: <${overrides.messageId ?? 'root-100@example.test'}>`,
      ...(overrides.references === undefined ? [] : [`References: ${overrides.references.map((one) => `<${one}>`).join(' ')}`]),
      'Content-Type: text/plain; charset=utf-8',
      '',
      'hello thread',
      '',
    ].join(CRLF),
  )

const config = (over: Partial<MailConfig> = {}): MailConfig => ({
  channel: 'mail:bot',
  botName: 'bot-a',
  from: 'bot@example.test',
  imap: { host: '127.0.0.1', port: 993, secure: true, user: 'bot@example.test', password: 'imap-ref', mailbox: 'INBOX', pollMs: 1000 },
  smtp: { host: '127.0.0.1', port: 465, secure: true, user: 'bot@example.test', password: 'smtp-ref' },
  bots: ['bot@example.test'],
  lists: ['list@example.test'],
  ...over,
})

interface FakeState {
  queue: FetchedMail[]
  seen: number[]
  sent: { from: string; to: readonly string[]; raw: string }[]
  fetches: { mailbox: string; cursor: Cursor | undefined }[]
  closed: boolean
}

function fakeTransport(state: FakeState): MailTransport {
  return {
    async fetch(mailbox, cursor) {
      state.fetches.push({ mailbox, cursor })
      const messages = state.queue.splice(0)
      return { uidValidity: 7, messages }
    },
    async markSeen(_mailbox, uids) {
      state.seen.push(...uids)
    },
    async append() {},
    async send(envelope, raw) {
      state.sent.push({ from: envelope.from, to: envelope.to, raw: raw.toString('utf8') })
    },
    async close() {
      state.closed = true
    },
  }
}

const ports = (verdicts: InboundVerdict[], received: InboundMessage[] = []): AdapterPorts => ({
  async onMessage(message) {
    received.push(message)
    return verdicts.shift() ?? { ok: true }
  },
  async resolveSecret() {
    return 'resolved-value'
  },
})

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('the mail adapter polls and answers', () => {
  test('an accepted mail is marked seen and becomes an event', async () => {
    const state: FakeState = { queue: [{ uid: 10, raw: raw() }], seen: [], sent: [], fetches: [], closed: false }
    const received: InboundMessage[] = []
    const adapter = new MailAdapter(config(), { transport: fakeTransport(state) })
    const handle = await adapter.start(ports([], received))
    await wait(20)
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ sessionKey: 'mail:root-100@example.test', replyTarget: 'seal@example.test' })
    expect(state.seen).toEqual([10])
    await handle.stop()
    expect(state.closed).toBe(true)
  })

  test('a busy answer leaves the mail unseen for the next poll', async () => {
    const state: FakeState = { queue: [{ uid: 11, raw: raw({ messageId: 'busy-1@example.test' }) }], seen: [], sent: [], fetches: [], closed: false }
    const adapter = new MailAdapter(config(), { transport: fakeTransport(state) })
    const handle = await adapter.start(ports([{ ok: false, code: 'busy', reason: 'full' }]))
    await wait(20)
    expect(state.seen).toEqual([])
    const cursor = state.fetches.at(-1)?.cursor
    expect(cursor).toBeUndefined()
    await handle.stop()
  })

  test('the reply carries the thread headers', async () => {
    const state: FakeState = { queue: [{ uid: 12, raw: raw() }], seen: [], sent: [], fetches: [], closed: false }
    const received: InboundMessage[] = []
    const adapter = new MailAdapter(config(), { transport: fakeTransport(state) })
    const handle = await adapter.start(ports([], received))
    await wait(20)
    const message = received[0]!
    const result = await adapter.send({
      target: message.replyTarget,
      body: 'an answer',
      eventId: message.requestId,
      chainId: message.chainId,
      sender: 'bot-a',
      instance: 'mail:bot',
    })
    expect(result.ok).toBe(true)
    const sent = state.sent[0]!
    expect(sent.to).toEqual(['seal@example.test'])
    expect(sent.raw).toContain('In-Reply-To: <root-100@example.test>')
    expect(sent.raw).toContain('References: root-100@example.test')
    expect(sent.raw).toContain('Subject: Re: Plain text thread root')
    expect(sent.raw).toContain('an answer')
    await handle.stop()
  })
})
