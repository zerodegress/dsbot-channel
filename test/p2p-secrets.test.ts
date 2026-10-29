import { describe, expect, test } from 'vitest'
import { SecretRefError, assertPeersResolvable, resolvePeers } from '../src/p2p-secrets.js'
import type { CredentialsLike } from '../src/p2p-secrets.js'
import { DedupeTable } from '../src/p2p-dedupe.js'
import { handleMessage } from '../src/p2p-protocol.js'

const refs = [
  { instance: 'peer-a', secret: 'P2P_A_SECRET' },
  { instance: 'peer-b', secret: 'P2P_B_SECRET' },
]

const fakeCredentials = (values: Record<string, string>): CredentialsLike => ({
  resolve: async (reference: string) => {
    const value = values[reference]
    if (!value) return undefined
    return { value, source: 'env' }
  },
})

describe('resolving peer references', () => {
  test('reads each reference through the credentials service', async () => {
    const resolved = await resolvePeers(refs, fakeCredentials({ P2P_A_SECRET: 'value-a', P2P_B_SECRET: 'value-b' }))
    expect(resolved).toEqual([
      { instance: 'peer-a', secret: 'value-a' },
      { instance: 'peer-b', secret: 'value-b' },
    ])
  })

  test('an unresolvable reference names the peer and the reference', async () => {
    try {
      await resolvePeers(refs, fakeCredentials({ P2P_A_SECRET: 'value-a' }))
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(SecretRefError)
      expect((error as SecretRefError).instance).toBe('peer-b')
      expect((error as SecretRefError).reference).toBe('P2P_B_SECRET')
    }
  })

  test('an undefined result becomes a reference error, not a crash', async () => {
    await expect(resolvePeers(refs, fakeCredentials({}))).rejects.toBeInstanceOf(SecretRefError)
  })

  test('a resolver that throws is also a reference error', async () => {
    const throwing: CredentialsLike = { resolve: async () => { throw new Error('provider down') } }
    await expect(resolvePeers(refs, throwing)).rejects.toBeInstanceOf(SecretRefError)
  })

  test('an empty value counts as not configured', async () => {
    const empty: CredentialsLike = { resolve: async () => ({ value: '' }) }
    await expect(resolvePeers(refs, empty)).rejects.toMatchObject({ reason: 'blank' })
  })

  test('a whitespace-only value is refused as well', async () => {
    const blank: CredentialsLike = { resolve: async () => ({ value: '   ' }) }
    await expect(resolvePeers(refs, blank)).rejects.toMatchObject({ reason: 'blank' })
  })

  test('a blank value is reported differently from an unresolved one', async () => {
    const blank: CredentialsLike = { resolve: async () => ({ value: '  ' }) }
    const missing: CredentialsLike = { resolve: async () => undefined }
    const blankError = await resolvePeers([refs[0]!], blank).catch((error: unknown) => error)
    const missingError = await resolvePeers([refs[0]!], missing).catch((error: unknown) => error)
    expect((blankError as SecretRefError).reason).toBe('blank')
    expect((missingError as SecretRefError).reason).toBe('unresolved')
    expect((blankError as SecretRefError).message).toMatch(/blank value/)
    expect((missingError as SecretRefError).message).toMatch(/did not resolve/)
  })

  test('a value with surrounding spaces keeps them but still clears the check', async () => {
    const padded: CredentialsLike = { resolve: async () => ({ value: ' secret ' }) }
    const resolved = await resolvePeers([refs[0]!], padded)
    expect(resolved[0]?.secret).toBe(' secret ')
  })

  test('refuses to start with no peers at all', async () => {
    await expect(assertPeersResolvable([], fakeCredentials({}))).rejects.toThrow(/at least one peer/)
  })

  test('passes when every reference resolves', async () => {
    await expect(assertPeersResolvable(refs, fakeCredentials({ P2P_A_SECRET: 'a', P2P_B_SECRET: 'b' }))).resolves.toBeUndefined()
  })

  test('the config holds references, never secret values', () => {
    const serialized = JSON.stringify(refs)
    expect(serialized).not.toContain('value-a')
    expect(serialized).not.toContain('value-b')
  })
})

describe('the wire protocol resolves at request time', () => {
  const table = () => new DedupeTable({ ttlMs: 604_800_000, limit: 100_000 })
  const payload = { eventId: 'e1', to: 'self-bot', sender: 'bot-a', instance: 'peer-a', body: 'hi', sentAt: 1_700_000_000_000 }
  const base = { botName: 'self-bot', peers: refs, inflightTtlMs: 300_000, maxBodyBytes: 64 * 1024, now: () => 1_700_000_000_000 }

  test('authenticates with the resolved value', async () => {
    const credentials = fakeCredentials({ P2P_A_SECRET: 'value-a', P2P_B_SECRET: 'value-b' })
    const result = await handleMessage({ config: { ...base, credentials }, table: table(), auth: { authorization: 'Bearer value-a', claimedInstance: 'peer-a' }, payload })
    expect(result).toMatchObject({ ok: true, status: 200, body: { messageId: 'p2p-e1' } })
  })

  test('a rotated credential takes effect without restarting', async () => {
    const store: Record<string, string> = { P2P_A_SECRET: 'value-a', P2P_B_SECRET: 'value-b' }
    const config = { ...base, credentials: fakeCredentials(store) }
    expect((await handleMessage({ config, table: table(), auth: { authorization: 'Bearer value-a', claimedInstance: 'peer-a' }, payload })).ok).toBe(true)
    store.P2P_A_SECRET = 'rotated-a'
    expect(await handleMessage({ config, table: table(), auth: { authorization: 'Bearer value-a', claimedInstance: 'peer-a' }, payload: { ...payload, eventId: 'e2' } })).toMatchObject({ ok: false, status: 401 })
    expect((await handleMessage({ config, table: table(), auth: { authorization: 'Bearer rotated-a', claimedInstance: 'peer-a' }, payload: { ...payload, eventId: 'e3' } })).ok).toBe(true)
  })

  test('a peer whose reference stopped resolving is rejected', async () => {
    const result = await handleMessage({ config: { ...base, credentials: fakeCredentials({}) }, table: table(), auth: { authorization: 'Bearer value-a', claimedInstance: 'peer-a' }, payload })
    expect(result).toEqual({ ok: false, status: 401, body: { error: 'peer secret is not configured' } })
  })
})
