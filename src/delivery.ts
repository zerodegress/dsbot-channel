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

/** Splits a reply into parts and paces them; one object per adapter, absent when the block is off. */
export class Delivery {
  readonly settings: DeliverySettings

  constructor(settings: DeliverySettings) {
    this.settings = settings
  }

  /** The parts a reply is sent as, merged into the last part when there are too many. */
  parts(text: string): string[] {
    const split = this.settings.split
    const pieces: { text: string; para: number }[] = []
    const paragraphs = split.byBlankLine ? text.split(/\r?\n[ \t]*\r?\n/) : [text]
    paragraphs.forEach((paragraph, para) => {
      const chars = codepoints(paragraph)
      if (chars.length === 0) return
      if (split.maxChars === 0) {
        pieces.push({ text: paragraph, para })
        return
      }
      let index = 0
      while (index < chars.length) {
        let end = Math.min(index + split.maxChars, chars.length)
        if (end < chars.length && chars[end - 1] === '\r' && chars[end] === '\n') end -= 1
        pieces.push({ text: chars.slice(index, end).join(''), para })
        index = end
      }
    })
    if (pieces.length === 0) return []
    if (pieces.length <= split.maxParts) return pieces.map((piece) => piece.text)
    const kept = pieces.slice(0, split.maxParts - 1).map((piece) => piece.text)
    const head = pieces[split.maxParts - 1]!
    let merged = head.text
    let previous = head.para
    for (const piece of pieces.slice(split.maxParts)) {
      merged += (piece.para === previous ? '' : '\n\n') + piece.text
      previous = piece.para
    }
    return [...kept, merged]
  }

  /** How long to wait before the next part, from its own length. */
  gapMs(part: string): number {
    const pacing = this.settings.pacing
    const wanted = Math.round((codepoints(part).length / pacing.charsPerSecond) * 1_000)
    return Math.min(pacing.maxMs, Math.max(pacing.minMs, wanted))
  }
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
