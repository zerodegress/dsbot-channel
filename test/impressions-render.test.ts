import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { ImpressionStore, impressionId } from '../src/impressions.js'
import type { Impression } from '../src/impressions.js'

const AT = 1_700_000_000_000
let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsbot-render-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })
})

function note(text = 'alice likes tea'): Impression {
  const base: Omit<Impression, 'id'> = {
    subject: 'alice',
    subjectKind: 'person',
    scope: 'c2c',
    text,
    kind: 'fact',
    confidence: 0.6,
    share: 'local',
    evidence: [{ eventKey: 'seed:1', sessionKey: 'seed', channel: 'seed', at: AT }],
    bot: 'bot-a',
    createdAt: AT,
    updatedAt: AT,
  }
  return { ...base, id: impressionId(base) }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 40))
}

describe('a render that cannot land', () => {
  test('tries twice, then waits for a new write; success resets the allowance', async () => {
    let failing = true
    let attempts = 0
    const store = new ImpressionStore({
      dir,
      bot: 'bot-a',
      now: () => AT,
      warn: () => undefined,
      render: async () => {
        attempts += 1
        if (failing) throw new Error('render failed')
      },
    })
    await store.load()
    await store.transact('person', 'alice', () => [note()])
    await settle()
    expect(attempts).toBe(2)

    await settle()
    expect(attempts).toBe(2)

    failing = false
    await store.transact('person', 'alice', (records) => [...records, note('second')])
    await settle()
    expect(attempts).toBe(3)

    failing = true
    await store.transact('person', 'alice', (records) => [...records, note('third')])
    await settle()
    expect(attempts).toBe(5)
  })
})
