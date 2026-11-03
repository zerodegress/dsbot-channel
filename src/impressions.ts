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

/** The plugin-level block; without a directory the feature is off. */
export interface ImpressionsConfig {
  dir: string
}

/** What one bot's store holds, for a status reader that never sees note text. */
export interface ImpressionStoreStats {
  subjects: number
  records: number
}

export interface ImpressionStoreOptions {
  dir: string
  bot: string
  now?: (() => number) | undefined
  warn?: ((message: string) => void) | undefined
}

export type ImpressionReadResult =
  | { ok: true; records: readonly Impression[] }
  | { ok: false; code: 'storage_error'; reason: string }
export type ImpressionSaveResult = { ok: true } | { ok: false; code: 'storage_error'; reason: string }

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

/** Reads the plugin-level block; an absent block means the whole feature is off. */
export function readImpressionsConfig(raw: unknown): ImpressionsConfig | undefined {
  if (raw === undefined) return undefined
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('impressions must be an object', ['impressions'])
  }
  const block = raw as Record<string, unknown>
  const unknown = Object.keys(block).filter((key) => key !== 'dir')
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
  return { dir }
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
    const path = this.fileFor(subjectKind, subject)
    try {
      const existing = await this.#stat(path)
      if (existing === undefined) return { ok: true, records: [] }
      if (existing.isSymbolicLink() || !existing.isFile()) {
        return { ok: false, code: 'storage_error', reason: `${path} is not a regular file` }
      }
      const problem = await this.#modeProblem(path)
      if (problem !== undefined) return { ok: false, code: 'storage_error', reason: problem }
      const handle = await this.#open(path)
      try {
        const stat = await handle.stat()
        if (widerThan(stat.mode & 0o777, 0o600)) {
          return { ok: false, code: 'storage_error', reason: this.#modeWarning(stat.mode, path, 0o600) }
        }
        const raw = await handle.readFile('utf8')
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        } catch {
          return { ok: false, code: 'storage_error', reason: `${path} is not valid JSON` }
        }
        return { ok: true, records: parseImpressionFile(parsed, this.#bot, path).records }
      } finally {
        await handle.close()
      }
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
  }

  stats(): ImpressionStoreStats {
    let records = 0
    for (const entry of this.#index.values()) records += entry.records
    return { subjects: this.#index.size, records }
  }

  /** Writes one subject file behind that file's queue; failures come back, they never throw. */
  async save(file: ImpressionFileInput): Promise<ImpressionSaveResult> {
    const stamped: ImpressionFile = { ...file, touchedAt: this.#now() }
    const path = this.fileFor(stamped.subjectKind, stamped.subject)
    try {
      parseImpressionFile(stamped, this.#bot, path)
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
    const payload = `${JSON.stringify(stamped, null, 2)}\n`
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      const leafProblem = await this.#modeProblem(path, true)
      if (leafProblem !== undefined) return { ok: false, code: 'storage_error', reason: leafProblem }
      const existing = await this.#stat(path)
      if (existing !== undefined) {
        if (existing.isSymbolicLink() || !existing.isFile()) {
          return { ok: false, code: 'storage_error', reason: `${path} is not a regular file` }
        }
        if (widerThan(existing.mode & 0o777, 0o600)) {
          return { ok: false, code: 'storage_error', reason: this.#modeWarning(existing.mode, path, 0o600) }
        }
      }
      await this.#enqueue(path, async () => {
        await this.#writeAtomic(path, payload)
      })
      this.#index.set(path, {
        subject: stamped.subject,
        subjectKind: stamped.subjectKind,
        touchedAt: stamped.touchedAt,
        records: stamped.records.length,
      })
      return { ok: true }
    } catch (error) {
      return { ok: false, code: 'storage_error', reason: describe(error) }
    }
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

  async #open(path: string): Promise<FileHandle> {
    const noFollow = constants.O_NOFOLLOW ?? 0
    try {
      return await open(path, constants.O_RDONLY | noFollow)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ELOOP') this.#refuse(path, 'is a symlink')
      throw error
    }
  }

  async #modeProblem(path: string, create = false): Promise<string | undefined> {
    const leaf = dirname(path)
    const stat = await this.#stat(leaf)
    if (stat === undefined) {
      if (!create) return undefined
      await mkdir(leaf, { recursive: true, mode: 0o700 })
      return undefined
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return `${leaf} is not a directory`
    if (widerThan(stat.mode & 0o777, 0o700)) return this.#modeWarning(stat.mode, leaf, 0o700)
    return undefined
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

  #enqueue(key: string, job: () => Promise<void>): Promise<void> {
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
