import type { DerivedMeta, TransportMeta } from './event-types.js'

export const LAYERS = ['transport', 'derived', 'declared'] as const
export type Layer = (typeof LAYERS)[number]

export class LayerViolationError extends Error {
  readonly layer: Layer
  readonly field: string

  constructor(layer: Layer, field: string) {
    super(`field "${field}" belongs to the ${layer} layer and cannot be used here`)
    this.name = 'LayerViolationError'
    this.layer = layer
    this.field = field
  }
}

const closed = Symbol('declared-values')

export interface DeclaredLayer {
  readonly [closed]: Readonly<Record<string, unknown>>
}

export function transportLayer(meta: TransportMeta & { kind?: string; instance?: string }): TransportMeta {
  return { messageId: meta.messageId, timestamp: meta.timestamp, mentioned: meta.mentioned, isReply: meta.isReply, signature: meta.signature }
}

export function derivedLayer(meta: DerivedMeta): DerivedMeta {
  return { eventKey: meta.eventKey, contentHash: meta.contentHash }
}

export function declareLayer(values: Readonly<Record<string, unknown>>): DeclaredLayer {
  return Object.freeze({ [closed]: Object.freeze({ ...values }) })
}

function held(declared: DeclaredLayer): Readonly<Record<string, unknown>> {
  if (typeof declared !== 'object' || declared === null) throw new LayerViolationError('declared', '<value>')
  return declared[closed]
}

export function readDeclared<T = unknown>(declared: DeclaredLayer, field: string): T {
  void held(declared)
  throw new LayerViolationError('declared', field)
}
