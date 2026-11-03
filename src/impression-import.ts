import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { IMPRESSION_TEXT_MAX, impressionId } from './impressions.js'
import type { Impression, ImpressionImport, ImpressionStore } from './impressions.js'

const BULLET = /^-\s+(.*)$/
const HEADING = /^#{1,6}\s/
const LINK = /\[\[[^\]]+\]\]/
const METADATA = /\[[a-z][a-z0-9_-]*:[^\]]*\]/gi
const IMPORT_SESSION = 'memory-import'
const IMPORT_CONFIDENCE = 0.4

export interface MemoryLines {
  lines: string[]
  skipped: number
}

export interface ImportCounts {
  imported: number
  skipped: number
  topics: number
}

export type ImportOutcome = { ok: true; counts: ImportCounts } | { ok: false; reason: 'unreadable'; path: string }

/** Reads the bullet lines of a host memory file; headings, links and long lines are counted out. */
export function parseMemoryFile(text: string): MemoryLines {
  const lines: string[] = []
  let skipped = 0
  let inIndex = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) continue
    if (HEADING.test(line)) {
      inIndex = /^##\s+index\b/i.test(line)
      skipped += 1
      continue
    }
    if (inIndex || LINK.test(line)) {
      skipped += 1
      continue
    }
    const bullet = BULLET.exec(line)
    if (bullet === null) {
      skipped += 1
      continue
    }
    const said = bullet[1]!.replace(METADATA, '').trim()
    if (said.length === 0 || said.length > IMPRESSION_TEXT_MAX) {
      skipped += 1
      continue
    }
    lines.push(said)
  }
  return { lines, skipped }
}

async function countTopics(path: string): Promise<number> {
  try {
    const entries = await readdir(dirname(path), { withFileTypes: true })
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.md') && entry.name !== basename(path)).length
  } catch {
    return 0
  }
}

/** Imports a host memory file once: content-derived ids make a second run a no-op. */
export async function importMemory(options: {
  store: ImpressionStore
  bot: string
  config: ImpressionImport
  now: number
}): Promise<ImportOutcome> {
  const { store, bot, config, now } = options
  let source: string
  try {
    source = await readFile(config.path, 'utf8')
  } catch {
    return { ok: false, reason: 'unreadable', path: config.path }
  }
  const parsed = parseMemoryFile(source)
  const topics = await countTopics(config.path)
  const subjectKind = 'personId' in config.as ? ('person' as const) : ('group' as const)
  const subject = 'personId' in config.as ? config.as.personId : config.as.groupKey
  const scope = subjectKind === 'group' ? ('group' as const) : ('c2c' as const)
  const groupKey = subjectKind === 'group' ? subject : undefined
  const current = await store.read(subjectKind, subject)
  if (!current.ok) return { ok: true, counts: { imported: 0, skipped: parsed.skipped, topics } }
  const known = new Set(current.records.map((record) => record.id))
  const fresh = parsed.lines
    .map((text) => ({
      id: impressionId({ subjectKind, subject, scope, groupKey, kind: 'fact', text }),
      text,
    }))
    .filter((entry) => !known.has(entry.id))
  if (fresh.length > 0) {
    const records: Impression[] = fresh.map((entry) => ({
      id: entry.id,
      subject,
      subjectKind,
      scope,
      ...(groupKey === undefined ? {} : { groupKey }),
      text: entry.text,
      kind: 'fact',
      confidence: IMPORT_CONFIDENCE,
      share: 'local',
      evidence: [
        {
          eventKey: `memory-import:${createHash('sha256').update(entry.text, 'utf8').digest('hex')}`,
          sessionKey: IMPORT_SESSION,
          channel: IMPORT_SESSION,
          at: now,
        },
      ],
      bot,
      createdAt: now,
      updatedAt: now,
    }))
    await store.transact(subjectKind, subject, (kept) => [...kept, ...records])
  }
  return { ok: true, counts: { imported: fresh.length, skipped: parsed.skipped, topics } }
}
