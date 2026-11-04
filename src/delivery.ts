import { ConfigError } from './config.js'

export interface SplitSettings {
  byBlankLine: boolean
  maxParts: number
  maxChars: number
}

export interface PacingSettings {
  charsPerSecond: number
  minMs: number
  maxMs: number
}

export interface DeliverySettings {
  split: SplitSettings
  pacing: PacingSettings
}

export const DEFAULT_DELIVERY: DeliverySettings = {
  split: { byBlankLine: true, maxParts: 4, maxChars: 0 },
  pacing: { charsPerSecond: 14, minMs: 700, maxMs: 5_000 },
}

function record(value: unknown, path: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError(`${path.join('.')} must be an object`, path)
  }
  return value as Record<string, unknown>
}

function whole(value: unknown, path: string[], atLeast: number, field: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < atLeast) {
    throw new ConfigError(`${path.join('.')}.${field} must be a whole number of at least ${atLeast}: ${String(value)}`, [
      ...path,
      field,
    ])
  }
  return value
}

/** Code points, so a surrogate pair and a CRLF count as the text reads. */
function codepoints(text: string): string[] {
  return Array.from(text)
}

/** Code point range of one part inside the text a reply is cut from. */
export interface DeliverySpan {
  start: number
  end: number
}

/** Splits a reply into parts and paces them; one object per adapter, absent when the block is off. */
export class Delivery {
  readonly settings: DeliverySettings

  constructor(settings: DeliverySettings) {
    this.settings = settings
  }

  /** The text the parts are cut from: the reply without its leading and trailing blank lines. */
  scope(text: string): string {
    return text.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/(?:\r?\n[ \t]*)+$/, '')
  }

  /** The parts a reply is sent as, as ranges of the scoped text, merged into the last when too many. */
  spans(text: string): DeliverySpan[] {
    const split = this.settings.split
    const scope = this.scope(text)
    if (scope.length === 0) return []
    const chars = codepoints(scope)
    const pieces: DeliverySpan[] = []
    const paragraphs = split.byBlankLine ? paragraphRanges(scope) : [{ start: 0, end: scope.length }]
    for (const paragraph of paragraphs) {
      const start = codepoints(scope.slice(0, paragraph.start)).length
      const end = start + codepoints(scope.slice(paragraph.start, paragraph.end)).length
      if (end <= start) continue
      if (split.maxChars === 0) {
        pieces.push({ start, end })
        continue
      }
      let index = start
      while (index < end) {
        let cut = Math.min(index + split.maxChars, end)
        if (cut < end && chars[cut - 1] === '\r' && chars[cut] === '\n') cut -= 1
        pieces.push({ start: index, end: cut })
        index = cut
      }
    }
    if (pieces.length === 0) return []
    if (pieces.length <= split.maxParts) return pieces
    const last = pieces[pieces.length - 1]!
    return [...pieces.slice(0, split.maxParts - 1), { start: pieces[split.maxParts - 1]!.start, end: last.end }]
  }

  /** The parts a reply is sent as; joining them with the gaps between them gives the scoped text. */
  parts(text: string): string[] {
    const chars = codepoints(this.scope(text))
    return this.spans(text).map((span) => chars.slice(span.start, span.end).join(''))
  }

  /** How long to wait before the next part, from its own length. */
  gapMs(part: string): number {
    const pacing = this.settings.pacing
    const wanted = Math.round((codepoints(part).length / pacing.charsPerSecond) * 1_000)
    return Math.min(pacing.maxMs, Math.max(pacing.minMs, wanted))
  }
}

/** Paragraph ranges in UTF-16 offsets; the blank line between them is not part of either. */
function paragraphRanges(text: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  const blank = /\r?\n[ \t]*\r?\n/g
  let cursor = 0
  for (;;) {
    const match = blank.exec(text)
    if (match === null) break
    ranges.push({ start: cursor, end: match.index })
    cursor = match.index + match[0].length
  }
  ranges.push({ start: cursor, end: text.length })
  return ranges
}

/** Reads the delivery block; undefined means the profile turned it off. */
export function compileDelivery(
  raw: unknown,
  pathFor: (key: 'split' | 'pacing') => string[],
): Delivery | undefined {
  if (raw === undefined) return undefined
  const block = record(raw, ['delivery'])
  if (Object.keys(block).length === 0) return undefined
  const splitRaw = block.split === undefined ? {} : record(block.split, [...pathFor('split')])
  const pacingRaw = block.pacing === undefined ? {} : record(block.pacing, [...pathFor('pacing')])
  const splitPath = pathFor('split')
  const pacingPath = pathFor('pacing')
  const split: SplitSettings = {
    byBlankLine:
      splitRaw.byBlankLine === undefined
        ? DEFAULT_DELIVERY.split.byBlankLine
        : splitRaw.byBlankLine === true
          ? true
          : splitRaw.byBlankLine === false
            ? false
            : (() => {
                throw new ConfigError(`${splitPath.join('.')}.byBlankLine must be true or false`, [
                  ...splitPath,
                  'byBlankLine',
                ])
              })(),
    maxParts: whole(splitRaw.maxParts, splitPath, 1, 'maxParts') ?? DEFAULT_DELIVERY.split.maxParts,
    maxChars: whole(splitRaw.maxChars, splitPath, 0, 'maxChars') ?? DEFAULT_DELIVERY.split.maxChars,
  }
  const charsPerSecond = pacingRaw.charsPerSecond
  if (
    charsPerSecond !== undefined &&
    (typeof charsPerSecond !== 'number' || !Number.isFinite(charsPerSecond) || charsPerSecond <= 0)
  ) {
    throw new ConfigError(`${pacingPath.join('.')}.charsPerSecond must be a number above 0: ${String(charsPerSecond)}`, [
      ...pacingPath,
      'charsPerSecond',
    ])
  }
  const pacing: PacingSettings = {
    charsPerSecond:
      (charsPerSecond as number | undefined) ?? DEFAULT_DELIVERY.pacing.charsPerSecond,
    minMs: whole(pacingRaw.minMs, pacingPath, 0, 'minMs') ?? DEFAULT_DELIVERY.pacing.minMs,
    maxMs: whole(pacingRaw.maxMs, pacingPath, 0, 'maxMs') ?? DEFAULT_DELIVERY.pacing.maxMs,
  }
  if (pacing.maxMs < pacing.minMs) {
    throw new ConfigError(
      `${pacingPath.join('.')}.maxMs must be at least minMs: ${pacing.maxMs} < ${pacing.minMs}`,
      [...pacingPath, 'maxMs'],
    )
  }
  return new Delivery({ split, pacing })
}
