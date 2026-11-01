import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mapOneBotEvent } from '../src/adapters/onebot/adapter.js'
import type { OneBotAdapterConfig } from '../src/adapters/onebot/adapter.js'
import { toP2PEvent } from '../src/adapters/p2p/p2p-mapping.js'
import { ADAPTER_META_MAX_BYTES } from '../src/adapter-meta.js'

const config: OneBotAdapterConfig = {
  channel: 'onebot:a',
  instance: 'inst-a',
  botName: 'bot-a',
  selfId: '10001',
  listen: { host: '127.0.0.1', port: 0, path: '/onebot/event' },
  api: { url: 'http://127.0.0.1:1', timeoutMs: 1000 },
  sendTimeoutMs: 1000,
  bots: [],
}

const onebotEvent = (overrides: Record<string, unknown> = {}) => ({
  post_type: 'message',
  message_type: 'group',
  self_id: 10001,
  message_id: 1,
  user_id: 20002,
  group_id: 12345,
  time: 1_700_000_000,
  raw_message: '[CQ:at,qq=10001] 你好',
  message: [{ type: 'at', data: { qq: '10001' } }, { type: 'text', data: { text: ' 你好' } }],
  sender: { nickname: 'n' },
  ...overrides,
})

describe('what an onebot event keeps raw', () => {
  test('the raw message travels untouched, with its CQ codes', () => {
    const message = mapOneBotEvent(onebotEvent(), config, () => undefined)!
    expect(message.adapter).toMatchObject({ rawMessage: '[CQ:at,qq=10001] 你好', messageType: 'group' })
    expect(message.rawText).toBe(' 你好')
  })

  test('a payload over the limit is left out, and the message still arrives', () => {
    const warnings: string[] = []
    const message = mapOneBotEvent(
      onebotEvent({ raw_message: 'x'.repeat(ADAPTER_META_MAX_BYTES + 10) }),
      config,
      () => undefined,
      (line) => warnings.push(line),
    )!
    expect(message).toBeDefined()
    expect(message.adapter).toEqual({})
    expect(warnings.some((line) => line.includes('larger than'))).toBe(true)
    expect(JSON.stringify(warnings)).not.toContain('xxxxxxxxxx')
  })

  test('the event key and content hash are the same as without a payload', () => {
    const withRaw = mapOneBotEvent(onebotEvent(), config, () => undefined)!
    const withoutRaw = mapOneBotEvent(onebotEvent({ raw_message: 'other text entirely' }), config, () => undefined)!
    expect(withoutRaw.eventKey).toBe(withRaw.eventKey)
    expect(withoutRaw.body.text).toBe(withRaw.body.text)
  })
})

describe('what a p2p event keeps raw', () => {
  test('the envelope fields the wire carried', () => {
    const event = toP2PEvent({
      instance: 'inst-b',
      sender: 'bot-b',
      messageId: 'evt-1',
      body: 'hello',
      sentAt: 1_700_000_000_000,
      inReplyTo: 'evt-0',
      inReplyToExcerpt: 'earlier',
    })
    expect(event.meta.adapter).toEqual({
      sentAt: 1_700_000_000_000,
      inReplyTo: 'evt-0',
      inReplyToExcerpt: 'earlier',
    })
  })

  test('a refusal keeps its status, and no secret is carried', () => {
    const event = toP2PEvent({
      instance: 'inst-b',
      sender: 'bot-b',
      messageId: 'evt-2',
      body: '',
      sentAt: 1,
      status: 'declined',
      reason: 'no',
      final: true,
    })
    expect(event.meta.adapter).toMatchObject({ status: 'declined', reason: 'no', final: true })
    expect(JSON.stringify(event.meta.adapter)).not.toContain('secret')
  })
})

describe('the payload stays out of decisions and out of sight', () => {
  const decisions = ['pipeline.ts', 'inbound-gate.ts', 'policy-config.ts', 'reply-config.ts']

  test.each(decisions)('%s never reads the adapter payload', (file) => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
    expect(source).not.toContain('meta.adapter')
    expect(source).not.toContain('.adapter')
  })

  test('a turn record carries no payload', async () => {
    const { TurnStats } = await import('../src/turn-stats.js')
    const stats = new TurnStats({ now: () => 1 })
    stats.close({ eventKey: 'e1', bot: 'b', channel: 'c', sessionKey: 's', outcome: 'replied' })
    expect(JSON.stringify(stats.snapshot().recent)).not.toContain('adapter')
  })
})
