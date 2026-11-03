import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ConfigError } from './config.js'

/** On-disk shape version this package reads and writes. */
export const IMPRESSION_FILE_VERSION = 1 as const
/** Longest note kept, in characters. */
export const IMPRESSION_TEXT_MAX = 240
/** Records one subject file holds before the oldest goes. */
export const IMPRESSION_RECORDS_MAX = 64
/** Subject files one bot holds. */
export const IMPRESSION_SUBJECTS_MAX = 512
/** Evidence entries one record keeps. */
export const IMPRESSION_EVIDENCE_MAX = 16
/** Records one `impression_get` call returns. */
export const IMPRESSION_GET_MAX = 8
/** Confidence a write carries when the model names none. */
export const IMPRESSION_CONFIDENCE_DEFAULT = 0.6
/** Days after which a record's effective confidence halves. */
export const IMPRESSION_HALF_LIFE_DAYS = 90
/** No record decays below this effective confidence. */
export const IMPRESSION_CONFIDENCE_FLOOR = 0.1
/** Records below this effective confidence are not offered to a reader. */
export const IMPRESSION_INJECT_CUTOFF = 0.2
export const IMPRESSION_SUBJECT_MAX = 512
export const IMPRESSION_EVENT_KEY_MAX = 512
export const IMPRESSION_SESSION_KEY_MAX = 128
export const IMPRESSION_CHANNEL_MAX = 128

/** Only these may be shared across platforms. */
export const SHAREABLE_KINDS = ['address', 'language', 'taboo', 'manner'] as const
export type ImpressionShareableKind = (typeof SHAREABLE_KINDS)[number]
export type ImpressionKind = ImpressionShareableKind | 'fact' | 'topic' | 'member' | 'rule'
export const IMPRESSION_KINDS: readonly ImpressionKind[] = [...SHAREABLE_KINDS, 'fact', 'topic', 'member', 'rule']

export type ImpressionScope = 'c2c' | 'group'
export type ImpressionSubjectKind = 'person' | 'group'
export type ImpressionShare = 'local' | 'cross'
export type ImpressionFailureCode =
  | 'unsupported_argument'
  | 'no_identity'
  | 'unsupported'
  | 'not_found'
  | 'storage_error'

/** One message that supports a record; core stamps it, a model never supplies it. */
export interface ImpressionEvidence {
  eventKey: string
  sessionKey: string
  channel: string
  at: number
}

/** A note about one person or one group, with the evidence that produced it. */
export interface Impression {
  id: string
  subject: string
  subjectKind: ImpressionSubjectKind
  scope: ImpressionScope
  groupKey?: string | undefined
  text: string
  kind: ImpressionKind
  confidence: number
  share: ImpressionShare
  evidence: ImpressionEvidence[]
  bot: string
  createdAt: number
  updatedAt: number
}

/** One file per subject: everything this bot noted about one person or group. */
export interface ImpressionFile {
  version: typeof IMPRESSION_FILE_VERSION
  subject: string
  subjectKind: ImpressionSubjectKind
  /** Written with the injected clock, so eviction never trusts a filesystem mtime. */
  touchedAt: number
  records: Impression[]
}

/** What a caller hands the store; the store stamps `touchedAt` itself. */
export type ImpressionFileInput = Omit<ImpressionFile, 'touchedAt'>

/** One-time import of a file in the host's memory format. */
export interface ImpressionImport {
  path: string
  as: { personId: string } | { groupKey: string }
}

/** The plugin-level block; without a directory the feature is off. */
export interface ImpressionsConfig {
  dir: string
  import?: ImpressionImport | undefined
}

/** How much of a turn's text one impressions block may spend. */
export interface ImpressionsTurn {
  chars: number
}

export const DEFAULT_IMPRESSION_CHARS = 400
export const IMPRESSION_CHARS_MAX = 2000
/** The read-only export the store keeps beside its subject directories. */
export const IMPRESSION_VIEW_NAME = 'MEMORY.md'
export const IMPRESSION_VIEW_HEADER =
  '# Impressions\n\nGenerated from the impression store; read-only. This file is not read by the host.\n'

export interface ImpressionStoreOptions {
  dir: string
  bot: string
  now?: (() => number) | undefined
  warn?: ((message: string) => void) | undefined
}

