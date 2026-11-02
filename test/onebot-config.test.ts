import { describe, expect, test } from 'vitest'
import { parseOneBotConfig } from '../src/adapters/onebot/index.js'

function mount(transport: Record<string, unknown>) {
  return { kind: 'onebot', channel: 'onebot:a', instance: 'inst-a', botName: 'bot-a', transport }
}

describe('the onebot transport block', () => {
  test('reads the api, the listener and the optional pieces', () => {
    const config = parseOneBotConfig(
      mount({
        selfId: '10001',
        listen: { host: '127.0.0.1', port: 7331, path: '/onebot/event' },
        api: { url: 'http://127.0.0.1:3000/' },
        accessToken: '{{SECRET_onebot}}',
        sendTimeoutMs: 5000,
        bots: ['20002'],
      }),
    )
    expect(config).toMatchObject({
      channel: 'onebot:a',
      instance: 'inst-a',
      botName: 'bot-a',
      selfId: '10001',
      listen: { host: '127.0.0.1', port: 7331, path: '/onebot/event' },
      api: { url: 'http://127.0.0.1:3000', timeoutMs: 5000 },
      sendTimeoutMs: 5000,
      accessToken: '{{SECRET_onebot}}',
      bots: ['20002'],
    })
  })

  test('defaults the listener and the send timeout, and leaves selfId optional', () => {
    const config = parseOneBotConfig(mount({ api: { url: 'http://127.0.0.1:3000' } }))
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 7331, path: '/onebot/event' })
    expect(config.sendTimeoutMs).toBe(10_000)
    expect(config.selfId).toBeUndefined()
    expect(config.bots).toEqual([])
  })

  test('requires the api and refuses a non-http url', () => {
    expect(() => parseOneBotConfig(mount({}))).toThrow(/transport.api is required/)
    expect(() => parseOneBotConfig(mount({ api: { url: 'not a url' } }))).toThrow(/absolute http/)
    expect(() => parseOneBotConfig(mount({ api: { url: 'ftp://x' } }))).toThrow(/absolute http/)
  })

  test('refuses a wildcard bind and a path without a slash', () => {
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, listen: { host: '0.0.0.0' } }))).toThrow(
      /wildcard bind is refused/,
    )
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, listen: { path: 'onebot' } }))).toThrow(
      /must start with "\/"/,
    )
  })

  test('refuses a field it does not read', () => {
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, bogus: 1 }))).toThrow(
      /transport names a field this adapter does not read: bogus/,
    )
  })

  test('refuses a malformed timeout or a non-list bots key', () => {
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, sendTimeoutMs: 0 }))).toThrow(/sendTimeoutMs/)
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, bots: '20002' }))).toThrow(/list of ids/)
  })

  test('reads the history block, off unless a profile opens a kind', () => {
    expect(parseOneBotConfig(mount({ api: { url: 'http://x' } })).history).toEqual({ group: false, private: false })
    expect(
      parseOneBotConfig(mount({ api: { url: 'http://x' }, history: { group: true } })).history,
    ).toEqual({ group: true, private: false })
    expect(
      parseOneBotConfig(mount({ api: { url: 'http://x' }, history: { group: true, private: true } })).history,
    ).toEqual({ group: true, private: true })
  })

  test('refuses a history block it cannot read', () => {
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, history: { group: 'yes' } }))).toThrow(
      /transport.history.group must be true or false/,
    )
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, history: { dm: true } }))).toThrow(
      /transport.history names a field this adapter does not read: dm/,
    )
  })
})
