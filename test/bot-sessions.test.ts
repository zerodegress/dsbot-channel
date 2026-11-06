import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { SessionAnchor } from '../src/bot-sessions.js'

const made: string[] = []
const dirs = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'anchor-'))
  made.push(dir)
  return dir
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(made.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

const writeState = async (dir: string, bots: unknown): Promise<string> => {
  const path = join(dir, 'state.json')
  await writeFile(path, JSON.stringify({ bots }), 'utf8')
  return path
}

const bot = (name: string, id: string, sessionId?: string, segments?: unknown[]): Record<string, unknown> => ({
  name,
  id,
  ...(sessionId === undefined ? {} : { sessionId }),
  ...(segments === undefined ? {} : { segments }),
})

const anchor = (path: string, extra: { botName?: string; session?: string } = {}): SessionAnchor =>
  new SessionAnchor({
    channel: 'p2p:a',
    warn: () => {},
    statePath: path,
    ...extra,
  })

describe('resolving a bot current segment', () => {
  test('prefers sessionId over id', async () => {
    const path = await writeState(await dirs(), { seal: bot('seal', 'session-a', 'session-b') })
    expect(await anchor(path, { botName: 'seal' }).resolve()).toEqual({ ok: true, sessionId: 'session-b' })
  })

  test('falls back to id when no segment is current', async () => {
    const path = await writeState(await dirs(), { other: bot('other', 'session-c') })
    expect(await anchor(path, { botName: 'other' }).resolve()).toEqual({ ok: true, sessionId: 'session-c' })
  })

  test('matches a bot by id when the name does not match', async () => {
    const path = await writeState(await dirs(), { any: bot('seal', 'session-a') })
    expect(await anchor(path, { botName: 'session-a' }).resolve()).toEqual({ ok: true, sessionId: 'session-a' })
  })

  test('a missing bot is unresolved', async () => {
    const path = await writeState(await dirs(), { any: bot('seal', 'session-a') })
    expect(await anchor(path, { botName: 'ghost' }).resolve()).toMatchObject({
      ok: false,
      code: 'session_unresolved',
    })
  })

  test('two bots of one name are ambiguous', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a'), two: bot('seal', 'session-b') })
    expect(await anchor(path, { botName: 'seal' }).resolve()).toMatchObject({
      ok: false,
      code: 'session_ambiguous',
    })
  })

  test('a current segment without an id is unresolved', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', '') })
    expect(await anchor(path, { botName: 'seal' }).resolve()).toMatchObject({
      ok: false,
      code: 'session_unresolved',
    })
  })

  test('a missing roster is unresolved on the first turn and warns once', async () => {
    const path = join(await dirs(), 'missing.json')
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', botName: 'seal', statePath: path, warn: (line) => lines.push(line) })
    expect(await subject.resolve()).toMatchObject({ ok: false, code: 'session_unresolved' })
    expect(await subject.resolve()).toMatchObject({ ok: false, code: 'session_unresolved' })
    expect(lines).toHaveLength(1)
  })

  test('after one success a missing roster keeps the last session without a warning', async () => {
    const dir = await dirs()
    const path = await writeState(dir, { one: bot('seal', 'session-a') })
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', botName: 'seal', statePath: path, warn: (line) => lines.push(line) })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    const { rm } = await import('node:fs/promises')
    await rm(path)
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(lines).toEqual([])
  })

  test('a failure keeps the last session and warns once until it recovers', async () => {
    const dir = await dirs()
    const path = await writeState(dir, { one: bot('seal', 'session-a') })
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', botName: 'seal', statePath: path, warn: (line) => lines.push(line) })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    await writeState(dir, { one: bot('other', 'session-b') })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(lines.filter((line) => line.includes('using the last session'))).toHaveLength(1)
    await writeState(dir, { one: bot('seal', 'session-c') })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-c' })
    await writeState(dir, { one: bot('other', 'session-b') })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-c' })
    expect(lines.filter((line) => line.includes('using the last session'))).toHaveLength(2)
  })

  test('a rollover moves the next turn to the new segment', async () => {
    const dir = await dirs()
    const path = await writeState(dir, { one: bot('seal', 'session-a', 'session-b') })
    const subject = anchor(path, { botName: 'seal' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-b' })
    await writeState(dir, { one: bot('seal', 'session-a', 'session-c') })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-c' })
  })
})

describe('a bot never takes two anchors', () => {
  test('a pinned session of a followed bot is a conflict', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a', 'session-b') })
    const subject = new SessionAnchor({
      channel: 'p2p:a',
      session: 'session-b',
      statePath: path,
      followed: ['seal'],
      warn: () => {},
    })
    expect(await subject.resolve()).toMatchObject({ ok: false, code: 'session_anchor_conflict' })
  })

  test('a pinned session of a bot nobody follows is fine', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a', 'session-b') })
    const subject = new SessionAnchor({
      channel: 'p2p:a',
      session: 'session-b',
      statePath: path,
      followed: ['other'],
      warn: () => {},
    })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-b' })
  })
})

