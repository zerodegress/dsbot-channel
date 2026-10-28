import { describe, expect, test } from 'vitest'
import { ConfigError, assertBindHost } from '../src/index.js'

describe('listen host validation', () => {
  test('rejects every wildcard form', () => {
    for (const host of ['0.0.0.0', '::', '[::]', '*', ' 0.0.0.0 ']) {
      expect(() => assertBindHost(host)).toThrow(ConfigError)
    }
  })

  test('names the failing field path', () => {
    expect(() => assertBindHost('0.0.0.0')).toThrow(/at listen\.host/)
  })

  test('accepts loopback and concrete addresses', () => {
    for (const host of ['127.0.0.1', '::1', '10.1.2.3', 'peer.internal']) {
      expect(() => assertBindHost(host)).not.toThrow()
    }
  })

  test('supports a caller supplied path', () => {
    expect(() => assertBindHost('::', ['adapters', 0, 'listen', 'host'])).toThrow(/adapters\.0\.listen\.host/)
  })
})
