import { describe, expect, test } from 'vitest'
import { GroupBuffer, oneLine } from '../src/group-buffer.js'
import type { BufferedMessage } from '../src/group-buffer.js'

function note(eventKey: string, text: string, at = 1): BufferedMessage {
  return { eventKey, senderId: 'u1', at, text, media: [] }
}

describe('a group buffer', () => {
  test('keeps the last thirty messages by default', () => {
    const buffer = new GroupBuffer()
    for (let index = 0; index < 35; index += 1) buffer.record('g', note(`e-${index}`, `m${index}`))

    const kept = buffer.entries('g')
    expect(kept).toHaveLength(30)
    expect(kept[0]!.eventKey).toBe('e-5')
    expect(kept[29]!.eventKey).toBe('e-34')
  })

  test('honours a smaller ring and keeps the newest', () => {
    const buffer = new GroupBuffer({ messages: 2 })
    buffer.record('g', note('a', 'one'))
    buffer.record('g', note('b', 'two'))
    buffer.record('g', note('c', 'three'))

    expect(buffer.entries('g').map((one) => one.eventKey)).toEqual(['b', 'c'])
  })

  test('records nothing when it is turned off', () => {
    const buffer = new GroupBuffer({ messages: 0 })
    buffer.record('g', note('a', 'one'))

    expect(buffer.entries('g')).toEqual([])
  })

  test('flattens a message to one line and cuts it to 240 characters', () => {
    const buffer = new GroupBuffer()
    buffer.record('g', note('a', `first line\nsecond   line\t${'x'.repeat(400)}`))

    const [kept] = buffer.entries('g')
    expect(kept!.text.startsWith('first line second line ')).toBe(true)
    expect(kept!.text).not.toContain('\n')
    expect(kept!.text).toHaveLength(240)
    expect(oneLine('  a  ')).toBe('a')
  })

  test('drops the oldest whole message when the text no longer fits', () => {
    const buffer = new GroupBuffer({ chars: 12 })
    buffer.record('g', note('a', 'aaaaa'))
    buffer.record('g', note('b', 'bbbbb'))
    buffer.record('g', note('c', 'ccccc'))

    expect(buffer.entries('g').map((one) => one.eventKey)).toEqual(['b', 'c'])
  })

  test('leaves out every key this turn already carries', () => {
    const buffer = new GroupBuffer()
    buffer.record('g', note('a', 'one', 10))
    buffer.record('g', note('b', 'two', 20))
    buffer.record('g', note('c', 'three', 30))

    expect(buffer.entries('g', ['a', 'c']).map((one) => one.eventKey)).toEqual(['b'])
    expect(buffer.entries('g', ['a', 'b', 'c'])).toEqual([])
  })

  test('keeps each conversation apart', () => {
    const buffer = new GroupBuffer()
    buffer.record('g1', note('a', 'one'))
    buffer.record('g2', note('b', 'two'))

    expect(buffer.entries('g1').map((one) => one.eventKey)).toEqual(['a'])
    expect(buffer.entries('g2').map((one) => one.eventKey)).toEqual(['b'])
  })

  test('leaves a conversation out once a hundred are held', () => {
    const buffer = new GroupBuffer({ messages: 1 })
    for (let index = 0; index < 100; index += 1) buffer.record(`g-${index}`, note(`e-${index}`, 'x'))
    buffer.record('g-100', note('new', 'y'))

    expect(buffer.entries('g-0')).toHaveLength(1)
    expect(buffer.entries('g-100')).toEqual([])
  })
})
