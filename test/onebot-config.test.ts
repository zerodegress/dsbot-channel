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

  test('reads the file source switch, false unless a profile opens it', () => {
    expect(parseOneBotConfig(mount({ api: { url: 'http://x' } })).fileFromUrl).toBe(false)
    expect(parseOneBotConfig(mount({ api: { url: 'http://x' }, fileFromUrl: true })).fileFromUrl).toBe(true)
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, fileFromUrl: 'yes' }))).toThrow(
      /transport.fileFromUrl must be true or false/,
    )
  })

  test('a profile that names no protocol stays on http', () => {
    const config = parseOneBotConfig(mount({ api: { url: 'http://x' } }))
    expect(config.protocol).toBe('http')
    expect(config.listen).toEqual({ host: '127.0.0.1', port: 7331, path: '/onebot/event' })
  })

  test.each([
    ['event', { event: { url: 'ws://x/event' } }, /transport\.event is only read by ws-forward/],
    ['reconnect', { reconnect: false }, /transport\.reconnect is only read by ws-forward/],
    ['heartbeat', { heartbeat: {} }, /transport\.heartbeat is only read by a websocket protocol/],
  ])('http refuses %s', (_label, extra, pattern) => {
    expect(() => parseOneBotConfig(mount({ api: { url: 'http://x' }, ...extra }))).toThrow(pattern)
  })

  test('ws-forward takes socket urls, rejects listen, and defaults its retry', () => {
    const config = parseOneBotConfig(mount({ protocol: 'ws-forward', api: { url: 'ws://x/api' } }))
    expect(config.protocol).toBe('ws-forward')
    expect(config.listen).toBeUndefined()
    expect(config.reconnect).toEqual({ initialMs: 500, maxMs: 30_000, factor: 2 })
    expect(() =>
      parseOneBotConfig(mount({ protocol: 'ws-forward', api: { url: 'http://x/api' } })),
    ).toThrow(/absolute ws\(s\) url/)
    expect(() =>
      parseOneBotConfig(mount({ protocol: 'ws-forward', api: { url: 'ws://x/api' }, listen: { port: 1 } })),
    ).toThrow(/transport\.listen is not read by ws-forward/)
  })

  test.each([
    ['a factor below one', { reconnect: { factor: 0.5 } }, /reconnect\.factor/],
    ['an initial delay above the ceiling', { reconnect: { initialMs: 400, maxMs: 300 } }, /initialMs/],
    ['a heartbeat without a timeout', { heartbeat: { intervalMs: 1000 } }, /heartbeat\.timeoutMs/],
    ['a timeout at or below the interval', { heartbeat: { intervalMs: 1000, timeoutMs: 1000 } }, /heartbeat\.timeoutMs/],
  ])('ws-forward refuses %s', (_label, extra, pattern) => {
    expect(() => parseOneBotConfig(mount({ protocol: 'ws-forward', api: { url: 'ws://x/api' }, ...extra }))).toThrow(
      pattern,
    )
  })

  test('ws-reverse keeps a socket of its own and refuses the forward fields', () => {
    const config = parseOneBotConfig(mount({ protocol: 'ws-reverse', listen: { port: 0 } }))
    expect(config.protocol).toBe('ws-reverse')
    expect(config.api).toBeUndefined()
    expect(config.listen?.path).toBe('/onebot/ws')
    expect(() =>
      parseOneBotConfig(mount({ protocol: 'ws-reverse', api: { url: 'ws://x/api' } })),
    ).toThrow(/transport\.api is not read by ws-reverse/)
    expect(() => parseOneBotConfig(mount({ protocol: 'ws-reverse', event: { url: 'ws://x/e' } }))).toThrow(
      /transport\.event is only read by ws-forward/,
    )
    expect(() => parseOneBotConfig(mount({ protocol: 'ws-reverse', reconnect: false }))).toThrow(
      /transport\.reconnect is only read by ws-forward/,
    )
  })

  test('an unknown protocol names the three it knows', () => {
    expect(() => parseOneBotConfig(mount({ protocol: 'carrier-pigeon' }))).toThrow(
      /transport\.protocol must be one of http, ws-forward, ws-reverse/,
    )
  })

  test('a websocket profile may open a heartbeat', () => {
    const config = parseOneBotConfig(
      mount({ protocol: 'ws-forward', api: { url: 'ws://x/api' }, heartbeat: { intervalMs: 1000, timeoutMs: 3000 } }),
    )
    expect(config.heartbeat).toEqual({ intervalMs: 1000, timeoutMs: 3000 })
  })
})
