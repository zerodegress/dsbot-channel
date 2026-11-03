import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  IMPRESSION_RECORDS_MAX,
  IMPRESSION_TEXT_MAX,
  ImpressionStore,
  botDirectoryName,
  impressionId,
  parseImpressionFile,
  readImpressionsConfig,
  subjectFileName,
} from '../src/impressions.js'
import type {
  Impression,
  ImpressionEvidence,
  ImpressionFile,
  ImpressionFileInput,
} from '../src/impressions.js'

const BOT = 'bot-a'
const AT = 1_700_000_000_000

function evidence(overrides: Partial<ImpressionEvidence> = {}): ImpressionEvidence {
  return { eventKey: 'inst:1', sessionKey: 'group:100', channel: 'chan-a', at: AT, ...overrides }
}

function note(overrides: Partial<Impression> = {}): Impression {
  const base: Omit<Impression, 'id'> = {
    subject: 'alice',
    subjectKind: 'person',
    scope: 'c2c',
    text: 'alice likes short answers',
    kind: 'fact',
    confidence: 0.6,
    share: 'local',
    evidence: [evidence()],
    bot: BOT,
    createdAt: AT,
    updatedAt: AT,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, id: overrides.id ?? impressionId(merged) }
}

function fileOf(records: Impression[], overrides: Partial<ImpressionFile> = {}): ImpressionFile {
  return {
    version: 1,
    subject: records[0]!.subject,
    subjectKind: records[0]!.subjectKind,
    touchedAt: AT,
    records,
    ...overrides,
  }
}

function inputOf(records: Impression[], overrides: Partial<ImpressionFileInput> = {}): ImpressionFileInput {
  const file = fileOf(records, overrides)
  return { version: file.version, subject: file.subject, subjectKind: file.subjectKind, records: file.records }
}

