import { describe, expect, test } from 'vitest'
import { buildListenerHealth, buildStatus, NO_MEDIA } from '../src/adapter-status.js'

const capabilities = { text: true, image: NO_MEDIA, file: NO_MEDIA, voice: NO_MEDIA, recall: false, history: { group: false, private: false }, mention: true, reply: true, stream: false, stableMessageId: true }

const base = {
  channel: 'p2p:self',
  account: 'self',
  bot: 'self-bot',
  capabilities,
  attributes: { stableMessageId: true },
  quota: { softLimit: 0.8, hardLimit: 1 },
  counters: {
    authFailures: 0,
    unknownPaths: 0,
    underruns: 0,
    protocolMismatches: 0,
    staleSentAt: {},
    sendFailures: {},
    lastFailure: null,
  },
  sampledAt: 1_000,
  queueDepth: 0,
}

describe('fixed fields', () => {
  test('a snapshot carries exactly the documented fields', () => {
    const status = buildStatus({
      ...base,
      health: { kind: 'connection', state: 'online', lastFailure: null, lastFailureAt: null, reconnectCount: 0, lastConnectedAt: 1_000, queueDepth: 0 },
    })
    expect(Object.keys(status).sort()).toEqual(['account', 'attributes', 'bot', 'capabilities', 'channel', 'counters', 'health', 'queueDepth', 'quota', 'sampledAt'])
  })
})

describe('listener health', () => {
  test('carries the listen state, bound port and last authenticated time', () => {
    const health = buildListenerHealth({ listenState: 'listening', boundPort: 7123, lastAuthenticatedAt: 950, queueDepth: 0 })
    expect(health.kind).toBe('listener')
    expect(health.boundPort).toBe(7123)
    expect(health.lastAuthenticatedAt).toBe(950)
  })

  test('rejects a listen state outside the closed set', () => {
    expect(() => buildListenerHealth({ listenState: 'bound' as never, boundPort: 1, lastAuthenticatedAt: null, queueDepth: 0 })).toThrow()
  })

  test('a stopped listener has no bound port', () => {
    const health = buildListenerHealth({ listenState: 'stopped', boundPort: null, lastAuthenticatedAt: 300, queueDepth: 0 })
    expect(health.boundPort).toBeNull()
  })
})

describe('health is one of the two shapes', () => {
  test('a connection snapshot carries no listen state', () => {
    const status = buildStatus({
      ...base,
      health: { kind: 'connection', state: 'online', lastFailure: null, lastFailureAt: null, reconnectCount: 0, lastConnectedAt: 1, queueDepth: 0 },
    })
    expect('listenState' in status.health).toBe(false)
  })
})
