import { describe, expect, test } from 'vitest'
import { normalizeConfig } from '../src/plugin.js'

const profile = (adapter: Record<string, unknown>): never =>
  ({ adapters: [{ kind: 'p2p', channel: 'p2p:a', policy: {}, transport: {}, ...adapter }] }) as never

describe('the anchor a profile writes', () => {
  test('a Bot anchor keeps its name', () => {
    const config = normalizeConfig(profile({ botName: 'Seal' }))
    expect(config.adapters[0]).toMatchObject({ botName: 'Seal', anchor: 'bot' })
  })

  test('a pinned adapter takes its channel as identity', () => {
    const config = normalizeConfig(profile({ session: 'session-a' }))
    expect(config.adapters[0]).toMatchObject({ botName: 'p2p:a', anchor: 'session', session: 'session-a' })
  })

  test('writing both anchors fails', () => {
    expect(() => normalizeConfig(profile({ botName: 'Seal', session: 'session-a' }))).toThrow(/not both/)
  })

  test('writing neither anchor fails', () => {
    expect(() => normalizeConfig(profile({}))).toThrow(/needs botName or session/)
  })

  test('an empty botName is refused', () => {
    expect(() => normalizeConfig(profile({ botName: ' ' }))).toThrow(/botName must be a non-empty string/)
  })

  test('an empty session is refused', () => {
    expect(() => normalizeConfig(profile({ session: '' }))).toThrow(/session must be a non-empty string/)
  })

  test('cwd is refused as a removed field', () => {
    expect(() => normalizeConfig(profile({ session: 'session-a', cwd: '/tmp/work' }))).toThrow(/cwd is no longer supported/)
  })

  test('agentPreset is refused as a removed field', () => {
    expect(() => normalizeConfig(profile({ session: 'session-a', agentPreset: 'peer' }))).toThrow(
      /agentPreset is no longer supported/,
    )
  })
})
