import type { EventDescriptor, InboundMessage } from '../../contract.js'

export const WEBHOOK_DIALECTS = ['github', 'forgejo', 'auto'] as const
export type WebhookDialect = (typeof WEBHOOK_DIALECTS)[number]

export interface MappingConfig {
  channel: string
  /** The bot's own login, used for `mentioned.self`. */
  login: string
  /** Logins whose comments count as bot speech. */
  bots: readonly string[]
}

export interface MappingInput {
  dialect: 'github' | 'forgejo'
  event: string
  delivery: string
  payload: Record<string, unknown>
  config: MappingConfig
}

export type MappingResult = { message: InboundMessage } | { skip: 'ping' | 'malformed' }

type Payload = Record<string, unknown>

const CI_EVENTS = new Set(['workflow_run', 'check_run', 'check_suite', 'status'])
const VERBS: Record<string, string> = {
  opened: 'opened',
  closed: 'closed',
  reopened: 'reopened',
  edited: 'edited',
  deleted: 'deleted',
  created: 'added',
  submitted: 'submitted',
  synchronize: 'updated',
  completed: 'completed',
  labeled: 'labeled',
  unlabeled: 'unlabeled',
}

function record(value: unknown): Payload | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Payload) : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function normalizedName(event: string): string {
  return event.replace(/[^a-z0-9_]/gi, '_').toLowerCase()
}

/** The class an adapter may list in `events.turn`; always two segments. */
export function semanticClass(event: string): string {
  if (event === 'push') return 'push'
  if (CI_EVENTS.has(event)) return 'ci'
  if (event === 'issues') return 'issues'
  if (event === 'pull_request') return 'pull_request'
  if (event === 'issue_comment' || event === 'pull_request_review_comment') return 'comment'
  if (event === 'pull_request_review') return 'review'
  if (event === 'release') return 'release'
  return normalizedName(event)
}

interface Entity {
  owner: string
  repo: string
  full: string
  number?: number
}

function entityOf(payload: Payload): Entity | undefined {
  const repo = record(payload.repository)
  const owner = text(record(repo?.owner)?.login) ?? text(record(repo?.owner)?.username)
  const name = text(repo?.name)
  if (owner === undefined || name === undefined) return undefined
  const number =
    whole(record(payload.issue)?.number) ??
    whole(record(payload.pull_request)?.number) ??
    whole(record(payload.discussion)?.number)
  return { owner, repo: name, full: `${owner}/${name}`, ...(number === undefined ? {} : { number }) }
}

function scopeOf(entity: Entity): string {
  return entity.number === undefined ? `gh:${entity.full}` : `gh:${entity.full}#${entity.number}`
}

function titleOf(payload: Payload): string {
  return (
    text(record(payload.issue)?.title) ??
    text(record(payload.pull_request)?.title) ??
    text(record(payload.release)?.name) ??
    text(record(payload.release)?.tag_name) ??
    text(record(payload.head_commit)?.message)?.split('\n')[0] ??
    ''
  )
}

const OBJECT: Record<string, string> = {
  issues: 'issue',
  pull_request: 'pull request',
  pull_request_review: 'review',
  release: 'release',
}

/** One line, no clock, so a redelivery of the same event reads the same. */
export function summaryOf(input: {
  actor: string
  event: string
  action: string
  entity: Entity
  title: string
}): string {
  const verb = VERBS[input.action] ?? input.action
  const object = OBJECT[input.event] ?? input.event
  const subject = input.entity.number === undefined ? input.entity.full : `${input.entity.full}#${input.entity.number}`
  const head = `${input.actor} ${verb} ${object} ${subject}`.replace(/\s+/g, ' ').trim()
  return input.title === '' ? head : `${head}: ${input.title}`
}

