import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CapabilitySet } from './adapter-status.js'
import type { MediaType } from './event-types.js'
import type { PushCode, PushRequest, PushResult, PushRouter } from './push-tool.js'

/** A tool that needs a capability answers this instead of pretending the channel can carry it. */
export const UNSUPPORTED_CAPABILITY = 'unsupported_capability'

export type CapabilityCode = PushCode | typeof UNSUPPORTED_CAPABILITY

export interface CapabilityFailure {
  ok: false
  code: CapabilityCode
  retryable: boolean
  reason: string
}

export interface CapabilityGateOptions {
  router: PushRouter
  /** Delivers through the same router a text push uses; absent means no sender is wired. */
  push?: ((request: PushRequest, sessionId?: string) => Promise<PushResult>) | undefined
  /** The static capability set the adapter declared at mount time, never a sampled status. */
  capabilities: (channel: string) => CapabilitySet | undefined
}

function fail(code: CapabilityCode, reason: string): CapabilityFailure {
  return { ok: false, code, retryable: false, reason }
}

/** Names the capability and the channel that lack it, so the model can try another route. */
export class CapabilityGate {
  readonly #router: PushRouter
  readonly #capabilities: CapabilityGateOptions['capabilities']
  readonly #push: CapabilityGateOptions['push']

  constructor(options: CapabilityGateOptions) {
    this.#router = options.router
    this.#capabilities = options.capabilities
    this.#push = options.push
  }

  /** Sends one image from a url through the push router; the caption rides the text field. */
  async sendImage(
    request: { url: string; caption?: string | undefined; channel?: string | undefined; target?: string | undefined; idempotencyKey?: string | undefined },
    sessionId: string | undefined,
  ): Promise<CapabilityFailure | { ok: true; messageId: string }> {
    const addressed = this.#router.resolve(request, sessionId)
    if ('ok' in addressed) return addressed
    const channel = addressed.channel.channel
    const capability = this.#capabilities(channel)?.image
    if (capability?.out !== true) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" cannot send images: capabilities.image.out is false`)
    }
    if (capability.fromUrl !== true) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" cannot send images: capabilities.image.fromUrl is false`)
    }
    if (this.#push === undefined) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" has no sender wired in this build`)
    }
    const sent = await this.#push(
      {
        text: request.caption ?? '',
        channel,
        target: addressed.target,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        media: [{ type: 'image', url: request.url, handle: null }],
      },
      sessionId,
    )
    return sent.ok ? { ok: true, messageId: sent.messageId } : sent
  }

  refuse(
    request: { channel?: string | undefined; target?: string | undefined },
    sessionId: string | undefined,
    capability: 'text' | 'mention' | 'reply' | 'recall' | 'history' | 'stream',
    action: string,
    hint: string,
  ): CapabilityFailure {
    const addressed = this.#router.resolve(request, sessionId)
    if ('ok' in addressed) return addressed
    const channel = addressed.channel.channel
    const declared = this.#declares(channel, capability)
    if (!declared) {
      const named =
        capability === 'history'
          ? 'capabilities.history.group and .private are both false'
          : `capabilities.${capability} is false`
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" cannot ${action}: ${named}; ${hint}`)
    }
    return fail(
      UNSUPPORTED_CAPABILITY,
      `channel "${channel}" declares capabilities.${capability}, but this build carries no sender for it yet`,
    )
  }

  /** History is two answers in one field, so it is asked separately. */
  #declares(channel: string, capability: 'text' | 'mention' | 'reply' | 'recall' | 'history' | 'stream'): boolean {
    const caps = this.#capabilities(channel)
    if (caps === undefined) return false
    if (capability === 'history') return caps.history.group || caps.history.private
    return caps[capability] === true
  }

  /** A media call asks two questions: can this transport send the type, and from the source it was given. */
  refuseMedia(
    request: { channel?: string | undefined; target?: string | undefined },
    sessionId: string | undefined,
    type: MediaType,
    source: 'url' | 'handle',
    action: string,
    hint: string,
  ): CapabilityFailure {
    const addressed = this.#router.resolve(request, sessionId)
    if ('ok' in addressed) return addressed
    const channel = addressed.channel.channel
    const capability = this.#capabilities(channel)?.[type]
    if (capability?.out !== true) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" cannot ${action}: capabilities.${type}.out is false; ${hint}`)
    }
    const from = source === 'url' ? capability.fromUrl : capability.fromHandle
    if (from !== true) {
      return fail(
        UNSUPPORTED_CAPABILITY,
        `channel "${channel}" cannot ${action}: capabilities.${type}.${source === 'url' ? 'fromUrl' : 'fromHandle'} is false; ${hint}`,
      )
    }
    return fail(
      UNSUPPORTED_CAPABILITY,
      `channel "${channel}" declares capabilities.${type}, but this build carries no sender for it yet`,
    )
  }
}

