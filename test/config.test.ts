import { describe, expect, test } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { ConfigError, strict, validateConfig } from '../src/config.js'

const base = () => Schema.object({ channels: Schema.array(Schema.string()).default([]) })

describe('validateConfig', () => {
  test('rejects unknown fields and names them', () => {
    expect(() => validateConfig(base(), { channels: ['a'], bogus: 1 })).toThrow(ConfigError)
    expect(() => validateConfig(base(), { channels: ['a'], bogus: 1 })).toThrow(/unknown config fields: bogus/)
  })

  test('returns the parsed value for a clean config', () => {
    expect(validateConfig(base(), { channels: ['a'] })).toEqual({ channels: ['a'] })
  })

  test('applies defaults for omitted fields', () => {
    expect(validateConfig(base(), {})).toEqual({ channels: [] })
  })

  test('reports every unknown field at once', () => {
    expect(() => validateConfig(base(), { a: 1, b: 2 })).toThrow(/unknown config fields: a, b/)
  })
})

describe('strict', () => {
  test('rejects unknown fields through a plain call', () => {
    const schema = strict<{ channels: string[] }>(base())
    expect(() => schema({ channels: ['a'], bogus: 1 })).toThrow(/unknown config fields: bogus/)
  })

  test('accepts declared fields', () => {
    const schema = strict<{ channels: string[] }>(base())
    expect(schema({ channels: ['a'] })).toEqual({ channels: ['a'] })
  })

  test('keeps the declared key list for downstream checks', () => {
    const schema = strict(base())
    expect(Object.keys(schema.dict ?? {})).toEqual(['channels'])
  })
})
