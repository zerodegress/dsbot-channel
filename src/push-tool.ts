import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SendFailureCode, SendResult } from './p2p-send.js'

export const PUSH_WINDOW_MS = 10 * 60 * 1000
export const PUSH_SCOPES = ['c2c', 'group', 'p2p'] as const
export const PUSH_SCOPE = 'p2p'

export type PushCode = SendFailureCode | 'unknown_channel' | 'unknown_target' | 'no_source' | 'no_target' | 'unsupported_scope'

export interface PushPeer {
  instance: string
  botName?: string
  host?: string
}

export interface PushChannel {
  channel: string
  instance: string
  botName: string
  peers: PushPeer[]
}

export interface PushSource {
  channel: string
  peer: string
}

export interface PushRequest {
  text: string
  channel?: string
  scope?: string
  target?: string
  idempotencyKey?: string
}

export interface PushSent {
  ok: true
  messageId: string
  channel: string
  scope: string
  target: string
}

export interface PushFailed {
  ok: false
  code: PushCode
  retryable: boolean
  reason: string
}

export type PushResult = PushSent | PushFailed

export interface PushDelivery {
  channel: string
  peer: string
  to: string
  text: string
  eventId: string
}

export interface PushRouterOptions {
  channels: PushChannel[]
  send: (delivery: PushDelivery) => Promise<SendResult>
  source: (sessionId: string | undefined) => PushSource | undefined
  now?: (() => number) | undefined
  newId?: (() => string) | undefined
}

function fail(code: PushCode, retryable: boolean, reason: string): PushFailed {
  return { ok: false, code, retryable, reason }
}

/** Resolves an address to one peer, and keeps a push idempotent without charging the wire id. */
export class PushRouter {
  readonly #channels: PushChannel[]
  readonly #send: PushRouterOptions['send']
  readonly #source: PushRouterOptions['source']
  readonly #now: () => number
  readonly #newId: () => string
  readonly #keys = new Map<string, { result: PushSent; at: number }>()

  constructor(options: PushRouterOptions) {
    this.#channels = options.channels
    this.#send = options.send
    this.#source = options.source
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  get channels(): readonly PushChannel[] {
    return this.#channels
  }

  #live(key: string): PushSent | undefined {
    const entry = this.#keys.get(key)
    if (entry === undefined) return undefined
    if (this.#now() - entry.at >= PUSH_WINDOW_MS) {
      this.#keys.delete(key)
      return undefined
    }
    return entry.result
  }

  #address(request: PushRequest, sessionId: string | undefined): { channel: PushChannel; peer: PushPeer } | PushFailed {
    if (request.scope !== undefined && request.scope !== PUSH_SCOPE) {
      const known = PUSH_SCOPES.join(', ')
      return fail('unsupported_scope', false, `a peer link carries "${PUSH_SCOPE}" only, not "${request.scope}"; scopes: ${known}`)
    }
    const source = this.#source(sessionId)
    let channel: PushChannel | undefined
    if (request.channel === undefined) {
      if (source === undefined) return fail('no_source', false, 'no peer has messaged this session, so name a channel')
      channel = this.#channels.find((candidate) => candidate.channel === source.channel)
      if (channel === undefined) return fail('unknown_channel', false, `channel "${source.channel}" is no longer configured`)
    } else {
      channel = this.#channels.find((candidate) => candidate.channel === request.channel)
      if (channel === undefined) {
        const known = this.#channels.map((candidate) => candidate.channel).join(', ')
        return fail('unknown_channel', false, `channel "${request.channel}" is not this bot's; known: ${known}`)
      }
    }
    const wanted = request.target ?? (source !== undefined && source.channel === channel.channel ? source.peer : undefined)
    if (wanted === undefined) {
      return fail('no_target', false, `channel "${channel.channel}" has no peer to inherit; name a target`)
    }
    const peer = channel.peers.find((candidate) => candidate.instance === wanted)
    if (peer === undefined) {
      const known = channel.peers.map((candidate) => candidate.instance).join(', ')
      return fail('unknown_target', false, `channel "${channel.channel}" has no peer "${wanted}"; known: ${known}`)
    }
    if (peer.botName === undefined || peer.botName.length === 0) {
      return fail('unknown_target', false, `peer "${wanted}" has no botName, so an active push has no address`)
    }
    return { channel, peer }
  }

  async push(request: PushRequest, sessionId?: string): Promise<PushResult> {
    const key = request.idempotencyKey
    if (key !== undefined) {
      const replay = this.#live(key)
      if (replay !== undefined) return replay
    }
    const addressed = this.#address(request, sessionId)
    if ('ok' in addressed) return addressed
    const { channel, peer } = addressed
    const eventId = `push:${this.#newId()}`
    const sent = await this.#send({
      channel: channel.channel,
      peer: peer.instance,
      to: peer.botName as string,
      text: request.text,
      eventId,
    })
    if (!sent.ok) return fail(sent.code, sent.retryable, sent.reason)
    const result: PushSent = {
      ok: true,
      messageId: sent.messageId,
      channel: channel.channel,
      scope: PUSH_SCOPE,
      target: peer.instance,
    }
    if (key !== undefined) this.#keys.set(key, { result, at: this.#now() })
    return result
  }
}

export function describeChannels(channels: readonly PushChannel[]): string {
  if (channels.length === 0) return 'No channel is configured, so this bot cannot send.'
  const lines = channels.map((channel) => {
    const peers = channel.peers.map((peer) => peer.instance).join(', ')
    return `${channel.channel} (peers: ${peers.length === 0 ? 'none' : peers})`
  })
  return `Channels: ${lines.join('; ')}.`
}

/** Builds the send_text tool: one exit for an active push, the same sender as a reply. */
export function createSendText(router: PushRouter) {
  return defineTool({
    name: 'send_text',
    description: `Send a text message to a peer over a peer link. ${describeChannels(router.channels)} Without a channel the last peer that messaged this session is used; a target names a peer instance.`,
    parameters: {
      text: { type: 'string', required: true, description: 'The message body to deliver' },
      channel: { type: 'string', description: 'Adapter instance to send through, e.g. p2p:orca. Omit to answer the current peer' },
      scope: { type: 'string', enum: [...PUSH_SCOPES], description: `Where the message lands; a peer link carries "${PUSH_SCOPE}" only` },
      target: { type: 'string', description: 'Peer instance on that channel, e.g. seal' },
      idempotencyKey: { type: 'string', description: 'Repeat this call safely within ten minutes; only a delivered push holds the key' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(args: PushRequest, exec: { agent?: { id?: string } }): Promise<string> {
      return JSON.stringify(await router.push(args, exec?.agent?.id))
    },
  })
}

export type SendTextTool = ReturnType<typeof createSendText>
