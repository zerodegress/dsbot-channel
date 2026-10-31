import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { signEnvelope, verifyRequest } from '../src/adapters/p2p/p2p-auth.js'
import type { Envelope } from '../src/adapters/p2p/p2p-auth.js'

const digest = (body: string) => createHash('sha256').update(body, 'utf8').digest('hex')

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    eventId: 'e1',
    to: 'bot-b',
    sender: 'bot-a',
    instance: 'peer-a',
    body: 'hello',
    sentAt: 1700000000000,
    ...overrides,
  }
}

describe('the only way in', () => {
  const peers = [{ instance: 'peer-a', secret: 'secret-a' }, { instance: 'peer-b', secret: 'secret-b' }]

  test('a bearer token is no longer accepted, so every call must be signed', () => {
    const result = verifyRequest({ peers, claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
    expect(result.reason).toBe('missing signature')
  })

  test('a signature with no envelope to check it against is refused', () => {
    const result = verifyRequest({ peers, signature: 'anything', claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('refuses to start with no peers configured', () => {
    expect(() => verifyRequest({ peers: [], claimedInstance: 'a' })).toThrow(/secret/i)
  })
})

describe('signature mode', () => {
  const secret = 'shared'
  const peers = [{ instance: 'peer-a', secret }]

  test('accepts a correct signature', () => {
    const signed = envelope()
    const signature = signEnvelope(secret, signed)
    const result = verifyRequest({ peers, signature, envelope: signed, claimedInstance: 'peer-a' })
    expect(result.ok).toBe(true)
    expect(result.instance).toBe('peer-a')
  })

  test('rejects a tampered body', () => {
    const signature = signEnvelope(secret, envelope())
    const result = verifyRequest({ peers, signature, envelope: envelope({ body: 'other' }), claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects a tampered eventId', () => {
    const signature = signEnvelope(secret, envelope())
    const result = verifyRequest({ peers, signature, envelope: envelope({ eventId: 'e9' }), claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
  })

  test('rejects a status the sender did not sign, so a refusal cannot be forged', () => {
    const signature = signEnvelope(secret, envelope())
    const result = verifyRequest({
      peers,
      signature,
      envelope: envelope({ status: 'declined', reason: 'not wanted', final: true }),
      claimedInstance: 'peer-a',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects a status added on its own, with no other field changed', () => {
    const signature = signEnvelope(secret, envelope())
    const result = verifyRequest({ peers, signature, envelope: envelope({ status: 'declined' }), claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('rejects a rewritten reason on a signed refusal', () => {
    const signature = signEnvelope(secret, envelope({ status: 'declined', reason: 'busy', final: true }))
    const result = verifyRequest({
      peers,
      signature,
      envelope: envelope({ status: 'declined', reason: 'not wanted', final: true }),
      claimedInstance: 'peer-a',
    })
    expect(result.ok).toBe(false)
  })

  test('covers every field of the envelope, one at a time', () => {
    const base = envelope()
    const signature = signEnvelope(secret, base)
    const changed: Envelope[] = [
      envelope({ eventId: 'e2' }),
      envelope({ to: 'bot-c' }),
      envelope({ sender: 'bot-c' }),
      envelope({ instance: 'peer-b' }),
      envelope({ body: 'other' }),
      envelope({ sentAt: 1 }),
      envelope({ status: 'declined' }),
      envelope({ reason: 'why' }),
      envelope({ final: true }),
      envelope({ inReplyTo: 'e0' }),
      envelope({ inReplyToExcerpt: 'what did you mean' }),
    ]

    for (const candidate of changed) expect(signEnvelope(secret, candidate)).not.toBe(signature)
  })

  test('rejects a rewritten reference to the message being answered', () => {
    const signature = signEnvelope(secret, envelope({ inReplyTo: 'e0', inReplyToExcerpt: 'ask about the port' }))
    const result = verifyRequest({
      peers,
      signature,
      envelope: envelope({ inReplyTo: 'e0', inReplyToExcerpt: 'ask about something else' }),
      claimedInstance: 'peer-a',
    })
    expect(result.ok).toBe(false)
    expect(result.status).toBe(401)
  })

  test('a signature over a body digest alone no longer passes', () => {
    const legacy = createHash('sha256')
      .update(`${secret}.e1.1700000000000.${digest('hello')}`, 'utf8')
      .digest('base64')
    const result = verifyRequest({ peers, signature: legacy, envelope: envelope(), claimedInstance: 'peer-a' })
    expect(result.ok).toBe(false)
  })
})