export type ImpressionReadResult =
  | { ok: true; records: readonly Impression[] }
  | { ok: false; code: 'storage_error'; reason: string }
export type ImpressionWriteResult =
  | { ok: true; records: readonly Impression[] }
  | { ok: false; code: 'storage_error'; reason: string }
export type ImpressionSaveResult = { ok: true } | { ok: false; code: 'storage_error'; reason: string }

/** Applies one turn's change to a subject under the file's queue; an empty result deletes the file,
 * and `undefined` leaves it untouched. */
export type ImpressionChange = (records: readonly Impression[]) => readonly Impression[] | undefined

class StoreProblem extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Content-derived handle: the same note about the same subject keeps one id. */
export function impressionId(record: Pick<Impression, 'subjectKind' | 'subject' | 'scope' | 'groupKey' | 'kind' | 'text'>): string {
  const parts = [record.subjectKind, record.subject, record.scope, record.groupKey ?? '', record.kind, record.text]
  return sha256(parts.join('|')).slice(0, 32)
}

/** The file a subject lives in; hashing keeps separators out of the name. */
export function subjectFileName(subject: string): string {
  return sha256(subject)
}

/** The directory a bot owns under the configured root; hashed for the same reason. */
export function botDirectoryName(bot: string): string {
  return sha256(bot)
}

/** One entry per event key, oldest dropped first, so a file never grows past what a reader accepts. */
export function normalizeEvidence(entries: readonly ImpressionEvidence[]): ImpressionEvidence[] {
  const merged = new Map<string, ImpressionEvidence>()
  for (const entry of entries) merged.set(entry.eventKey, entry)
  return [...merged.values()].sort((left, right) => left.at - right.at).slice(-IMPRESSION_EVIDENCE_MAX)
}

/** Adds evidence to a record, one entry per event key, keeping the newest 16. */
export function mergeEvidence(record: Impression, evidence: readonly ImpressionEvidence[], at: number): Impression {
  return { ...record, evidence: normalizeEvidence([...record.evidence, ...evidence]), updatedAt: Math.max(record.updatedAt, at) }
}

/** What a record is worth today: halves every 90 days, never below the floor. */
export function effectiveConfidence(confidence: number, updatedAt: number, now: number): number {
  const days = Math.max(0, now - updatedAt) / 86_400_000
  return Math.max(IMPRESSION_CONFIDENCE_FLOOR, confidence * 0.5 ** (days / IMPRESSION_HALF_LIFE_DAYS))
}

/** Dedupes ids and evidence and drops the oldest records, so what is written is what the reader accepts. */
export function normalizeRecords(records: readonly Impression[]): Impression[] {
  const byId = new Map<string, Impression>()
  for (const record of records) {
    const next: Impression = { ...record, evidence: normalizeEvidence(record.evidence) }
    const seen = byId.get(next.id)
    if (seen === undefined) {
      byId.set(next.id, next)
      continue
    }
    byId.set(next.id, {
      ...seen,
      evidence: normalizeEvidence([...seen.evidence, ...next.evidence]),
      createdAt: Math.min(seen.createdAt, next.createdAt),
      updatedAt: Math.max(seen.updatedAt, next.updatedAt),
    })
  }
  const unique = [...byId.values()]
  if (unique.length <= IMPRESSION_RECORDS_MAX) return unique
  return unique.sort((left, right) => left.updatedAt - right.updatedAt).slice(-IMPRESSION_RECORDS_MAX)
}

/** Reads the plugin-level block; an absent block means the whole feature is off. */
export function readImpressionsConfig(raw: unknown): ImpressionsConfig | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('impressions must be an object', ['impressions'])
  }
  const block = raw as Record<string, unknown>
  const unknown = Object.keys(block).filter((key) => key !== 'dir' && key !== 'import')
  if (unknown.length > 0) {
    throw new ConfigError(`impressions names a field it does not read: ${unknown.join(', ')}`, ['impressions'], unknown)
  }
  const dir = block.dir
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new ConfigError('impressions.dir must be a non-empty string', ['impressions', 'dir'])
  }
  if (!dir.startsWith('/')) {
    throw new ConfigError(`impressions.dir must be an absolute path: ${dir}`, ['impressions', 'dir'])
  }
  if (dir.includes('\u0000')) {
    throw new ConfigError('impressions.dir must not carry a NUL byte', ['impressions', 'dir'])
  }
  if (block.import === undefined) return { dir }
  return { dir, import: readImport(block.import) }
}

