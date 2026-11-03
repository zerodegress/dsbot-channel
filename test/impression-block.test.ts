import { describe, expect, test } from 'vitest'
import { IMPRESSION_HEADER, pickImpressions, renderImpressionBlock } from '../src/impression-block.js'
import { impressionId } from '../src/impressions.js'
import type { Impression, ImpressionEvidence } from '../src/impressions.js'

const AT = 1_700_000_000_000
const DAY = 86_400_000
const GROUP = 'x:a|group:12345'

function evidence(): ImpressionEvidence {
  return { eventKey: 'inst:1', sessionKey: 'group:12345', channel: 'x:a', at: AT }
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
    bot: 'bot-a',
    createdAt: AT,
    updatedAt: AT,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, id: impressionId(merged) }
}

function groupNote(text: string): Impression {
  return note({ subject: GROUP, subjectKind: 'group', scope: 'group', groupKey: GROUP, kind: 'topic', text })
}

describe('picking what a turn may read', () => {
  const c2c = note({ text: 'private note' })
  const otherGroup = note({ text: 'other group note', scope: 'group', groupKey: 'x:a|group:999' })
  const thisGroup = note({ text: 'this group note', scope: 'group', groupKey: GROUP })
  const cross = note({ text: 'goes by Ali', kind: 'address', share: 'cross' })
  const archive = groupNote('release day is Friday')
  const person = [c2c, otherGroup, thisGroup, cross]
  const groupArchive = [archive]

  test('keeps a private turn to this author’s c2c and cross notes', () => {
    const picked = pickImpressions(person, groupArchive, { personId: 'alice', inGroup: false, groupKey: GROUP })
    expect(picked.map((record) => record.text).sort()).toEqual(['goes by Ali', 'private note'])
  })

  test('keeps a group turn to this group, its archive and cross notes', () => {
    const picked = pickImpressions(person, groupArchive, { personId: 'alice', inGroup: true, groupKey: GROUP })
    expect(picked.map((record) => record.text).sort()).toEqual([
      'goes by Ali',
      'release day is Friday',
      'this group note',
    ])
  })

  test('gives an unbound author only the group archive', () => {
    const picked = pickImpressions(person, groupArchive, { personId: null, inGroup: true, groupKey: GROUP })
    expect(picked.map((record) => record.text)).toEqual(['release day is Friday'])
  })
})

describe('rendering the block', () => {
  test('labels archive lines and sorts the strongest first', () => {
    const block = renderImpressionBlock(
      [note({ text: 'weaker', confidence: 0.4 }), groupNote('release day is Friday'), note({ text: 'stronger', confidence: 0.9 })],
      AT,
      400,
    )
    expect(block.split('\n')).toEqual([
      IMPRESSION_HEADER,
      '- stronger',
      '- [group] release day is Friday',
      '- weaker',
    ])
  })

  test('drops whole lines from the weakest until the block fits', () => {
    const first = note({ text: 'first line', confidence: 0.9 })
    const second = note({ text: 'second line', confidence: 0.5 })
    const budget = IMPRESSION_HEADER.length + 1 + '- first line'.length
    expect(renderImpressionBlock([first, second], AT, budget)).toBe(`${IMPRESSION_HEADER}\n- first line`)
  })

  test('adds nothing when even the header does not fit, and never cuts a line', () => {
    expect(renderImpressionBlock([note()], AT, IMPRESSION_HEADER.length - 1)).toBe('')
    expect(renderImpressionBlock([note({ text: 'a much longer line than the budget allows' })], AT, IMPRESSION_HEADER.length + 5)).toBe('')
    expect(renderImpressionBlock([note()], AT, 0)).toBe('')
  })

  test('leaves out a note whose confidence has decayed below the cutoff', () => {
    expect(renderImpressionBlock([note({ confidence: 0.9 })], AT + 400 * DAY, 400)).toBe('')
  })
})