function withoutCode(body: string): string {
  return body.replace(/```[\s\S]*?```/g, ' ').replace(/```[\s\S]*$/g, ' ').replace(/`[^`\n]*`/g, ' ')
}

const MENTION = /@([A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?)/g

export function mentionsOf(body: string, login: string): { self: boolean; others: boolean } {
  const seen = new Set<string>()
  for (const match of withoutCode(body).matchAll(MENTION)) {
    if (match[1] !== undefined) seen.add(match[1].toLowerCase())
  }
  const mine = login.toLowerCase()
  return {
    self: mine.length > 0 && seen.has(mine),
    others: [...seen].some((one) => one !== mine),
  }
}

function sender(payload: Payload, action: string): string {
  const actor = record(payload.sender)
  const comment = record(payload.comment)
  const review = record(payload.review)
  return (
    text(record(comment?.user)?.login) ??
    text(record(comment?.user)?.username) ??
    text(record(review?.user)?.login) ??
    text(record(review?.user)?.username) ??
    text(actor?.login) ??
    text(actor?.username) ??
    action
  )
}

function eventKeyOf(input: {
  event: string
  payload: Payload
  delivery: string
  entity: Entity
  action: string
}): string {
  const comment = whole(record(input.payload.comment)?.id)
  if (comment !== undefined) {
    const base = input.event === 'pull_request_review_comment' ? `review_comment:${comment}` : `comment:${comment}`
    return input.action === 'created' ? base : `${base}:${input.action}`
  }
  const review = whole(record(input.payload.review)?.id)
  if (review !== undefined) {
    return input.action === 'submitted' || input.action === 'created' ? `review:${review}` : `review:${review}:${input.action}`
  }
  if (input.entity.number !== undefined) {
    const stamp =
      text(record(input.payload.issue)?.updated_at) ??
      text(record(input.payload.pull_request)?.updated_at) ??
      text(record(input.payload.discussion)?.updated_at) ??
      ''
    const prefix = input.event === 'pull_request' ? 'pr' : 'issue'
    return stamp === ''
      ? `${prefix}:${input.entity.full}#${input.entity.number}:${input.action}:${input.delivery}`
      : `${prefix}:${input.entity.full}#${input.entity.number}:${input.action}:${stamp}`
  }
  if (input.event === 'push') {
    const after = text(input.payload.after) ?? text(record(input.payload.head_commit)?.id) ?? ''
    return `push:${input.entity.full}:${after}`
  }
  if (input.event === 'workflow_run') {
    const run = record(input.payload.workflow_run) ?? {}
    return `run:${input.entity.full}:${whole(run.id) ?? ''}:${whole(run.run_attempt) ?? 1}:${text(run.conclusion) ?? ''}`
  }
  if (input.event === 'check_run') {
    const run = record(input.payload.check_run) ?? {}
    return `check:${input.entity.full}:${whole(run.id) ?? ''}:${text(run.status) ?? ''}:${text(run.conclusion) ?? ''}`
  }
  if (input.event === 'check_suite') {
    const run = record(input.payload.check_suite) ?? {}
    return `suite:${input.entity.full}:${whole(run.id) ?? ''}:${text(run.status) ?? ''}:${text(run.conclusion) ?? ''}`
  }
  if (input.event === 'status') {
    const sha = text(input.payload.sha) ?? ''
    const context = text(input.payload.context) ?? ''
    const state = text(input.payload.state) ?? ''
    return `status:${input.entity.full}:${sha}:${context}:${state}`
  }
  return `delivery:${input.delivery}`
}

function botOrPerson(bots: readonly string[], login: string, type: unknown): 'person' | 'bot' {
  return type === 'Bot' || bots.some((one) => one.toLowerCase() === login.toLowerCase()) ? 'bot' : 'person'
}

function bodyOf(payload: Payload): { body: string; id: number; parent?: number; user: unknown } {
  const comment = record(payload.comment)
  const review = record(payload.review)
  if (comment !== undefined) {
    const parent = whole(comment.in_reply_to_id)
    return {
      body: text(comment.body) ?? '',
      id: whole(comment.id) ?? 0,
      ...(parent === undefined ? {} : { parent }),
      user: comment.user,
    }
  }
  const comments = Array.isArray(review?.comments) ? review?.comments : undefined
  const first = comments === undefined ? undefined : record(comments[0])
  return {
    body: text(review?.body) ?? text(first?.body) ?? '',
    id: whole(review?.id) ?? whole(first?.id) ?? 0,
    ...(whole(first?.in_reply_to_id) === undefined ? {} : { parent: whole(first?.in_reply_to_id)! }),
    user: review?.user ?? first?.user,
  }
}

function messageOf(input: MappingInput, entity: Entity, action: string): InboundMessage {
  const payload = input.payload
  const found = bodyOf(payload)
  const comment = record(payload.comment)
  const body = found.body
  const login = sender(payload, action)
  const id = found.id
  const parent = found.parent
  const mentioned = mentionsOf(body, input.config.login)
  const scoped = scopeOf(entity)
  return {
    eventKey: eventKeyOf({ event: input.event, payload, delivery: input.delivery, entity, action: 'created' }),
    kind: 'message',
    event: { postType: input.event, type: normalizedName(input.event) } satisfies EventDescriptor,
    sessionKey: scoped,
    replyTarget: scoped,
    requestId: String(id),
    chainId: scoped,
    source: {
      kind: 'webhook',
      instance: input.config.channel,
      peer: entity.number === undefined ? entity.full : `${entity.full}#${entity.number}`,
      scope: 'group',
    },
    author: {
      senderId: login,
      kind: botOrPerson(input.config.bots, login, record(found.user)?.type),
      personId: null,
    },
    rawText: body,
    body: { text: body, media: [], replyTo: parent === undefined ? null : String(parent) },
    transport: {
      messageId: String(id),
      timestamp: 0,
      mentioned: { self: mentioned.self, others: mentioned.others, all: false },
      isReply: parent !== undefined,
      signature: null,
    },
    declared: { nickname: login, avatar: '' },
    adapter: {
      event: input.event,
      action,
      delivery: input.delivery,
      ...(entity.number === undefined ? {} : { number: entity.number }),
      ...(whole(comment?.id) === undefined ? {} : { commentId: whole(comment?.id) }),
    },
    receivedAt: 0,
  }
}

function actionOf(input: MappingInput, entity: Entity, action: string): InboundMessage {
  const payload = input.payload
  const login = sender(payload, action)
  const summary = summaryOf({ actor: login, event: input.event, action, entity, title: titleOf(payload) })
  const scoped = scopeOf(entity)
  return {
    eventKey: eventKeyOf({ event: input.event, payload, delivery: input.delivery, entity, action }),
    kind: 'action',
    event: {
      postType: input.event,
      type: record(payload.review) === undefined ? semanticClass(input.event) : 'review',
      ...(action === '' ? {} : { subType: action }),
    },
    sessionKey: scoped,
    replyTarget: scoped,
    requestId: input.delivery,
    chainId: scoped,
    source: {
      kind: 'webhook',
      instance: input.config.channel,
      peer: entity.number === undefined ? entity.full : `${entity.full}#${entity.number}`,
      scope: 'group',
    },
    author: {
      senderId: login,
      kind: botOrPerson(input.config.bots, login, record(payload.sender)?.type),
      personId: null,
    },
    rawText: summary,
    body: { text: summary, media: [], replyTo: null },
    transport: {
      messageId: input.delivery,
      timestamp: 0,
      mentioned: { self: false, others: false, all: false },
      isReply: false,
      signature: null,
    },
    declared: { nickname: login, avatar: '' },
    adapter: {
      event: input.event,
      action,
      delivery: input.delivery,
      ...(entity.number === undefined ? {} : { number: entity.number }),
    },
    receivedAt: 0,
  }
}

/** Turns a webhook call into the one inbound event core sees, or says it carries none. */
export function mapWebhook(input: MappingInput): MappingResult {
  const { event, payload } = input
  if (event === 'ping' || event.startsWith('installation')) return { skip: 'ping' }
  const entity = entityOf(payload)
  if (entity === undefined) return { skip: 'malformed' }
  const action = text(payload.action) ?? ''
  const found = bodyOf(payload)
  const written = found.body.length > 0
  const comment = record(payload.comment)
  const review = record(payload.review)
  const message = comment !== undefined ? action === 'created' : review !== undefined && written
  if (message) return { message: messageOf(input, entity, action) }
  return { message: actionOf(input, entity, action) }
}

/** The class name an adapter may list in `events.turn`, e.g. `action.push`. */
export function classOf(message: InboundMessage): string {
  const kind = message.kind ?? 'message'
  const type = message.event?.type ?? 'unknown'
  return `${kind}.${type}`
}

/** Keeps `meta.adapter` under the core limit by dropping the biggest fields first. */
export function fitAdapterMeta(meta: Record<string, unknown>, limit: number): Record<string, unknown> {
  const kept: Record<string, unknown> = { ...meta }
  const size = (value: Record<string, unknown>) => JSON.stringify(value)?.length ?? 0
  for (const key of ['payload', 'title', 'body']) {
    if (size(kept) <= limit) return kept
    delete kept[key]
  }
  for (const key of Object.keys(kept).sort((left, right) => size({ [right]: kept[right] }) - size({ [left]: kept[left] }))) {
    if (size(kept) <= limit) return kept
    delete kept[key]
  }
  return kept
}
