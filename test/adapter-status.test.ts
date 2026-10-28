import { describe, expect, test } from 'vitest'
import {
  STALE_AFTER_MS,
  buildConnectionHealth,
  buildListenerHealth,
  buildStatus,
  isFresh,
  mayInformQuota,
  statusNotification,
} from '../src/adapter-status.js'

const capabilities = { text: true, image: false, file: false, voice: false, recall: false, history: false, mention: true, reply: true, stream: false, stableMessageId: true }

const base = {
  channel: 'p2p:self',
  account: 'self',
  bot: 'self-bot',
  capabilities,
  attributes: { stableMessageId: true },
  quota: { softLimit: 0.8, hardLimit: 1 },
  sampledAt: 1_000,
  queueDepth: 0,
}

describe('fixed fields', () => {
  test('a snapshot carries exactly the documented fields', () => {
    const status = buildStatus({ ...base, health: buildConnectionHealth({ state: 'online', reconnectCount: 0, lastConnectedAt: 1_000, queueDepth: 0 }) })
    expect(Object.keys(status).sort()).toEqual(['account', 'attributes', 'bot', 'capabilities', 'channel', 'health', 'queueDepth', 'quota', 'sampledAt'])
  })
})

describe('connection health', () => {
  test('carries the state, failure details and reconnect count', () => {
    const health = buildConnectionHealth({ state: 'reconnecting', lastFailure: 'read timeout', lastFailureAt: 900, reconnectCount: 3, lastConnectedAt: 800, queueDepth: 4 })
    expect(health.kind).toBe('connection')
    expect(health.state).toBe('reconnecting')
    expect(health.lastFailure).toBe('read timeout')
    expect(health.reconnectCount).toBe(3)
  })

  test('rejects a state outside the closed set', () => {
    expect(() => buildConnectionHealth({ state: 'sleeping' as never, reconnectCount: 0, lastConnectedAt: 0, queueDepth: 0 })).toThrow()
  })

  test('an online connection reports no failure details', () => {
    const health = buildConnectionHealth({ state: 'online', reconnectCount: 0, lastConnectedAt: 1_000, queueDepth: 0 })
    expect(health.lastFailure).toBeNull()
    expect(health.lastFailureAt).toBeNull()
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
  test('a connection snapshot cannot carry a listen state', () => {
    const status = buildStatus({ ...base, health: buildConnectionHealth({ state: 'online', reconnectCount: 0, lastConnectedAt: 1, queueDepth: 0 }) })
    expect('listenState' in status.health).toBe(false)
  })
})

describe('freshness', () => {
  test('thirty seconds is the cutoff', () => {
    expect(STALE_AFTER_MS).toBe(30_000)
  })

  test('a snapshot inside the window is fresh', () => {
    expect(isFresh(1_000, 1_000 + 29_999)).toBe(true)
  })

  test('a snapshot at or past the window is stale', () => {
    expect(isFresh(1_000, 1_000 + 30_000)).toBe(false)
    expect(isFresh(1_000, 1_000 + 60_000)).toBe(false)
  })

  test('only a fresh snapshot may inform quota decisions', () => {
    const status = buildStatus({ ...base, health: buildConnectionHealth({ state: 'online', reconnectCount: 0, lastConnectedAt: 1_000, queueDepth: 0 }) })
    expect(mayInformQuota(status, 1_000 + 10_000)).toBe(true)
    expect(mayInformQuota(status, 1_000 + 30_000)).toBe(false)
  })
})

describe('state changes are not events', () => {
  test('a notification names the channel, the health and when it happened', () => {
    const health = buildListenerHealth({ listenState: 'failed', boundPort: null, lastAuthenticatedAt: null, queueDepth: 0 })
    const note = statusNotification({ channel: 'p2p:self', health, at: 1_234 })
    expect(note).toEqual({ kind: 'status', channel: 'p2p:self', health, at: 1_234 })
  })

  test('a notification has no eventKey, so it cannot enter the event pipeline', () => {
    const health = buildListenerHealth({ listenState: 'listening', boundPort: 7123, lastAuthenticatedAt: null, queueDepth: 0 })
    const note = statusNotification({ channel: 'p2p:self', health, at: 1 })
    expect('eventKey' in note).toBe(false)
    expect('source' in note).toBe(false)
  })
})

describe('a snapshot never carries credentials', () => {
  test('a token field is dropped rather than copied', () => {
    const status = buildStatus({
      ...base,
      health: buildListenerHealth({ listenState: 'listening', boundPort: 7123, lastAuthenticatedAt: null, queueDepth: 0 }),
      token: 'dummy-credential-value',
      secret: 'dummy-shared-value',
    } as never)
    const serialized = JSON.stringify(status)
    expect(serialized).not.toContain('dummy-credential-value')
    expect(serialized).not.toContain('dummy-shared-value')
  })

  test('a raw error body is not part of any health shape', () => {
    const health = buildConnectionHealth({ state: 'offline', lastFailure: 'connection refused', lastFailureAt: 5, reconnectCount: 1, lastConnectedAt: null, queueDepth: 0 })
    expect(JSON.stringify(health)).not.toMatch(/stack|at Object|node_modules/)
  })
})
