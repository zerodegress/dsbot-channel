import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ImpressionStore } from '../src/impressions.js'
import { createImpressionForget, createImpressionGet, createImpressionPut } from '../src/impression-tools.js'
import type { ImpressionPorts } from '../src/impression-tools.js'
import type { TurnRef } from '../src/control-tools.js'

const AT = 1_700_000_000_000
const DAY = 86_400_000

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function harness(turn: Partial<TurnRef> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsbot-impression-tools-'))
  roots.push(dir)
  const clock = { now: AT }
  const ref: TurnRef = {
    eventId: 'req-1',
    eventKey: 'inst:1',
    eventKeys: ['inst:1'],
    chainId: 'chain-1',
    channel: 'chan-a',
    target: '100',
    sender: '10001',
    bot: 'bot-a',
    sessionKey: 'group:100',
    kind: 'onebot',
    scope: 'group',
    personId: 'alice',
    suppressed: false,
    pushed: false,
    ...turn,
  }
  const store = new ImpressionStore({ dir, bot: 'bot-a', now: () => clock.now })
  await store.load()
  const stores = new Map([['bot-a', store]])
  const ports: ImpressionPorts = {
    storeOf: (bot) => stores.get(bot),
    turnOf: (sessionId) => (sessionId === 'session-1' ? ref : undefined),
    now: () => clock.now,
  }
  const exec = (sessionId = 'session-1') => ({ agent: { id: sessionId } }) as never
  return { dir, clock, ref, store, ports, exec }
}

function parse(raw: unknown): Record<string, unknown> {
  return JSON.parse(String(raw)) as Record<string, unknown>
}

