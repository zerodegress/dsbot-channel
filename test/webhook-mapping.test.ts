import { describe, expect, test } from 'vitest'
import {
  classOf,
  fitAdapterMeta,
  mapWebhook,
  mentionsOf,
  summaryOf,
} from '../src/adapters/webhook/mapping.js'

const config = { channel: 'gh:acme/api', login: 'acme-bot', bots: ['ci-bot'] }

const repo = { name: 'api', owner: { login: 'acme' } }

const issue = { number: 12, title: 'Fix the parser', updated_at: '2026-01-02T03:04:05Z' }

const comment = (overrides: Record<string, unknown> = {}) => ({
  id: 77,
  body: 'hello there',
  user: { login: 'seal', type: 'User' },
  ...overrides,
})

const map = (event: string, payload: Record<string, unknown>, delivery = 'd-1') =>
  mapWebhook({ dialect: 'github', event, delivery, payload, config })

describe('a webhook comment becomes a message', () => {
  test('an issue comment maps to the issue room', () => {
    const mapped = map('issue_comment', {
      action: 'created',
      repository: repo,
      issue,
      comment: comment({ body: 'ping @acme-bot please' }),
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    const message = mapped.message
    expect(message.kind).toBe('message')
    expect(message.sessionKey).toBe('gh:acme/api#12')
    expect(message.replyTarget).toBe('gh:acme/api#12')
    expect(message.chainId).toBe('gh:acme/api#12')
    expect(message.body.text).toBe('ping @acme-bot please')
    expect(message.rawText).toBe('ping @acme-bot please')
    expect(message.eventKey).toBe('comment:77')
    expect(message.requestId).toBe('77')
    expect(message.transport.mentioned).toEqual({ self: true, others: false, all: false })
    expect(message.author).toMatchObject({ senderId: 'seal', kind: 'person' })
    expect(message.body.replyTo).toBeNull()
    expect(message.source).toMatchObject({ kind: 'webhook', instance: 'gh:acme/api', scope: 'group' })
  })

  test('a review comment carries the parent it answers', () => {
    const mapped = map('pull_request_review_comment', {
      action: 'created',
      repository: repo,
      pull_request: { number: 9, title: 'Add a lane', updated_at: '2026-01-02T03:04:06Z' },
      comment: comment({ id: 78, in_reply_to_id: 55, body: 'agreed' }),
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.eventKey).toBe('review_comment:78')
    expect(mapped.message.body.replyTo).toBe('55')
    expect(mapped.message.transport.isReply).toBe(true)
    expect(mapped.message.sessionKey).toBe('gh:acme/api#9')
  })

  test('a bot login becomes bot speech', () => {
    const mapped = map('issue_comment', {
      action: 'created',
      repository: repo,
      issue,
      comment: comment({ user: { login: 'ci-bot', type: 'User' } }),
      sender: { login: 'ci-bot', type: 'User' },
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.author.kind).toBe('bot')
  })
})

describe('a webhook action becomes a one line event', () => {
  test('an issue opened is an action with a stable summary', () => {
    const mapped = map('issues', {
      action: 'opened',
      repository: repo,
      issue,
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    const message = mapped.message
    expect(message.kind).toBe('action')
    expect(message.event).toEqual({ postType: 'issues', type: 'issues', subType: 'opened' })
    expect(classOf(message)).toBe('action.issues')
    expect(message.body.text).toBe('seal opened issue acme/api#12: Fix the parser')
    expect(message.rawText).toBe(message.body.text)
    expect(message.eventKey).toBe('issue:acme/api#12:opened:2026-01-02T03:04:05Z')
    expect(message.sessionKey).toBe('gh:acme/api#12')
    expect(message.transport.mentioned).toEqual({ self: false, others: false, all: false })
  })

  test('a push is a repo level action keyed by its head', () => {
    const mapped = map('push', {
      repository: repo,
      ref: 'refs/heads/main',
      after: 'abc123',
      head_commit: { id: 'abc123', message: 'fix: the thing' },
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(classOf(mapped.message)).toBe('action.push')
    expect(mapped.message.sessionKey).toBe('gh:acme/api')
    expect(mapped.message.eventKey).toBe('push:acme/api:abc123')
    expect(mapped.message.body.text).toBe('seal push acme/api: fix: the thing')
  })

  test('another event keeps its own class', () => {
    const mapped = map('fork', { repository: repo, sender: { login: 'seal', type: 'User' } })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(classOf(mapped.message)).toBe('action.fork')
  })

  test('a comment edit is not the comment creation', () => {
    const created = map('issue_comment', {
      action: 'created',
      repository: repo,
      issue,
      comment: comment(),
      sender: { login: 'seal', type: 'User' },
    })
    const edited = map('issue_comment', {
      action: 'edited',
      repository: repo,
      issue,
      comment: comment(),
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in created) || !('message' in edited)) throw new Error('expected messages')
    expect(created.message.eventKey).toBe('comment:77')
    expect(edited.message.eventKey).toBe('comment:77:edited')
  })

  test('two ci runs of one repo keep their own identity', () => {
    const one = map('status', {
      repository: repo,
      sha: 'aaa',
      context: 'ci/build',
      state: 'success',
      sender: { login: 'seal', type: 'User' },
    })
    const two = map('status', {
      repository: repo,
      sha: 'bbb',
      context: 'ci/build',
      state: 'success',
      sender: { login: 'seal', type: 'User' },
    })
    if (!('message' in one) || !('message' in two)) throw new Error('expected messages')
    expect(one.message.eventKey).not.toBe(two.message.eventKey)
    expect(one.message.eventKey).toContain('aaa')
    expect(one.message.eventKey).toContain('ci/build')
  })

  test('forgejo names its pull request conversation comment', () => {
    const mapped = mapWebhook({
      dialect: 'forgejo',
      event: 'pull_request_comment',
      delivery: 'f-1',
      payload: {
        action: 'created',
        repository: repo,
        pull_request: { number: 4, title: 'A lane', updated_at: '2026-01-02T03:04:07Z' },
        comment: { id: 91, body: 'looks good', user: { login: 'seal' } },
        sender: { login: 'seal' },
      },
      config,
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.kind).toBe('message')
    expect(mapped.message.body.text).toBe('looks good')
    expect(mapped.message.sessionKey).toBe('gh:acme/api#4')
  })

  test('forgejo keys the conversation comment by its comment id', () => {
    const mapped = mapWebhook({
      dialect: 'forgejo',
      event: 'pull_request_comment',
      delivery: 'f-2',
      payload: {
        action: 'created',
        repository: repo,
        pull_request: { number: 4, title: 'A lane', updated_at: '2026-01-02T03:04:07Z' },
        comment: { id: 91, body: 'looks good', user: { login: 'seal' } },
        sender: { login: 'seal' },
      },
      config,
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.eventKey).toBe('comment:91')
  })

  test('a forgejo review without a body stays an action of class review', () => {
    const mapped = mapWebhook({
      dialect: 'forgejo',
      event: 'pull_request_approved',
      delivery: 'f-3',
      payload: {
        action: 'approved',
        repository: repo,
        pull_request: { number: 4, title: 'A lane', updated_at: '2026-01-02T03:04:07Z' },
        review: { id: 92, body: '', user: { login: 'seal' } },
        sender: { login: 'seal' },
      },
      config,
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.kind).toBe('action')
    expect(classOf(mapped.message)).toBe('action.review')
    expect(mapped.message.eventKey).toBe('review:92:approved')
  })

  test('a forgejo approval with a body is a message', () => {
    const mapped = mapWebhook({
      dialect: 'forgejo',
      event: 'pull_request_approved',
      delivery: 'f-4',
      payload: {
        action: 'approved',
        repository: repo,
        pull_request: { number: 4, title: 'A lane', updated_at: '2026-01-02T03:04:07Z' },
        review: { id: 93, body: 'ship it', user: { login: 'seal' } },
        sender: { login: 'seal' },
      },
      config,
    })
    if (!('message' in mapped)) throw new Error('expected a message')
    expect(mapped.message.kind).toBe('message')
    expect(mapped.message.body.text).toBe('ship it')
    expect(mapped.message.eventKey).toBe('review:93')
  })

  test('a ping carries no event', () => {
    expect(map('ping', { zen: 'hi', repository: repo })).toEqual({ skip: 'ping' })
  })
})

describe('the summary text never reads the clock', () => {
  test('the same facts read the same twice', () => {
    const entity = { owner: 'acme', repo: 'api', full: 'acme/api', number: 12 }
    const one = summaryOf({ actor: 'seal', event: 'issues', action: 'closed', entity, title: 'Done' })
    const two = summaryOf({ actor: 'seal', event: 'issues', action: 'closed', entity, title: 'Done' })
    expect(one).toBe(two)
    expect(one).toBe('seal closed issue acme/api#12: Done')
  })
})

describe('mentions ignore code', () => {
  test('an address inside a fence or inline code is not a mention', () => {
    expect(mentionsOf('```\n@acme-bot\n```\n`@acme-bot`', 'acme-bot')).toEqual({ self: false, others: false })
  })

  test('other logins and teams count as others', () => {
    expect(mentionsOf('ping @other and @acme/team', 'acme-bot')).toEqual({ self: false, others: true })
    expect(mentionsOf('ping @ACME-BOT', 'acme-bot')).toEqual({ self: true, others: false })
  })
})

describe('the adapter payload stays inside the core limit', () => {
  test('a big payload is dropped before the rest', () => {
    const meta = { event: 'push', action: '', payload: { blob: 'x'.repeat(9000) } }
    expect(JSON.stringify(fitAdapterMeta(meta, 8192)).length).toBeLessThanOrEqual(8192)
    expect(fitAdapterMeta(meta, 8192)).toEqual({ event: 'push', action: '' })
  })

  test('a small payload is kept whole', () => {
    const meta = { event: 'push', payload: { ref: 'main' } }
    expect(fitAdapterMeta(meta, 8192)).toEqual(meta)
  })
})
