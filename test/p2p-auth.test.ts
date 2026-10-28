import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { signBody, verifyRequest } from '../src/p2p-auth.js'

const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex')

describe('secret based auth', () => {
  const peers = [{ instance: 'peer-a', secret: 'secret-a' }, { instance: 'peer-b', secret: 'secret-b' }]

  test('resolves the instance from the secret, not from the body', () => {
    const result = verifyRequest({ peers, authorization: 'Bearer secret-a', claimedInstance: '' })
    expect(result.ok).toBe(true)
    expect(result.instance).toBe('peer-a')
  })

  test('rejects when the claimed instance disagrees with the secret', () => {
    const result = verifyRequest({ peers, authorization: 'Bearer secret-a', claimedInstance: 'peer-b' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(403)
  })

  test('rejects an unknown secret', () => {
    const result = verifyRequest({ peers, authorization: 'Bearer nope', claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects a missing authorization header', () => {
    const result = verifyRequest({ peers, authorization: null, claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('refuses to start with no peers configured', () => {
    expect(() => verifyRequest({ peers: [], authorization: 'Bearer x', claimedInstance: 'a' })).toThrow(/secret/i)
  })

  test('a secret of another peer does not authenticate as this one', () => {
    const result = verifyRequest({ peers, authorization: 'Bearer secret-b', claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
  })
})

describe('signature mode', () => {
  const secret = 'shared'
  const body = '{"eventId":"e1"}'

  test('accepts a correct signature', () => {
    const header = signBody(secret, { eventId: 'e1', sentAt: 1700000000000, body })
    const result = verifyRequest({ peers: [{ instance: 'peer-a', secret }], signature: header, eventId: 'e1', sentAt: 1700000000000, body, claimedInstance: 'peer-a' })
    expect(result.ok).toBe(true)
    expect(result.instance).toBe('peer-a')
  })

  test('rejects a tampered body', () => {
    const header = signBody(secret, { eventId: 'e1', sentAt: 1700000000000, body })
    const result = verifyRequest({ peers: [{ instance: 'peer-a', secret }], signature: header, eventId: 'e1', sentAt: 1700000000000, body: '{"eventId":"e2"}', claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects a tampered eventId', () => {
    const header = signBody(secret, { eventId: 'e1', sentAt: 1700000000000, body })
    const result = verifyRequest({ peers: [{ instance: 'peer-a', secret }], signature: header, eventId: 'e9', sentAt: 1700000000000, body, claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
  })

  test('the digest covers eventId, sentAt and the body together', () => {
    expect(digest(body)).not.toBe(digest('other'))
    const a = signBody(secret, { eventId: 'e1', sentAt: 1, body })
    expect(signBody(secret, { eventId: 'e2', sentAt: 1, body })).not.toBe(a)
    expect(signBody(secret, { eventId: 'e1', sentAt: 2, body })).not.toBe(a)
    expect(signBody(secret, { eventId: 'e1', sentAt: 1, body: 'other' })).not.toBe(a)
  })
})