describe('impression_put', () => {
  test('stores a note about the turn author with every message of the batch as evidence', async () => {
    const h = await harness({ eventKeys: ['inst:1', 'inst:2'] })
    const result = parse(
      await createImpressionPut(h.ports).execute({ text: 'alice ships on Fridays', kind: 'fact' }, h.exec()),
    )
    expect(result).toEqual({ ok: true, id: expect.any(String), records: 1 })
    expect(String(result.id)).toHaveLength(32)
    expect(JSON.stringify(result)).not.toContain('Fridays')

    const read = await h.store.read('person', 'alice')
    expect(read.ok).toBe(true)
    if (!read.ok) throw new Error(read.reason)
    const record = read.records[0]!
    expect(record.scope).toBe('group')
    expect(record.groupKey).toBe('chan-a|group:100')
    expect(record.evidence.map((entry) => entry.eventKey)).toEqual(['inst:1', 'inst:2'])
    expect(record.evidence[0]!.channel).toBe('chan-a')
  })

  test('writes a repeat as the same record with more evidence', async () => {
    const h = await harness()
    const put = createImpressionPut(h.ports)
    await put.execute({ text: 'alice prefers short answers', kind: 'manner' }, h.exec())
    h.clock.now = AT + 5_000
    h.ref.eventKeys = ['inst:2']
    const again = parse(await put.execute({ text: 'alice prefers short answers', kind: 'manner' }, h.exec()))
    expect(again.records).toBe(1)

    const read = await h.store.read('person', 'alice')
    if (!read.ok) throw new Error(read.reason)
    expect(read.records).toHaveLength(1)
    expect(read.records[0]!.evidence.map((entry) => entry.eventKey)).toEqual(['inst:1', 'inst:2'])
    expect(read.records[0]!.updatedAt).toBe(AT + 5_000)
  })

  test('refuses an unbound author, a peer turn, and anything outside the note bounds', async () => {
    const unbound = await harness({ personId: null })
    expect(parse(await createImpressionPut(unbound.ports).execute({ text: 'x', kind: 'fact' }, unbound.exec()))).toMatchObject({
      ok: false,
      code: 'no_identity',
    })

    const peer = await harness({ kind: 'p2p' })
    expect(parse(await createImpressionPut(peer.ports).execute({ text: 'x', kind: 'fact' }, peer.exec()))).toMatchObject({
      ok: false,
      code: 'unsupported',
    })

    const h = await harness()
    const put = createImpressionPut(h.ports)
    for (const args of [
      { text: '', kind: 'fact' },
      { text: 'x'.repeat(241), kind: 'fact' },
      { text: 'two\nlines', kind: 'fact' },
      { text: 'x', kind: 'junk' },
      { text: 'x', kind: 'fact', share: 'cross' },
    ]) {
      expect(parse(await put.execute(args as never, h.exec()))).toMatchObject({ ok: false, code: 'unsupported_argument' })
    }
  })

  test('clamps confidence, defaults it, and gates cross sharing by kind', async () => {
    const h = await harness()
    const put = createImpressionPut(h.ports)
    await put.execute({ text: 'default confidence', kind: 'fact' }, h.exec())
    await put.execute({ text: 'loud confidence', kind: 'fact', confidence: 4 }, h.exec())
    await put.execute({ text: 'polite form', kind: 'manner', share: 'cross' }, h.exec())
    const read = await h.store.read('person', 'alice')
    if (!read.ok) throw new Error(read.reason)
    const byText = new Map(read.records.map((record) => [record.text, record]))
    expect(byText.get('default confidence')!.confidence).toBe(0.6)
    expect(byText.get('loud confidence')!.confidence).toBe(1)
    expect(byText.get('polite form')!.share).toBe('cross')
  })

  test('keeps the group archive apart from notes about its members', async () => {
    const h = await harness()
    const put = createImpressionPut(h.ports)
    await put.execute({ text: 'the group plans on Mondays', kind: 'topic', about: 'group' }, h.exec())
    const archive = await h.store.read('group', 'chan-a|group:100')
    if (!archive.ok) throw new Error(archive.reason)
    expect(archive.records[0]!.subjectKind).toBe('group')
    expect(archive.records[0]!.text).toBe('the group plans on Mondays')
    const person = await h.store.read('person', 'alice')
    if (!person.ok) throw new Error(person.reason)
    expect(person.records).toHaveLength(0)
  })

  test('refuses a group archive outside a group turn', async () => {
    const h = await harness({ scope: 'c2c', sessionKey: 'peer:100' })
    const result = parse(
      await createImpressionPut(h.ports).execute({ text: 'x', kind: 'topic', about: 'group' }, h.exec()),
    )
    expect(result).toMatchObject({ ok: false, code: 'unsupported' })
  })

  test('is refused outside a turn', async () => {
    const h = await harness()
    await expect(createImpressionPut(h.ports).execute({ text: 'x', kind: 'fact' }, h.exec('other'))).rejects.toThrow(
      'this tool is only available while answering a message',
    )
  })
})

