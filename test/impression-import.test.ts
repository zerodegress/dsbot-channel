import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { importMemory, parseMemoryFile } from '../src/impression-import.js'
import { IMPRESSION_TEXT_MAX, ImpressionStore, botDirectoryName, impressionId, subjectFileName } from '../src/impressions.js'
import type { Impression } from '../src/impressions.js'

const AT = 1_700_000_000_000
const roots: string[] = []

function note(overrides: Partial<Impression> = {}): Impression {
  const base: Omit<Impression, 'id'> = {
    subject: 'alice',
    subjectKind: 'person',
    scope: 'c2c',
    text: 'seed',
    kind: 'fact',
    confidence: 0.6,
    share: 'local',
    evidence: [{ eventKey: 'seed:1', sessionKey: 'seed', channel: 'seed', at: AT }],
    bot: 'bot-a',
    createdAt: AT,
    updatedAt: AT,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, id: impressionId(merged) }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 })))
})

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-import-'))
  roots.push(dir)
  return dir
}

describe('reading a host memory file', () => {
  test('keeps bullets, strips metadata, and counts what it skips', () => {
    const parsed = parseMemoryFile(
      [
        '# Memory',
        '',
        '## Index',
        '- [[topic]]',
        '',
        '## Notes',
        `- alice prefers short answers [source: 1; confidence: high]`,
        '- the group meets on Mondays',
        `- ${'x'.repeat(IMPRESSION_TEXT_MAX + 1)}`,
        'plain text nobody wrote as a bullet',
      ].join('\n'),
    )
    expect(parsed.lines).toEqual(['alice prefers short answers', 'the group meets on Mondays'])
    expect(parsed.skipped).toBe(6)
  })
})

describe('importing once', () => {
  test('writes records with a fixed envelope and no second copy', async () => {
    const dir = await tempRoot()
    const memory = await tempRoot()
    const path = join(memory, 'MEMORY.md')
    await writeFile(path, '- alice prefers short answers\n- the group meets on Mondays\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    const first = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT })
    expect(first).toEqual({ ok: true, counts: { imported: 2, skipped: 0, overflow: 0, topics: 0 } })
    const read = await store.read('person', 'alice')
    if (!read.ok) throw new Error(read.reason)
    expect(read.records).toHaveLength(2)
    const record = read.records.find((entry) => entry.text === 'alice prefers short answers')!
    expect(record).toMatchObject({ kind: 'fact', share: 'local', confidence: 0.4, scope: 'c2c', bot: 'bot-a' })
    expect(record.evidence[0]).toMatchObject({ sessionKey: 'memory-import', channel: 'memory-import', at: AT })
    expect(record.evidence[0]!.eventKey).toMatch(/^memory-import:[0-9a-f]{64}$/)

    const second = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT + 5_000 })
    expect(second).toEqual({ ok: true, counts: { imported: 0, skipped: 0, overflow: 0, topics: 0 } })
    const again = await store.read('person', 'alice')
    if (!again.ok) throw new Error(again.reason)
    expect(again.records).toHaveLength(2)
    expect(again.records.find((entry) => entry.id === record.id)!.updatedAt).toBe(AT)
  })

  test('adds only the lines a changed file brought in', async () => {
    const dir = await tempRoot()
    const memory = await tempRoot()
    const path = join(memory, 'MEMORY.md')
    await writeFile(path, '- one\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT })
    await writeFile(path, '- one\n- two\n', { mode: 0o600 })
    const second = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT + 1 })
    expect(second).toEqual({ ok: true, counts: { imported: 1, skipped: 0, overflow: 0, topics: 0 } })
    const read = await store.read('person', 'alice')
    if (!read.ok) throw new Error(read.reason)
    expect(read.records.map((entry) => entry.text).sort()).toEqual(['one', 'two'])
  })

  test('imports into a group archive and reports topic files', async () => {
    const dir = await tempRoot()
    const memory = await tempRoot()
    const path = join(memory, 'MEMORY.md')
    await writeFile(path, '- release day is Friday\n', { mode: 0o600 })
    await writeFile(join(memory, 'topics.md'), '# topics\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    const result = await importMemory({
      store,
      bot: 'bot-a',
      config: { path, as: { groupKey: 'x:a|group:1' } },
      now: AT,
    })
    expect(result).toEqual({ ok: true, counts: { imported: 1, skipped: 0, overflow: 0, topics: 1 } })
    const read = await store.read('group', 'x:a|group:1')
    if (!read.ok) throw new Error(read.reason)
    expect(read.records[0]).toMatchObject({ subjectKind: 'group', scope: 'group', groupKey: 'x:a|group:1' })
  })

  test('says the source is unreadable instead of importing nothing', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: 'bot-a' })
    await store.load()
    const missing = join(dir, 'missing', 'MEMORY.md')
    expect(await importMemory({ store, bot: 'bot-a', config: { path: missing, as: { personId: 'alice' } }, now: AT })).toEqual({
      ok: false,
      reason: 'unreadable',
      path: missing,
    })
  })
})


describe('importing into a subject that is already full', () => {
  test('never evicts a live note, reports the overflow, and rewrites nothing', async () => {
    const dir = await tempRoot()
    const memory = await tempRoot()
    const path = join(memory, 'MEMORY.md')
    await writeFile(path, Array.from({ length: 20 }, (_, index) => `- line ${index}`).join('\n') + '\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    const many = Array.from({ length: 64 }, (_, index) =>
      note({ text: `note ${index}`, createdAt: AT + index, updatedAt: AT + index }),
    )
    await store.transact('person', 'alice', () => many)
    const file = join(dir, botDirectoryName('bot-a'), 'person', `${subjectFileName('alice')}.json`)
    const before = await readFile(file, 'utf8')
    const result = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT + 10_000 })
    expect(result).toEqual({ ok: true, counts: { imported: 0, skipped: 0, overflow: 20, topics: 0 } })
    const read = await store.read('person', 'alice')
    if (!read.ok) throw new Error(read.reason)
    expect(read.records).toHaveLength(64)
    expect(read.records.map((record) => record.updatedAt)).toEqual(many.map((record) => record.updatedAt))
    expect(await readFile(file, 'utf8')).toBe(before)
  })

  test('fills whatever room is left and leaves the file alone afterwards', async () => {
    const dir = await tempRoot()
    const memory = await tempRoot()
    const path = join(memory, 'MEMORY.md')
    await writeFile(path, Array.from({ length: 5 }, (_, index) => `- line ${index}`).join('\n') + '\n', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => AT })
    await store.load()
    const many = Array.from({ length: 62 }, (_, index) =>
      note({ text: `note ${index}`, createdAt: AT + index, updatedAt: AT + index }),
    )
    await store.transact('person', 'alice', () => many)
    const first = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT + 1 })
    expect(first).toEqual({ ok: true, counts: { imported: 2, skipped: 0, overflow: 3, topics: 0 } })
    const file = join(dir, botDirectoryName('bot-a'), 'person', `${subjectFileName('alice')}.json`)
    const before = await readFile(file, 'utf8')
    const again = await importMemory({ store, bot: 'bot-a', config: { path, as: { personId: 'alice' } }, now: AT + 9_000 })
    expect(again).toEqual({ ok: true, counts: { imported: 0, skipped: 0, overflow: 3, topics: 0 } })
    expect(await readFile(file, 'utf8')).toBe(before)
  })
})
