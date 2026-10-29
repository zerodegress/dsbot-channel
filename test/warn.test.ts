import { describe, expect, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createWarn } from '../src/warn.js'

function contextWith(logger: unknown): Context {
  return { logger } as unknown as Context
}

describe('a warning always reaches somewhere', () => {
  test('it goes through the host logger under our own scope', () => {
    const seen: { scope?: string; message?: string } = {}
    const warn = createWarn(
      contextWith((scope: string) => ({
        warn: (message: string) => {
          seen.scope = scope
          seen.message = message
        },
      })),
    )

    warn('kept evt-4 out of a turn')

    expect(seen.scope).toBe('dsbot-channel')
    expect(seen.message).toBe('kept evt-4 out of a turn')
  })

  test('a missing logger writes to stderr instead of dropping the line', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      createWarn(contextWith(undefined))('no logger here')
      expect(write).toHaveBeenCalledWith('no logger here\n')
    } finally {
      write.mockRestore()
    }
  })

  test('a logger that throws while being taken falls back to stderr', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const broken = {
      get logger(): never {
        throw new Error('service is not ready')
      },
    }
    try {
      createWarn(broken as unknown as Context)('service missing')
      expect(write).toHaveBeenCalledWith('service missing\n')
    } finally {
      write.mockRestore()
    }
  })

  test('a logger whose warn throws does not leak the failure', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    const warn = createWarn(
      contextWith(() => ({
        warn: () => {
          throw new Error('the sink blew up')
        },
      })),
    )
    try {
      expect(() => warn('sink failure')).not.toThrow()
      expect(write).toHaveBeenCalledWith('sink failure\n')
    } finally {
      write.mockRestore()
    }
  })

  test('a stderr that throws as well is swallowed, since a warn cannot escalate', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('stderr is gone')
    })
    try {
      expect(() => createWarn(contextWith(undefined))('nowhere to go')).not.toThrow()
    } finally {
      write.mockRestore()
    }
  })
})