function readImport(raw: unknown): ImpressionImport {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('impressions.import must be an object', ['impressions', 'import'])
  }
  const block = raw as Record<string, unknown>
  const unknown = Object.keys(block).filter((key) => key !== 'path' && key !== 'as')
  if (unknown.length > 0) {
    throw new ConfigError(`impressions.import names a field it does not read: ${unknown.join(', ')}`, ['impressions', 'import'], unknown)
  }
  const path = block.path
  if (typeof path !== 'string' || path.length === 0) {
    throw new ConfigError('impressions.import.path must be a non-empty string', ['impressions', 'import', 'path'])
  }
  if (!path.startsWith('/')) {
    throw new ConfigError(`impressions.import.path must be an absolute path: ${path}`, ['impressions', 'import', 'path'])
  }
  if (path.includes('\u0000')) {
    throw new ConfigError('impressions.import.path must not carry a NUL byte', ['impressions', 'import', 'path'])
  }
  return { path, as: readImportSubject(block.as) }
}

function readImportSubject(raw: unknown): ImpressionImport['as'] {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('impressions.import.as must be an object', ['impressions', 'import', 'as'])
  }
  const block = raw as Record<string, unknown>
  const unknown = Object.keys(block).filter((key) => key !== 'personId' && key !== 'groupKey')
  if (unknown.length > 0) {
    throw new ConfigError(`impressions.import.as names a field it does not read: ${unknown.join(', ')}`, ['impressions', 'import', 'as'], unknown)
  }
  const person = block.personId
  const group = block.groupKey
  if ((person === undefined) === (group === undefined)) {
    throw new ConfigError('impressions.import.as must name exactly one of personId or groupKey', ['impressions', 'import', 'as'])
  }
  const value = person ?? group
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('impressions.import.as must name a non-empty string', ['impressions', 'import', 'as'])
  }
  return person === undefined ? { groupKey: value } : { personId: value }
}

/** Reads the turn-level budget; absent means the default, zero turns the block off. */
export function readImpressionsTurn(raw: unknown): ImpressionsTurn {
  if (raw === undefined) return { chars: DEFAULT_IMPRESSION_CHARS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('turn.impressions must be an object', ['turn', 'impressions'])
  }
  const block = raw as Record<string, unknown>
  const unknown = Object.keys(block).filter((key) => key !== 'chars')
  if (unknown.length > 0) {
    throw new ConfigError(`turn.impressions names a field it does not read: ${unknown.join(', ')}`, ['turn', 'impressions'], unknown)
  }
  const chars = block.chars ?? DEFAULT_IMPRESSION_CHARS
  if (typeof chars !== 'number' || !Number.isInteger(chars) || chars < 0 || chars > IMPRESSION_CHARS_MAX) {
    throw new ConfigError(`turn.impressions.chars must be a whole number between 0 and ${IMPRESSION_CHARS_MAX}: ${String(chars)}`, [
      'turn',
      'impressions',
      'chars',
    ])
  }
  return { chars }
}

function bad(file: string, problem: string): never {
  throw new ConfigError(`impression file ${file}: ${problem}`)
}

function objectOf(value: unknown, file: string, where: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) bad(file, `${where} must be an object`)
  return value as Record<string, unknown>
}

function bounded(value: unknown, file: string, where: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0) bad(file, `${where} must be a non-empty string`)
  if (value.length > max) bad(file, `${where} is longer than ${max} characters`)
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) bad(file, `${where} must be printable characters`)
  }
  return value
}

function whole(value: unknown, file: string, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    bad(file, `${where} must be a whole number, at least 0`)
  }
  return value
}

function unit(value: unknown, file: string, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    bad(file, `${where} must be a number between 0 and 1`)
  }
  return value
}

function subjectKindOf(value: unknown, file: string): ImpressionSubjectKind {
  if (value !== 'person' && value !== 'group') bad(file, 'subjectKind must be "person" or "group"')
  return value
}

function scopeOf(value: unknown, file: string, where: string): ImpressionScope {
  if (value !== 'c2c' && value !== 'group') bad(file, `${where} must be "c2c" or "group"`)
  return value
}

