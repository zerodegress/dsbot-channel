import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SendFailureCode, SendResult } from './contract.js'

export const PUSH_WINDOW_MS = 10 * 60 * 1000

export type PushCode =
  | SendFailureCode
  | 'unknown_channel'
  | 'unknown_target'
  | 'no_source'
  | 'no_target'
  | 'unsupported_argument'

export interface PushChannel {
  channel: string
  instance: string
  botName: string
}

export interface PushSource {
  channel: string
  /** The address this session answers on; the adapter gave it to core unparsed. */
  replyTarget: string
  /** The bot identity that last messaged this session, when the transport reported one. */
  sender?: string | undefined
}

export interface PushRequest {
  text: string
  channel?: string
  target?: string
  idempotencyKey?: string
}

export interface PushSent {
  ok: true
  messageId: string
  channel: string
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
  /** The adapter's own address for the recipient. */
  target: string
  /** The bot identity the message is addressed to, when core knows it. */
  to?: string | undefined
  text: string
  eventId: string
}

export interface PushRouterOptions {
  channels: PushChannel[]
  send: (delivery: PushDelivery) => Promise<SendResult>
  source: (sessionId: string | undefined) => PushSource | undefined
  /** Asks the adapter whether it can address this target, and why not. */
  checkTarget: (channel: string, target: string) => string | undefined
  /** The adapter's own one-line list of addresses, for the tool description and errors. */
  describeTargets: (channel: string) => string
  /** Called after a push is delivered, so the turn that asked for it knows not to answer twice. */
  delivered?: ((sessionId: string | undefined) => void) | undefined
  now?: (() => number) | undefined
  newId?: (() => string) | undefined
}

function fail(code: PushCode, retryable: boolean, reason: string): PushFailed {
  return { ok: false, code, retryable, reason }
}

/** Routes an active push to the adapter that owns the address. */
export class PushRouter {
  readonly #channels: PushChannel[]
  readonly #send: PushRouterOptions['send']
  readonly #source: PushRouterOptions['source']
  readonly #checkTarget: PushRouterOptions['checkTarget']
  readonly #describeTargets: PushRouterOptions['describeTargets']
  readonly #delivered: PushRouterOptions['delivered']
  readonly #now: () => number
  readonly #newId: () => string
  readonly #keys = new Map<string, { result: PushSent; at: number }>()

  constructor(options: PushRouterOptions) {
    this.#channels = options.channels
    this.#send = options.send
    this.#source = options.source
    this.#checkTarget = options.checkTarget
    this.#describeTargets = options.describeTargets
    this.#delivered = options.delivered
    this.#now = options.now ?? Date.now
    this.#newId = options.newId ?? (() => crypto.randomUUID())
  }

  get channels(): readonly PushChannel[] {
    return this.#channels
  }

  /** The channel-by-channel description the tool hands the model. */
  describe(): string {
    if (this.#channels.length === 0) return 'No channel is configured, so this bot cannot send.'
    const lines = this.#channels.map((channel) => {
      const targets = this.#describeTargets(channel.channel)
      return `${channel.channel} (addresses: ${targets.length === 0 ? 'none' : targets})`
    })
    return `Channels: ${lines.join('; ')}.`
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

  #address(
    request: PushRequest,
    sessionId: string | undefined,
  ): { channel: PushChannel; target: string; to?: string } | PushFailed {
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
    const inherited = source !== undefined && source.channel === channel.channel ? source : undefined
    const target = request.target ?? inherited?.replyTarget
    if (target === undefined) {
      return fail('no_target', false, `channel "${channel.channel}" has no address to inherit; name a target`)
    }
    const problem = this.#checkTarget(channel.channel, target)
    if (problem !== undefined) {
      return fail(
        'unknown_target',
        false,
        `channel "${channel.channel}" cannot address "${target}": ${problem}; ${this.#describeTargets(channel.channel)}`,
      )
    }
    return {
      channel,
      target,
      ...(target === inherited?.replyTarget && inherited?.sender !== undefined ? { to: inherited.sender } : {}),
    }
  }

  async push(request: PushRequest, sessionId?: string): Promise<PushResult> {
    const legacy = (request as { scope?: unknown }).scope
    if (legacy !== undefined) {
      return fail(
        'unsupported_argument',
        false,
        `the scope argument is gone: the address itself says where a message goes, so name it in target instead of "${String(legacy)}"`,
      )
    }
    const key = request.idempotencyKey
    if (key !== undefined) {
      const replay = this.#live(key)
      if (replay !== undefined) return replay
    }
    const addressed = this.#address(request, sessionId)
    if ('ok' in addressed) return addressed
    const { channel, target, to } = addressed
    const eventId = `push:${this.#newId()}`
    const sent = await this.#send({
      channel: channel.channel,
      target,
      ...(to === undefined ? {} : { to }),
      text: request.text,
      eventId,
    })
    if (!sent.ok) return fail(sent.code, sent.retryable, sent.reason)
    const result: PushSent = {
      ok: true,
      messageId: sent.messageId,
      channel: channel.channel,
      target,
    }
    if (key !== undefined) this.#keys.set(key, { result, at: this.#now() })
    this.#delivered?.(sessionId)
    return result
  }
}

/** Builds the send_text tool: one exit for an active push, the same sender as a reply. */
export function createSendText(router: PushRouter) {
  return defineTool({
    name: 'send_text',
    description: `Send a text message over one channel. ${router.describe()} Without a channel the one that last messaged this session is used; a target names an address on that channel, as its describeTargets lists it.`,
    parameters: {
      text: { type: 'string', required: true, description: 'The message body to deliver' },
      channel: { type: 'string', description: 'Adapter instance to send through, e.g. p2p:orca. Omit to answer where the last message came from' },
      target: { type: 'string', description: 'Address on that channel, as the channel names it' },
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
