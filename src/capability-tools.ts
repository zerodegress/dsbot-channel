import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CapabilitySet } from './adapter-status.js'
import type { HistoryInput, HistoryResult } from './contract.js'
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
  /** Reads history through the adapter that owns the channel; absent means nothing is wired. */
  history?: ((channel: string, input: HistoryInput) => Promise<HistoryResult>) | undefined
}

function fail(code: CapabilityCode, reason: string): CapabilityFailure {
  return { ok: false, code, retryable: false, reason }
}

/** Names the capability and the channel that lack it, so the model can try another route. */
export class CapabilityGate {
  readonly #router: PushRouter
  readonly #capabilities: CapabilityGateOptions['capabilities']
  readonly #push: CapabilityGateOptions['push']
  readonly #history: CapabilityGateOptions['history']

  constructor(options: CapabilityGateOptions) {
    this.#router = options.router
    this.#capabilities = options.capabilities
    this.#push = options.push
    this.#history = options.history
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

  /** Sends one file from a url through the push router; the receiver's name travels with it. */
  async sendFile(
    request: { url: string; name: string; channel?: string | undefined; target?: string | undefined; idempotencyKey?: string | undefined },
    sessionId: string | undefined,
  ): Promise<CapabilityFailure | { ok: true; messageId: string }> {
    const addressed = this.#router.resolve(request, sessionId)
    if ('ok' in addressed) return addressed
    const channel = addressed.channel.channel
    const capability = this.#capabilities(channel)?.file
    if (capability?.out !== true) {
      return fail(
        UNSUPPORTED_CAPABILITY,
        `channel "${channel}" cannot send files: capabilities.file.out is false; put a link in a text message instead`,
      )
    }
    if (capability.fromUrl !== true) {
      return fail(
        UNSUPPORTED_CAPABILITY,
        `channel "${channel}" cannot send files: capabilities.file.fromUrl is false; put a link in a text message instead`,
      )
    }
    if (this.#push === undefined) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" has no sender wired in this build`)
    }
    const sent = await this.#push(
      {
        text: '',
        channel,
        target: addressed.target,
        ...(request.idempotencyKey === undefined ? {} : { idempotencyKey: request.idempotencyKey }),
        media: [{ type: 'file', url: request.url, handle: null, name: request.name }],
      },
      sessionId,
    )
    return sent.ok ? { ok: true, messageId: sent.messageId } : sent
  }

  /** Reads earlier messages, after asking the segment this address belongs to. */
  async readHistory(
    request: { channel?: string | undefined; target?: string | undefined },
    sessionId: string | undefined,
    query: { limit: number; before?: string | undefined },
  ): Promise<CapabilityFailure | HistoryResult> {
    const addressed = this.#router.resolve(request, sessionId)
    if ('ok' in addressed) return addressed
    const channel = addressed.channel.channel
    const target = addressed.target
    // Core never reads a target: only the transport knows which kind of conversation it names,
    // so it refuses a closed segment itself. Here one fact is enough: neither kind is open.
    const history = this.#capabilities(channel)?.history
    if (history?.group !== true && history?.private !== true) {
      return fail(
        UNSUPPORTED_CAPABILITY,
        `channel "${channel}" cannot read history: capabilities.history.group and .private are both false`,
      )
    }
    if (this.#history === undefined) {
      return fail(UNSUPPORTED_CAPABILITY, `channel "${channel}" has no history reader wired in this build`)
    }
    return this.#history(channel, {
      target,
      limit: query.limit,
      ...(query.before === undefined ? {} : { before: query.before }),
    })
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
      'Send a file to an address on one channel: the url is handed to the platform, and the receiver sees it under `name`.',
    parameters: {
      url: { type: 'string', required: true, description: 'An http(s) address the channel fetches; a local path is not readable by a transport' },
      name: { type: 'string', description: 'The file name the receiver sees; a call without one is refused' },
      channel: { type: 'string', description: 'Adapter instance to send through, e.g. p2p:orca. Omit to use the channel that last messaged this session' },
      target: { type: 'string', description: ADDRESS_NOTE },
      idempotencyKey: { type: 'string', description: 'Repeat this call safely within ten minutes; only a delivered send holds the key' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(
      args: { url: string; name: string; channel?: string; target?: string; idempotencyKey?: string },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const problem = urlProblem(args.url)
      if (problem !== undefined) return JSON.stringify(fail('unsupported_argument', problem))
      if (typeof args.name !== 'string' || args.name.trim().length === 0) {
        return JSON.stringify(fail('unsupported_argument', 'name must be a non-empty file name'))
      }
      return JSON.stringify(await gate.sendFile(args, exec?.agent?.id))
    },
  })
}

/** How many messages a history call asks for when it names no limit, and the most it may ask. */
export const DEFAULT_HISTORY_LIMIT = 50
export const HISTORY_LIMIT_MAX = 200

function historyLimit(value: number | undefined): { ok: true; limit: number } | { ok: false; reason: string } {
  if (value === undefined) return { ok: true, limit: DEFAULT_HISTORY_LIMIT }
  if (!Number.isInteger(value) || value < 1 || value > HISTORY_LIMIT_MAX) {
    return { ok: false, reason: `limit must be a whole number between 1 and ${HISTORY_LIMIT_MAX}: ${String(value)}` }
  }
  return { ok: true, limit: value }
}

/** Reads earlier messages from an address, one page at a time. */
export function createReadHistory(gate: CapabilityGate) {
  return defineTool({
    name: 'read_history',
    description:
      'Read earlier messages from an address on one channel, newest page first. The answer names the cursor to ask for the page before it.',
    parameters: {
      channel: { type: 'string', description: 'Adapter instance to read through, e.g. onebot:main. Omit to use the channel that last messaged this session' },
      target: { type: 'string', description: ADDRESS_NOTE },
      limit: { type: 'number', description: `How many messages this page asks for; a whole number between 1 and ${HISTORY_LIMIT_MAX}, default ${DEFAULT_HISTORY_LIMIT}` },
      before: { type: 'string', description: 'The cursor the previous page answered with; omit for the newest page' },
    },
    output: {
      schema: { type: 'string' as const },
      render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
    },
    async execute(
      args: { channel?: string; target?: string; limit?: number; before?: string },
      exec: { agent?: { id?: string } },
    ): Promise<string> {
      const sized = historyLimit(args.limit)
      if (!sized.ok) return JSON.stringify(fail('unsupported_argument', sized.reason))
      const answered = await gate.readHistory(args, exec?.agent?.id, {
        limit: sized.limit,
        ...(args.before === undefined ? {} : { before: args.before }),
      })
      return JSON.stringify(answered)
    },
  })
}

export type SendImageTool = ReturnType<typeof createSendImage>
export type SendFileTool = ReturnType<typeof createSendFile>
export type ReadHistoryTool = ReturnType<typeof createReadHistory>