const KIND_SET: ReadonlySet<string> = new Set(IMPRESSION_KINDS)
const SHAREABLE_SET: ReadonlySet<string> = new Set(SHAREABLE_KINDS)
const FILE_FIELDS = new Set(['version', 'subject', 'subjectKind', 'touchedAt', 'records'])
const RECORD_FIELDS = new Set([
  'id',
  'subject',
  'subjectKind',
  'scope',
  'groupKey',
  'text',
  'kind',
  'confidence',
  'share',
  'evidence',
  'bot',
  'createdAt',
  'updatedAt',
])
const EVIDENCE_FIELDS = new Set(['eventKey', 'sessionKey', 'channel', 'at'])

function checkUnknown(source: Record<string, unknown>, fields: ReadonlySet<string>, file: string, where: string): void {
  const unknown = Object.keys(source).filter((key) => !fields.has(key))
  if (unknown.length > 0) bad(file, `${where} names a field it does not read: ${unknown.join(', ')}`)
}

function readEvidence(raw: unknown, file: string, where: string): ImpressionEvidence[] {
  if (!Array.isArray(raw) || raw.length === 0) bad(file, `${where} must be a non-empty list`)
  if (raw.length > IMPRESSION_EVIDENCE_MAX) bad(file, `${where} carries more than ${IMPRESSION_EVIDENCE_MAX} entries`)
  const seen = new Set<string>()
  return raw.map((entry, index) => {
    const at = `${where}[${index}]`
    const source = objectOf(entry, file, at)
    checkUnknown(source, EVIDENCE_FIELDS, file, at)
    const eventKey = bounded(source.eventKey, file, `${at}.eventKey`, IMPRESSION_EVENT_KEY_MAX)
    if (seen.has(eventKey)) bad(file, `${where} carries the event key "${eventKey}" twice`)
    seen.add(eventKey)
    return {
      eventKey,
      sessionKey: bounded(source.sessionKey, file, `${at}.sessionKey`, IMPRESSION_SESSION_KEY_MAX),
      channel: bounded(source.channel, file, `${at}.channel`, IMPRESSION_CHANNEL_MAX),
      at: whole(source.at, file, `${at}.at`),
    }
  })
}

function readRecord(raw: unknown, file: string, index: number, subject: string, subjectKind: ImpressionSubjectKind, bot: string): Impression {
  const where = `records[${index}]`
  const source = objectOf(raw, file, where)
  checkUnknown(source, RECORD_FIELDS, file, where)
  const id = bounded(source.id, file, `${where}.id`, 64)
  if (!/^[0-9a-f]{32}$/.test(id)) bad(file, `${where}.id must be a content hash`)
  if (bounded(source.subject, file, `${where}.subject`, IMPRESSION_SUBJECT_MAX) !== subject) {
    bad(file, `${where}.subject does not match the file`)
  }
  if (subjectKindOf(source.subjectKind, file) !== subjectKind) bad(file, `${where}.subjectKind does not match the file`)
  const scope = scopeOf(source.scope, file, `${where}.scope`)
  let groupKey: string | undefined
  if (scope === 'group') {
    groupKey = bounded(source.groupKey, file, `${where}.groupKey`, IMPRESSION_SUBJECT_MAX)
  } else if ('groupKey' in source) {
    bad(file, `${where}.groupKey is only read in a group scope`)
  }
  if (subjectKind === 'group' && (scope !== 'group' || groupKey !== subject)) {
    bad(file, `${where} is a group record, so its scope is "group" and its groupKey is its subject`)
  }
  const text = bounded(source.text, file, `${where}.text`, IMPRESSION_TEXT_MAX)
  const kind = source.kind
  if (typeof kind !== 'string' || !KIND_SET.has(kind)) bad(file, `${where}.kind must be one of ${IMPRESSION_KINDS.join(', ')}`)
  const share = source.share
  if (share !== 'local' && share !== 'cross') bad(file, `${where}.share must be "local" or "cross"`)
  if (share === 'cross' && !SHAREABLE_SET.has(kind)) {
    bad(file, `${where}.share is "cross", which only ${SHAREABLE_KINDS.join(', ')} may be`)
  }
  const recorded = bounded(source.bot, file, `${where}.bot`, 256)
  if (recorded !== bot) bad(file, `${where}.bot is "${recorded}", not "${bot}"`)
  const createdAt = whole(source.createdAt, file, `${where}.createdAt`)
  const updatedAt = whole(source.updatedAt, file, `${where}.updatedAt`)
  if (updatedAt < createdAt) bad(file, `${where}.updatedAt is older than createdAt`)
  const record: Impression = {
    id,
    subject,
    subjectKind,
    scope,
    ...(groupKey === undefined ? {} : { groupKey }),
    text,
    kind: kind as ImpressionKind,
    confidence: unit(source.confidence, file, `${where}.confidence`),
    share,
    evidence: readEvidence(source.evidence, file, `${where}.evidence`),
    bot,
    createdAt,
    updatedAt,
  }
  if (impressionId(record) !== id) bad(file, `${where}.id does not match its content`)
  return record
}

