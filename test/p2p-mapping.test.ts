import { describe, expect, test } from 'vitest'
import { buildEvent } from '../src/event-build.js'
import { toP2PEvent } from '../src/p2p-mapping.js'

const inbound = { instance: 'peer-a', sender: 'bot-a', messageId: 'p2p-e1', body: 'hello', sentAt: 1_700_000_000_000 }

describe('p2p event mapping', () => {
  test('uses the p2p source kind and instance', () => {
    const event = toP2PEvent(inbound)
    expect(event.source.kind).toBe('p2p')
    expect(event.source.instance).toBe('peer-a')
    expect(event.source.scope).toBe('p2p')
  })

  test('the bot author has a null personId', () => {
    expect(toP2PEvent(inbound).author.personId).toBeNull()
    expect(toP2PEvent(inbound).author.senderId).toBe('bot-a')
  })

  test('the eventKey uses the derived messageId', () => {
    expect(toP2PEvent(inbound).meta.derived.eventKey).toBe('peer-a:p2p-e1')
  })

  test('the body carries an origin prefix for the peer sender', () => {
    expect(toP2PEvent(inbound).body.text).toContain('[p2p from peer-a')
    expect(toP2PEvent(inbound).body.text).toContain('bot-a')
    expect(toP2PEvent(inbound).body.text).toContain('p2p-e1')
  })

  test('a retry with the same eventId maps to the same eventKey', () => {
    expect(toP2PEvent(inbound).meta.derived.eventKey).toBe(toP2PEvent({ ...inbound }).meta.derived.eventKey)
  })

  test('the mapped event can be rebuilt without changing its identity', () => {
    const event = toP2PEvent(inbound)
    const rebuilt = buildEvent({
      source: event.source,
      author: event.author,
      body: event.body,
      transport: event.meta.transport,
      declared: event.meta.declared,
    })
    expect(rebuilt.meta.derived.eventKey).toBe(event.meta.derived.eventKey)
  })

  test('the transport layer keeps the peer message id', () => {
    expect(toP2PEvent(inbound).meta.transport.messageId).toBe('p2p-e1')
  })
})