describe('checking a pinned session', () => {
  test('a current segment passes', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a', 'session-b') })
    await expect(anchor(path, { session: 'session-b' }).mountCheck()).resolves.toBeUndefined()
  })

  test('a finished segment is stale', async () => {
    const path = await writeState(await dirs(), {
      one: bot('seal', 'session-a', 'session-b', [{ sessionId: 'session-a', endedAt: '2026-10-25T23:17:09Z' }]),
    })
    await expect(anchor(path, { session: 'session-a' }).mountCheck()).rejects.toThrow(/session_stale/)
  })

  test('an id left behind by a rollover is stale', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a', 'session-b') })
    await expect(anchor(path, { session: 'session-a' }).mountCheck()).rejects.toThrow(/session_stale/)
  })

  test('a session outside the roster is unknown', async () => {
    const path = await writeState(await dirs(), { one: bot('seal', 'session-a') })
    await expect(anchor(path, { session: 'session-z' }).mountCheck()).rejects.toThrow(/session_unknown/)
  })

  test('a missing roster passes quietly', async () => {
    const path = join(await dirs(), 'missing.json')
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', session: 'session-a', statePath: path, warn: (line) => lines.push(line) })
    await expect(subject.mountCheck()).resolves.toBeUndefined()
    expect(lines).toEqual([])
  })

  test('a corrupt roster warns instead of failing the mount', async () => {
    const dir = await dirs()
    const path = join(dir, 'state.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, '{not json', 'utf8')
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', session: 'session-a', statePath: path, warn: (line) => lines.push(line) })
    await expect(subject.mountCheck()).resolves.toBeUndefined()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('cannot verify pinned session')
  })

  test('a pinned session that later ends fails the turn as stale', async () => {
    const dir = await dirs()
    const path = await writeState(dir, { one: bot('seal', 'session-a', 'session-b') })
    const subject = anchor(path, { session: 'session-b' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-b' })
    await writeState(dir, { one: bot('seal', 'session-b', 'session-c', [{ sessionId: 'session-b', endedAt: '2026-10-25T23:17:09Z' }]) })
    expect(await subject.resolve()).toMatchObject({ ok: false, code: 'session_stale' })
  })

  test('a pinned turn survives a missing roster without noise', async () => {
    const path = join(await dirs(), 'missing.json')
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', session: 'session-a', statePath: path, warn: (line) => lines.push(line) })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(lines).toEqual([])
  })

  test('a pinned turn survives a corrupt roster with one warning', async () => {
    const dir = await dirs()
    const path = join(dir, 'state.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(path, 'not json', 'utf8')
    const lines: string[] = []
    const subject = new SessionAnchor({ channel: 'p2p:a', session: 'session-a', statePath: path, warn: (line) => lines.push(line) })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(await subject.resolve()).toEqual({ ok: true, sessionId: 'session-a' })
    expect(lines).toHaveLength(1)
  })
})
