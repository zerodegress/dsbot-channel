import { describe, expect, test } from 'vitest'
import { GROUP_GUIDANCE, InjectionLedger, PEER_GUIDANCE, guidanceFor } from '../src/inbound-guidance.js'

describe('what a session is told about answering', () => {
  test('a peer link is told to answer, or to end or decline', () => {
    expect(guidanceFor('p2p')).toBe(PEER_GUIDANCE)
    expect(PEER_GUIDANCE).toContain('no_reply')
    expect(PEER_GUIDANCE).toContain('decline')
  })

  test('an external group is told its reply is posted to the group', () => {
    expect(guidanceFor('group')).toBe(GROUP_GUIDANCE)
    expect(GROUP_GUIDANCE).toContain('send_text')
  })

  test('the same session is told once, so a run of messages is not repeated', () => {
    const ledger = new InjectionLedger()

    expect(ledger.claim('session-1')).toBe(true)
    expect(ledger.claim('session-1')).toBe(false)
    expect(ledger.claim('session-2')).toBe(true)
  })
})