function refusal(file: unknown): string {
  try {
    parseImpressionFile(file, BOT, '/tmp/impression.json')
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('the file should have been refused')
}

describe('the record shape', () => {
  test('derives an id from what the record says, not from when it was written', () => {
    const record = note()
    expect(record.id).toMatch(/^[0-9a-f]{32}$/)
    expect(impressionId(record)).toBe(record.id)
    expect(note({ createdAt: AT + 1, updatedAt: AT + 1 }).id).toBe(record.id)
    expect(note({ text: 'alice writes long answers' }).id).not.toBe(record.id)
    expect(note({ kind: 'manner' }).id).not.toBe(record.id)
    expect(note({ subject: 'bob' }).id).not.toBe(record.id)
  })

  test('keeps a group note apart from the same words in a private chat', () => {
    const c2c = note({ scope: 'c2c' })
    const group = note({ scope: 'group', groupKey: 'chan-a|group:100' })
    expect(group.id).not.toBe(c2c.id)
  })

  test('hashes a subject without letting separators into the file name', () => {
    expect(subjectFileName('../../etc/passwd')).toMatch(/^[0-9a-f]{64}$/)
    expect(subjectFileName('alice')).not.toBe(subjectFileName('bob'))
    expect(botDirectoryName('bot-a')).not.toBe(botDirectoryName('bot-b'))
  })
})

describe('the plugin-level block', () => {
  test('is off when absent', () => {
    expect(readImpressionsConfig(undefined)).toBeUndefined()
  })

  test('takes an absolute directory', () => {
    expect(readImpressionsConfig({ dir: '/var/lib/dsbot-channel' })).toEqual({ dir: '/var/lib/dsbot-channel' })
  })

  test('refuses a relative directory', () => {
    expect(() => readImpressionsConfig({ dir: 'impressions' })).toThrow(/absolute/)
    expect(() => readImpressionsConfig({ dir: './impressions' })).toThrow(/absolute/)
  })

  test('refuses an empty or missing directory', () => {
    expect(() => readImpressionsConfig({})).toThrow(/non-empty/)
    expect(() => readImpressionsConfig({ dir: '' })).toThrow(/non-empty/)
    expect(() => readImpressionsConfig({ dir: 1 })).toThrow(/non-empty/)
  })

  test('refuses a field it does not read', () => {
    expect(() => readImpressionsConfig({ dir: '/srv/notes', extra: 1 })).toThrow(/does not read/)
  })

  test('refuses a block that is not an object', () => {
    expect(() => readImpressionsConfig([])).toThrow(/object/)
    expect(() => readImpressionsConfig('notes')).toThrow(/object/)
  })
})

describe('reading one subject file', () => {
  test('accepts a person note learned in a private chat', () => {
    const record = note()
    expect(parseImpressionFile(fileOf([record]), BOT, '/tmp/impression.json')).toEqual(fileOf([record]))
  })

  test('accepts a person note learned in a group', () => {
    const record = note({ scope: 'group', groupKey: 'chan-a|group:100' })
    expect(parseImpressionFile(fileOf([record]), BOT, '/tmp/impression.json').records[0]!.groupKey).toBe('chan-a|group:100')
  })

  test('accepts a group record when the group is its subject', () => {
    const key = 'chan-a|group:100'
    const record = note({ subject: key, subjectKind: 'group', scope: 'group', groupKey: key, kind: 'topic' })
    expect(parseImpressionFile(fileOf([record]), BOT, '/tmp/impression.json').subject).toBe(key)
  })

  test('accepts a shareable note marked for cross-platform reading', () => {
    const record = note({ kind: 'manner', share: 'cross' })
    expect(parseImpressionFile(fileOf([record]), BOT, '/tmp/impression.json').records[0]!.share).toBe('cross')
  })

  test('refuses a version this package does not read', () => {
    expect(refusal({ ...fileOf([note()]), version: 2 })).toMatch(/version 2/)
  })

  test('refuses a file without a touchedAt stamp', () => {
    expect(refusal({ ...fileOf([note()]), touchedAt: undefined })).toMatch(/touchedAt must be a whole number/)
  })

  test('refuses a field it does not read, at the file and at the record', () => {
    expect(refusal({ ...fileOf([note()]), extra: 1 })).toMatch(/does not read: extra/)
    expect(refusal(fileOf([{ ...note(), extra: 1 } as unknown as Impression]))).toMatch(/does not read: extra/)
    expect(refusal(fileOf([{ ...note(), evidence: [{ ...evidence(), extra: 1 } as unknown as ImpressionEvidence] }]))).toMatch(/does not read: extra/)
  })

  test('refuses a record whose id does not match its content', () => {
    expect(refusal(fileOf([note({ id: '0'.repeat(32) })]))).toMatch(/id does not match its content/)
  })

  test('refuses a record that belongs to another subject or bot', () => {
    expect(refusal(fileOf([note()], { subject: 'bob' }))).toMatch(/subject does not match the file/)
    expect(refusal(fileOf([note({ bot: 'bot-b' })]))).toMatch(/bot is "bot-b"/)
  })

  test('refuses a groupKey outside a group scope and requires one inside it', () => {
    expect(refusal(fileOf([note({ scope: 'c2c', groupKey: 'chan-a|group:100' })]))).toMatch(/only read in a group scope/)
    expect(refusal(fileOf([{ ...note(), scope: 'group' }]))).toMatch(/groupKey must be a non-empty string/)
  })

  test('refuses a group record whose scope or groupKey disagrees with its subject', () => {
    const key = 'chan-a|group:100'
    expect(refusal(fileOf([note({ subject: key, subjectKind: 'group', scope: 'c2c' })]))).toMatch(/is a group record/)
    expect(
      refusal(fileOf([note({ subject: key, subjectKind: 'group', scope: 'group', groupKey: 'chan-b|group:100' })])),
    ).toMatch(/is a group record/)
  })

  test('refuses a kind outside the closed set', () => {
    expect(refusal(fileOf([note({ kind: 'junk' as never })]))).toMatch(/kind must be one of/)
  })

  test('refuses cross sharing for anything but the four shareable kinds', () => {
    expect(refusal(fileOf([note({ share: 'cross' })]))).toMatch(/only address, language, taboo, manner/)
  })

  test('refuses a confidence outside 0..1', () => {
    expect(refusal(fileOf([note({ confidence: 1.2 })]))).toMatch(/between 0 and 1/)
    expect(refusal(fileOf([note({ confidence: -0.1 })]))).toMatch(/between 0 and 1/)
  })

  test('refuses text that is too long or spans lines', () => {
    expect(refusal(fileOf([note({ text: 'x'.repeat(IMPRESSION_TEXT_MAX + 1) })]))).toMatch(/longer than 240/)
    expect(refusal(fileOf([note({ text: 'two\nlines' })]))).toMatch(/printable characters/)
    expect(refusal(fileOf([{ ...note(), text: '' }]))).toMatch(/non-empty string/)
  })

  test('refuses a record whose update is older than its creation', () => {
    expect(refusal(fileOf([note({ createdAt: AT + 1, updatedAt: AT })]))).toMatch(/older than createdAt/)
  })

  test('refuses evidence that is absent, repeated, or too long a list', () => {
    expect(refusal(fileOf([{ ...note(), evidence: [] }]))).toMatch(/non-empty list/)
    expect(refusal(fileOf([note({ evidence: [evidence(), evidence()] })]))).toMatch(/carries the event key "inst:1" twice/)
    const many = Array.from({ length: 17 }, (_, index) => evidence({ eventKey: `inst:${index}` }))
    expect(refusal(fileOf([note({ evidence: many })]))).toMatch(/more than 16 entries/)
  })

  test('refuses a file with more records than one subject may hold', () => {
    const many = Array.from({ length: IMPRESSION_RECORDS_MAX + 1 }, (_, index) => note({ text: `note ${index}` }))
    expect(refusal(fileOf(many))).toMatch(/more than 64 entries/)
  })

  test('refuses the same id twice in one file', () => {
    expect(refusal(fileOf([note(), note()]))).toMatch(/carries the id/)
  })
})

describe('the store on disk', () => {
  const roots: string[] = []

  async function tempRoot(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsbot-impressions-'))
    roots.push(dir)
    return dir
  }

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  function pathOf(dir: string, kind: 'person' | 'group', subject: string): string {
    return join(dir, botDirectoryName(BOT), kind, `${subjectFileName(subject)}.json`)
  }

  test('writes one hashed file per subject, 0600 under a 0700 directory', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: BOT, now: () => AT })
    await store.load()
    const record = note()
    expect(await store.save(inputOf([record]))).toEqual({ ok: true })
    const path = pathOf(dir, 'person', 'alice')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700)
    const written = JSON.parse(await readFile(path, 'utf8')) as ImpressionFile
    expect(written.touchedAt).toBe(AT)
    expect(written.records).toEqual([record])
    expect(await store.read('person', 'alice')).toEqual({ ok: true, records: [record] })
  })

  test('creates nothing at mount, so a wrong path surfaces on the first write', async () => {
    const dir = await tempRoot()
    await new ImpressionStore({ dir, bot: BOT }).load()
    await expect(stat(join(dir, botDirectoryName(BOT)))).rejects.toThrow()
  })

  test('reads back what another instance wrote', async () => {
    const dir = await tempRoot()
    const writer = new ImpressionStore({ dir, bot: BOT })
    await writer.load()
    const record = note({ scope: 'group', groupKey: 'chan-a|group:100' })
    expect(await writer.save(inputOf([record]))).toEqual({ ok: true })
    const reader = new ImpressionStore({ dir, bot: BOT })
    await reader.load()
    expect(await reader.read('person', 'alice')).toEqual({ ok: true, records: [record] })
    expect(reader.stats()).toEqual({ subjects: 1, records: 1 })
  })

  test('refuses a corrupt file, naming it, instead of rebuilding it', async () => {
    const dir = await tempRoot()
    const path = pathOf(dir, 'person', 'alice')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, '{not json', { mode: 0o600 })
    await expect(new ImpressionStore({ dir, bot: BOT }).load()).rejects.toThrow(path)
  })

  test('refuses a file from a newer version', async () => {
    const dir = await tempRoot()
    const path = pathOf(dir, 'person', 'alice')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, JSON.stringify({ ...fileOf([note()]), version: 2 }), { mode: 0o600 })
    await expect(new ImpressionStore({ dir, bot: BOT }).load()).rejects.toThrow(/version 2/)
  })

  test('refuses a symlinked file instead of following it', async () => {
    const dir = await tempRoot()
    const outside = join(dir, 'outside.json')
    await writeFile(outside, JSON.stringify(fileOf([note()])), { mode: 0o600 })
    const path = pathOf(dir, 'person', 'alice')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await symlink(outside, path)
    await expect(new ImpressionStore({ dir, bot: BOT }).load()).rejects.toThrow(/symlink/)
  })

  test('removes a leftover temp file with one warn and never reads it', async () => {
    const dir = await tempRoot()
    const path = pathOf(dir, 'person', 'alice')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(`${path}.tmp`, 'half a write', { mode: 0o600 })
    const warnings: string[] = []
    const store = new ImpressionStore({ dir, bot: BOT, warn: (message) => warnings.push(message) })
    await store.load()
    expect(warnings.some((message) => message.includes('leftover impression temp'))).toBe(true)
    expect((await readdir(dirname(path))).length).toBe(0)
  })

  test('ignores entries that are not subject files', async () => {
    const dir = await tempRoot()
    const path = join(dir, botDirectoryName(BOT), 'person', 'notes.txt')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFile(path, 'not a subject file', { mode: 0o600 })
    const store = new ImpressionStore({ dir, bot: BOT })
    await store.load()
    expect(store.stats()).toEqual({ subjects: 0, records: 0 })
  })

  test('reports a wide file on read instead of fixing it at mount', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: BOT })
    await store.load()
    await store.save(inputOf([note()]))
    const path = pathOf(dir, 'person', 'alice')
    await chmod(path, 0o644)
    const warnings: string[] = []
    const reader = new ImpressionStore({ dir, bot: BOT, warn: (message) => warnings.push(message) })
    await reader.load()
    const result = await reader.read('person', 'alice')
    expect(result).toEqual({ ok: false, code: 'storage_error', reason: expect.stringContaining('wider than 600') })
    expect(warnings.some((message) => message.includes('wider than 600'))).toBe(true)
  })

  test('reports a write that cannot land instead of throwing into a turn', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: BOT })
    await store.load()
    const path = pathOf(dir, 'person', 'alice')
    await mkdir(path, { recursive: true, mode: 0o700 })
    const result = await store.save(inputOf([note()]))
    expect(result).toEqual({ ok: false, code: 'storage_error', reason: expect.stringContaining('not a regular file') })
    expect(await readdir(dirname(path))).toEqual([subjectFileName('alice') + '.json'])
  })

  test('queues writes to one file so two concurrent saves settle on one valid file', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: BOT })
    await store.load()
    const first = inputOf([note({ text: 'first note' })])
    const second = inputOf([note({ text: 'second note' })])
    const results = await Promise.all([store.save(first), store.save(second)])
    expect(results).toEqual([{ ok: true }, { ok: true }])
    const reader = new ImpressionStore({ dir, bot: BOT })
    await reader.load()
    const read = await reader.read('person', 'alice')
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    expect(read.records.length).toBe(1)
    expect(['first note', 'second note']).toContain(read.records[0]!.text)
  })

  test('warns about a root directory that is merely readable, and refuses a writable one', async () => {
    const readable = await tempRoot()
    await chmod(readable, 0o755)
    const warnings: string[] = []
    const store = new ImpressionStore({ dir: readable, bot: BOT, warn: (message) => warnings.push(message) })
    await store.load()
    expect(warnings.some((message) => message.includes('readable beyond its owner'))).toBe(true)

    const writable = await tempRoot()
    await chmod(writable, 0o777)
    await expect(new ImpressionStore({ dir: writable, bot: BOT }).load()).rejects.toThrow(/writable beyond its owner/)
  })

  test('refuses a leaf directory that is wider than 0700', async () => {
    const dir = await tempRoot()
    const store = new ImpressionStore({ dir, bot: BOT })
    await store.load()
    await store.save(inputOf([note()]))
    const leaf = dirname(pathOf(dir, 'person', 'alice'))
    await chmod(leaf, 0o755)
    const result = await store.read('person', 'alice')
    expect(result).toEqual({ ok: false, code: 'storage_error', reason: expect.stringContaining('wider than 700') })
    const saved = await store.save(inputOf([note({ text: 'another' })]))
    expect(saved).toEqual({ ok: false, code: 'storage_error', reason: expect.stringContaining('wider than 700') })
  })
})
