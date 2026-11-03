import { IMPRESSION_INJECT_CUTOFF, effectiveConfidence } from './impressions.js'
import type { Impression } from './impressions.js'

export const IMPRESSION_HEADER = '[impressions] what this bot noted'

/** What a turn may see: the author's own notes plus, in a group, the group archive. */
export interface ImpressionContext {
  personId: string | null
  inGroup: boolean
  groupKey: string
}

/** Picks the records this turn may read; another group's notes and c2c notes stay out. */
export function pickImpressions(
  person: readonly Impression[],
  archive: readonly Impression[],
  context: ImpressionContext,
): Impression[] {
  const picked: Impression[] = context.inGroup ? [...archive] : []
  if (context.personId === null) return picked
  for (const record of person) {
    if (record.share === 'cross') {
      picked.push(record)
      continue
    }
    if (context.inGroup) {
      if (record.scope === 'group' && record.groupKey === context.groupKey) picked.push(record)
    } else if (record.scope === 'c2c') {
      picked.push(record)
    }
  }
  return picked
}

/** Renders whole lines, strongest first, until the block no longer fits the budget. */
export function renderImpressionBlock(records: readonly Impression[], now: number, chars: number): string {
  if (chars <= 0) return ''
  const ranked = records
    .map((record) => ({ record, effective: effectiveConfidence(record.confidence, record.updatedAt, now) }))
    .filter((entry) => entry.effective >= IMPRESSION_INJECT_CUTOFF)
    .sort((left, right) => right.effective - left.effective || right.record.updatedAt - left.record.updatedAt)
  let text = IMPRESSION_HEADER
  for (const entry of ranked) {
    const label = entry.record.subjectKind === 'group' ? '- [group] ' : '- '
    const candidate = `${text}\n${label}${entry.record.text}`
    if (candidate.length > chars) break
    text = candidate
  }
  return text === IMPRESSION_HEADER ? '' : text
}