const ADDRESS_NOTE = 'Address on that channel, as the channel names it'

function urlProblem(url: unknown): string | undefined {
  if (typeof url !== 'string' || url.trim().length === 0) return 'url must be a non-empty string'
  if (!/^https?:\/\//i.test(url.trim())) {
    return `url must be an http(s) address the channel can fetch, not "${url.trim()}": a transport cannot read a local path`
  }
  return undefined
}

function limitProblem(limit: unknown): string | undefined {
  if (limit === undefined) return undefined
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    return `limit must be a whole number of at least 1: ${String(limit)}`
  }
  return undefined
}

/** Sends an image to an address; this version has no image sender, so it answers why. */
export function createSendImage(gate: CapabilityGate) {
  return defineTool({
    name: 'send_image',
    description:
      'Send an image from an http(s) url to an address on one channel. A caption rides the same text field a message uses.',
    parameters: {
      url: { type: 'string', required: true, description: 'An http(s) address the channel fetches; a local path is not readable by a transport' },
      caption: { type: 'string', description: 'One optional line to send beside the image' },
      channel: { type: 'string', description: 'Adapter instance to send through, e.g. p2p:orca. Omit to use the channel that last messaged this session' },
      target: { type: 'string', description: ADDRESS_NOTE },
      idempotencyKey: { type: 'string', description: 'Repeat this call safely within ten minutes; only a delivered send holds the key' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(
      args: { url: string; caption?: string; channel?: string; target?: string; idempotencyKey?: string },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const problem = urlProblem(args.url)
      if (problem !== undefined) return JSON.stringify(fail('unsupported_argument', problem))
      return JSON.stringify(await gate.sendImage(args, exec?.agent?.id))
    },
  })
}

/** Sends a file to an address; this version has no file sender, so it answers why. */
export function createSendFile(gate: CapabilityGate) {
  return defineTool({
    name: 'send_file',
    description:
      'Send a file to an address on one channel. This build declares no file sender, so a call answers why it cannot.',
    parameters: {
      url: { type: 'string', required: true, description: 'An http(s) address the channel fetches; a local path is not readable by a transport' },
      caption: { type: 'string', description: 'One optional line to send beside the file' },
      channel: { type: 'string', description: 'Adapter instance to send through, e.g. p2p:orca. Omit to use the channel that last messaged this session' },
      target: { type: 'string', description: ADDRESS_NOTE },
      idempotencyKey: { type: 'string', description: 'Repeat this call safely within ten minutes; only a delivered send holds the key' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(
      args: { url: string; caption?: string; channel?: string; target?: string; idempotencyKey?: string },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const problem = urlProblem(args.url)
      if (problem !== undefined) return JSON.stringify(fail('unsupported_argument', problem))
      return JSON.stringify(
        gate.refuseMedia(args, exec?.agent?.id, 'file', 'url', 'send files', 'put a link in a text message instead'),
      )
    },
  })
}

/** Reads recent messages from an address; this version has no history transport, so it answers why. */
export function createReadHistory(gate: CapabilityGate) {
  return defineTool({
    name: 'read_history',
    description:
      'Read recent messages from an address on one channel. This build declares no history transport, so a call answers why it cannot.',
    parameters: {
      channel: { type: 'string', description: 'Adapter instance to read through, e.g. onebot:main. Omit to use the channel that last messaged this session' },
      target: { type: 'string', description: ADDRESS_NOTE },
      limit: { type: 'number', description: 'How many recent messages to ask for; a whole number of at least 1' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(
      args: { channel?: string; target?: string; limit?: number },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const problem = limitProblem(args.limit)
      if (problem !== undefined) return JSON.stringify(fail('unsupported_argument', problem))
      return JSON.stringify(
        gate.refuse(args, exec?.agent?.id, 'history', 'read history', 'ask the peer to resend the messages you need'),
      )
    },
  })
}

export type SendImageTool = ReturnType<typeof createSendImage>
export type SendFileTool = ReturnType<typeof createSendFile>
export type ReadHistoryTool = ReturnType<typeof createReadHistory>