/** Reads one subject file, refusing anything this package did not write. */
export function parseImpressionFile(raw: unknown, bot: string, file: string): ImpressionFile {
  const source = objectOf(raw, file, 'the file')
  checkUnknown(source, FILE_FIELDS, file, 'the file')
  if (source.version !== IMPRESSION_FILE_VERSION) {
    bad(file, `has version ${String(source.version)}, but this package reads ${IMPRESSION_FILE_VERSION}`)
  }
  const subjectKind = subjectKindOf(source.subjectKind, file)
  const subject = bounded(source.subject, file, 'subject', IMPRESSION_SUBJECT_MAX)
  const touchedAt = whole(source.touchedAt, file, 'touchedAt')
  const rawRecords = source.records
  if (!Array.isArray(rawRecords)) bad(file, 'records must be a list')
  if (rawRecords.length > IMPRESSION_RECORDS_MAX) bad(file, `records carries more than ${IMPRESSION_RECORDS_MAX} entries`)
  const seen = new Set<string>()
  const records = rawRecords.map((entry, index) => {
    const record = readRecord(entry, file, index, subject, subjectKind, bot)
    if (seen.has(record.id)) bad(file, `records carries the id "${record.id}" twice`)
    seen.add(record.id)
    return record
  })
  return { version: IMPRESSION_FILE_VERSION, subject, subjectKind, touchedAt, records }
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function widerThan(mode: number, allowed: number): boolean {
  return (mode & 0o777 & ~allowed) !== 0
}

interface IndexEntry {
  subject: string
  subjectKind: ImpressionSubjectKind
  touchedAt: number
  records: number
}

/** One bot's notes on disk: one file per subject, one directory per bot. */
export class ImpressionStore {
  readonly root: string
  readonly #dir: string
  readonly #bot: string
  readonly #now: () => number
  readonly #warn: (message: string) => void
  readonly #index = new Map<string, IndexEntry>()
  readonly #queues = new Map<string, Promise<void>>()
  readonly #warned = new Set<string>()
  #directorySyncWarned = false
  #creationWarned = false
  #dirty = false
  #rendering: Promise<void> | undefined
  #renderWarned = false
  #retryAfterFailure = false

  constructor(options: ImpressionStoreOptions) {
    if (options.dir.length === 0) throw new ConfigError('impressions.dir must be a non-empty string', ['impressions', 'dir'])
    if (options.bot.length === 0) throw new ConfigError('an impression store needs a bot name')
    this.#dir = options.dir
    this.root = join(options.dir, botDirectoryName(options.bot))
    this.#bot = options.bot
    this.#now = options.now ?? (() => Date.now())
    this.#warn = options.warn ?? (() => undefined)
  }

  /** Reads every file this bot owns; a damaged file refuses the mount instead of being replaced. */
  async load(): Promise<void> {
    this.#index.clear()
    const baseStat = await this.#stat(this.#dir)
    if (baseStat === undefined) return
    if (baseStat.isSymbolicLink()) this.#refuse(this.#dir, 'is a symlink')
    if (!baseStat.isDirectory()) this.#refuse(this.#dir, 'is not a directory')
    const baseMode = baseStat.mode & 0o777
    if ((baseMode & 0o022) !== 0) this.#refuse(this.#dir, `is writable beyond its owner (mode ${baseMode.toString(8)})`)
    if (widerThan(baseMode, 0o700)) {
      this.#warn(`dsbot-channel: impression directory ${this.#dir} is readable beyond its owner; its per-bot subdirectories stay 0700`)
    }
    const rootStat = await this.#stat(this.root)
    if (rootStat === undefined) return
    if (rootStat.isSymbolicLink()) this.#refuse(this.root, 'is a symlink')
    if (!rootStat.isDirectory()) this.#refuse(this.root, 'is not a directory')
    for (const kind of ['person', 'group'] as const) {
      const dir = join(this.root, kind)
      const stat = await this.#stat(dir)
      if (stat === undefined) continue
      if (stat.isSymbolicLink()) this.#refuse(dir, 'is a symlink')
      if (!stat.isDirectory()) this.#refuse(dir, 'is not a directory')
      await this.#scanKind(dir)
    }
  }

  fileFor(subjectKind: ImpressionSubjectKind, subject: string): string {
    return join(this.root, subjectKind, `${subjectFileName(subject)}.json`)
  }

  /** Reads one subject from disk; a file made unreadable by hand comes back as a failure. */
  async read(subjectKind: ImpressionSubjectKind, subject: string): Promise<ImpressionReadResult> {
    try {
      const file = await this.#readNow(this.fileFor(subjectKind, subject))
      return { ok: true, records: file?.records ?? [] }
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
  }

  /** Applies one change under the file's queue, so a read and the write after it cannot interleave. */
  async transact(subjectKind: ImpressionSubjectKind, subject: string, change: ImpressionChange): Promise<ImpressionWriteResult> {
    const path = this.fileFor(subjectKind, subject)
    try {
      return await this.#enqueue(path, async () => {
        const current = await this.#readNow(path)
        const changed = change(current?.records ?? [])
        if (changed === undefined) return { ok: true as const, records: current?.records ?? [] }
        if (changed.length === 0) {
          await this.#deleteNow(path)
          this.#markDirty()
          return { ok: true as const, records: [] }
        }
        const records = normalizeRecords(changed)
        await this.#ensureSpace(path)
        const file: ImpressionFile = {
          version: IMPRESSION_FILE_VERSION,
          subject,
          subjectKind,
          touchedAt: this.#now(),
          records,
        }
        parseImpressionFile(file, this.#bot, path)
        await this.#writeNow(path, file)
        this.#index.set(path, {
          subject: file.subject,
          subjectKind: file.subjectKind,
          touchedAt: file.touchedAt,
          records: file.records.length,
        })
        this.#markDirty()
        return { ok: true as const, records }
      })
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
  }

  /** Writes one whole subject file; the tools go through `transact` instead. */
  async save(file: ImpressionFileInput): Promise<ImpressionSaveResult> {
    const stamped: ImpressionFile = { ...file, touchedAt: this.#now() }
    const path = this.fileFor(stamped.subjectKind, stamped.subject)
    try {
      parseImpressionFile(stamped, this.#bot, path)
      await this.#enqueue(path, async () => {
        await this.#ensureSpace(path)
        await this.#writeNow(path, stamped)
        this.#index.set(path, {
          subject: stamped.subject,
          subjectKind: stamped.subjectKind,
          touchedAt: stamped.touchedAt,
          records: stamped.records.length,
        })
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
  }

  /** Renders the read-only view once when the bot directory already exists. */
  async renderAtMount(): Promise<void> {
    if ((await this.#stat(this.root)) === undefined) return
    this.#markDirty()
    const running = this.#rendering
    if (running !== undefined) await running
    if (this.#rendering === undefined && this.#dirty) await this.#scheduleRender()
  }

  #markDirty(): void {
    this.#dirty = true
    void this.#scheduleRender()
  }

  #scheduleRender(): Promise<void> {
    const running = this.#rendering
    if (running !== undefined) return running
    const run = this.#renderLoop().finally(() => {
      if (this.#rendering === run) {
        this.#rendering = undefined
        if (this.#retryAfterFailure) {
          this.#retryAfterFailure = false
          void this.#scheduleRender()
        }
      }
    })
    this.#rendering = run
    return run
  }

  async #renderLoop(): Promise<void> {
    while (this.#dirty) {
      this.#dirty = false
      try {
        await this.#renderOnce()
        this.#retryAfterFailure = false
      } catch (error) {
        if (!this.#renderWarned) {
          this.#renderWarned = true
          this.#warn(`dsbot-channel: could not render ${join(this.root, IMPRESSION_VIEW_NAME)}: ${describe(error)}`)
        }
        if (this.#dirty) this.#retryAfterFailure = true
        this.#dirty = true
        return
      }
    }
  }

  /** Reads every known subject from disk and writes the view through the same atomic path as notes. */
  async #renderOnce(): Promise<void> {
    const subjects = [...this.#index.entries()]
      .map(([path, entry]) => ({ path, ...entry }))
      .sort((left, right) =>
        left.subject === right.subject
          ? left.subjectKind.localeCompare(right.subjectKind)
          : left.subject.localeCompare(right.subject),
      )
    const sections: string[] = []
    for (const subject of subjects) {
      const file = await this.#readAt(subject.path)
      const records = [...file.records].sort((left, right) => left.id.localeCompare(right.id))
      if (records.length === 0) continue
      const lines = records.map(
        (record) =>
          `- [${record.kind}] ${record.confidence} ${new Date(record.updatedAt).toISOString()} ${record.text}`,
      )
      sections.push(`\n## ${subject.subjectKind}: ${subject.subject}\n${lines.join('\n')}\n`)
    }
    await this.#writeAtomic(join(this.root, IMPRESSION_VIEW_NAME), `${IMPRESSION_VIEW_HEADER}${sections.join('')}`)
  }

  async #scanKind(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    let temps = 0
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.name.endsWith('.tmp')) {
        await rm(path, { force: true })
        temps += 1
        continue
      }
      if (!entry.name.endsWith('.json')) continue
      if (entry.isSymbolicLink()) this.#refuse(path, 'is a symlink')
      if (!entry.isFile()) continue
      const file = await this.#readAt(path)
      this.#index.set(path, {
        subject: file.subject,
        subjectKind: file.subjectKind,
        touchedAt: file.touchedAt,
        records: file.records.length,
      })
    }
    if (temps > 0) {
      this.#warn(`dsbot-channel: removed ${temps} leftover impression temp file(s) under ${dir}`)
    }
  }

  async #readAt(path: string): Promise<ImpressionFile> {
    const handle = await this.#open(path)
    try {
      const raw = await handle.readFile('utf8')
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        this.#refuse(path, 'is not valid JSON')
      }
      return parseImpressionFile(parsed, this.#bot, path)
    } finally {
      await handle.close()
    }
  }

  /** Reads one file through every check a turn's write must respect; missing means an empty subject. */
  async #readNow(path: string): Promise<ImpressionFile | undefined> {
    const rootProblem = await this.#rootProblem()
    if (rootProblem !== undefined) throw new StoreProblem(rootProblem)
    const leafProblem = await this.#modeProblem(path)
    if (leafProblem !== undefined) throw new StoreProblem(leafProblem)
    const existing = await this.#stat(path)
    if (existing === undefined) return undefined
    if (existing.isSymbolicLink() || !existing.isFile()) throw new StoreProblem(`${path} is not a regular file`)
    const handle = await this.#open(path)
    try {
      const stat = await handle.stat()
      if (widerThan(stat.mode & 0o777, 0o600)) throw new StoreProblem(this.#modeWarning(stat.mode, path, 0o600))
    } finally {
      await handle.close()
    }
    return this.#readAt(path)
  }

  async #deleteNow(path: string): Promise<void> {
    await rm(path, { force: true })
    this.#index.delete(path)
  }

  async #ensureSpace(path: string): Promise<void> {
    if (this.#index.has(path)) return
    if (this.#index.size < IMPRESSION_SUBJECTS_MAX) return
    const oldest = [...this.#index.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)
    let pruned = 0
    for (const [oldPath] of oldest) {
      if (this.#index.size < IMPRESSION_SUBJECTS_MAX) break
      await this.#deleteNow(oldPath)
      pruned += 1
    }
    if (pruned > 0) {
      this.#warn(`dsbot-channel: dropped ${pruned} oldest impression file(s) under ${this.root} to stay within ${IMPRESSION_SUBJECTS_MAX}`)
    }
  }

  /** Creates the bot's directories on first write and says so, because a wrong dir looks like lost notes. */
  async #writeNow(path: string, file: ImpressionFile): Promise<void> {
    const outer =
      (await this.#stat(this.#dir)) === undefined
        ? this.#dir
        : (await this.#stat(this.root)) === undefined
          ? this.root
          : undefined
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    if (outer !== undefined) this.#warnCreated(outer)
    const rootProblem = await this.#rootProblem()
    if (rootProblem !== undefined) throw new StoreProblem(rootProblem)
    const leafProblem = await this.#modeProblem(path)
    if (leafProblem !== undefined) throw new StoreProblem(leafProblem)
    const existing = await this.#stat(path)
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isFile()) throw new StoreProblem(`${path} is not a regular file`)
      if (widerThan(existing.mode & 0o777, 0o600)) throw new StoreProblem(this.#modeWarning(existing.mode, path, 0o600))
    }
    const payload = `${JSON.stringify(file, null, 2)}\n`
    await this.#writeAtomic(path, payload)
  }

  #warnCreated(outer: string): void {
    if (this.#creationWarned) return
    this.#creationWarned = true
    this.#warn(`dsbot-channel: created impression storage ${outer} on its first write`)
  }

  async #open(path: string): Promise<FileHandle> {
    const noFollow = constants.O_NOFOLLOW ?? 0
    try {
      return await open(path, constants.O_RDONLY | noFollow)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') this.#refuse(path, 'is a symlink')
      throw error
    }
  }

  async #modeProblem(path: string): Promise<string | undefined> {
    const leaf = dirname(path)
    const stat = await this.#stat(leaf)
    if (stat === undefined) return undefined
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${leaf} is not a directory`
    if (widerThan(stat.mode & 0o777, 0o700)) return this.#modeWarning(stat.mode, leaf, 0o700)
    return undefined
  }

  /** The bot directory gets the same split as the leaves: writable by others is refused, readable is a warn. */
  async #rootProblem(): Promise<string | undefined> {
    const stat = await this.#stat(this.root)
    if (stat === undefined) return undefined
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${this.root} is not a directory`
    const mode = stat.mode & 0o777
    if ((mode & 0o022) !== 0) return this.#modeWarning(mode, this.root, 0o700)
    if (widerThan(mode, 0o700)) {
      this.#warnOnce(`dsbot-channel: impression directory ${this.root} is readable beyond its owner; its leaves stay 0700`)
    }
    return undefined
  }

  #warnOnce(message: string): void {
    if (this.#warned.has(message)) return
    this.#warned.add(message)
    this.#warn(message)
  }

  #modeWarning(mode: number, path: string, allowed: number): string {
    const problem = `${path} has mode ${(mode & 0o777).toString(8)}, wider than ${allowed.toString(8)}`
    if (this.#warned.has(problem)) return problem
    this.#warned.add(problem)
    this.#warn(`dsbot-channel: ${problem}; impressions stay unread or unwritten until it is fixed`)
    return problem
  }

  async #stat(path: string): Promise<Stats | undefined> {
    try {
      return await lstat(path)
    } catch (error) {
      if (missing(error)) return undefined
      throw error
    }
  }

  #refuse(path: string, problem: string): never {
    throw new ConfigError(`impression store ${path} ${problem}`)
  }

  /** Replaces one file through a sibling temp file, so a reader sees old or new, never half. */
  async #writeAtomic(path: string, payload: string): Promise<void> {
    const temp = `${path}.tmp`
    const handle = await open(temp, 'w', 0o600)
    try {
      await handle.chmod(0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
    } catch (error) {
      await handle.close().catch(() => undefined)
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await handle.close()
    try {
      await rename(temp, path)
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw error
    }
    await this.#syncDirectory(dirname(path))
  }

  async #syncDirectory(dir: string): Promise<void> {
    let handle: FileHandle
    try {
      handle = await open(dir, 'r')
    } catch (error) {
      this.#degraded(error)
      return
    }
    try {
      await handle.sync()
    } catch (error) {
      this.#degraded(error)
    } finally {
      await handle.close()
    }
  }

  #degraded(error: unknown): void {
    if (this.#directorySyncWarned) return
    this.#directorySyncWarned = true
    this.#warn(`dsbot-channel: cannot fsync an impression directory (${describe(error)}); a write is an atomic rename only`)
  }

  #enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(key) ?? Promise.resolve()
    const run = previous.then(job, job)
    const settled: Promise<void> = run.then(
      () => undefined,
      () => undefined,
    )
    this.#queues.set(key, settled)
    void settled.then(() => {
      if (this.#queues.get(key) === settled) this.#queues.delete(key)
    })
    return run
  }
}