describe('impression_get', () => {
  test('reads one partition with decayed confidence and no evidence keys', async () => {
    const h = await harness()
    await createImpressionPut(h.ports).execute({ text: 'alice is the release manager', kind: 'fact' }, h.exec())
    const result = parse(await createImpressionGet(h.ports).execute({ scope: 'group' }, h.exec()))
    expect(result.ok).toBe(true)
    const records = result.records as Record<string, unknown>[]
    expect(records).toHaveLength(1)
    expect(records[0]).toEqual({
      id: expect.any(String),
      text: 'alice is the release manager',
      kind: 'fact',
      effectiveConfidence: 0.6,
      updatedAt: AT,
    })
    expect(records[0]).not.toHaveProperty('evidence')
  })

  test('keeps c2c notes out of a group turn, while cross notes travel', async () => {
    const h = await harness({ scope: 'c2c', sessionKey: 'peer:100' })
    await createImpressionPut(h.ports).execute({ text: 'alice likes tea', kind: 'fact' }, h.exec())
    await createImpressionPut(h.ports).execute({ text: 'alice goes by Ali', kind: 'address', share: 'cross' }, h.exec())

    h.ref.scope = 'group'
    h.ref.sessionKey = 'group:100'
    expect(parse(await createImpressionGet(h.ports).execute({ scope: 'c2c' }, h.exec()))).toMatchObject({
      ok: false,
      code: 'unsupported',
    })
    const cross = parse(await createImpressionGet(h.ports).execute({ scope: 'cross' }, h.exec()))
    expect(cross.ok).toBe(true)
    expect((cross.records as Record<string, unknown>[]).map((record) => record.text)).toEqual(['alice goes by Ali'])
  })

  test('stops offering a note after its confidence decays below the cutoff', async () => {
    const h = await harness()
    await createImpressionPut(h.ports).execute({ text: 'alice joined in spring', kind: 'fact' }, h.exec())
    h.clock.now = AT + 180 * DAY
    const decayed = parse(await createImpressionGet(h.ports).execute({ scope: 'group' }, h.exec()))
    expect(decayed).toEqual({ ok: true, records: [] })
  })

  test('honours the limit and refuses an impossible one', async () => {
    const h = await harness()
    const put = createImpressionPut(h.ports)
    for (const text of ['one', 'two', 'three']) await put.execute({ text: `note ${text}`, kind: 'fact' }, h.exec())
    const two = parse(await createImpressionGet(h.ports).execute({ scope: 'group', limit: 2 }, h.exec()))
    expect((two.records as unknown[]).length).toBe(2)
    for (const limit of [0, 9, 1.5]) {
      expect(parse(await createImpressionGet(h.ports).execute({ scope: 'group', limit }, h.exec()))).toMatchObject({
        ok: false,
        code: 'unsupported_argument',
      })
    }
  })

  test('returns nothing for a peer turn', async () => {
    const h = await harness({ kind: 'p2p', scope: 'p2p' })
    expect(parse(await createImpressionGet(h.ports).execute({ scope: 'c2c' }, h.exec()))).toEqual({ ok: true, records: [] })
  })

  test('reads the group archive only with about "group"', async () => {
    const h = await harness()
    await createImpressionPut(h.ports).execute({ text: 'the group plans on Mondays', kind: 'topic', about: 'group' }, h.exec())
    const result = parse(await createImpressionGet(h.ports).execute({ scope: 'group', about: 'group' }, h.exec()))
    expect(result.ok).toBe(true)
    expect((result.records as Record<string, unknown>[])[0]!.text).toBe('the group plans on Mondays')
  })
})

describe('impression_forget', () => {
  test('removes one id with its evidence, then reports the second attempt as not found', async () => {
    const h = await harness()
    const put = await createImpressionPut(h.ports).execute({ text: 'alice is the release manager', kind: 'fact' }, h.exec())
    const id = parse(put).id as string
    const forgotten = parse(await createImpressionForget(h.ports).execute({ id }, h.exec()))
    expect(forgotten).toEqual({ ok: true, removed: 1 })
    const empty = await h.store.read('person', 'alice')
    expect(empty).toEqual({ ok: true, records: [] })
    expect(parse(await createImpressionForget(h.ports).execute({ id }, h.exec()))).toMatchObject({ ok: false, code: 'not_found' })
  })

  test('forgets everything about a subject', async () => {
    const h = await harness()
    const put = createImpressionPut(h.ports)
    await put.execute({ text: 'one', kind: 'fact' }, h.exec())
    await put.execute({ text: 'two', kind: 'fact' }, h.exec())
    const all = parse(await createImpressionForget(h.ports).execute({ all: true }, h.exec()))
    expect(all).toEqual({ ok: true, removed: 2 })
  })

  test('requires an id or all: true', async () => {
    const h = await harness()
    expect(parse(await createImpressionForget(h.ports).execute({}, h.exec()))).toMatchObject({
      ok: false,
      code: 'unsupported_argument',
    })
  })
})
