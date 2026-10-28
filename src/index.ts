export type Config = Record<string, never>

/** Multi-channel ingress gateway for ds-bot. */
export const name = 'dsbot-channel'

export function apply() {}

export const plugin = { name, apply }

export default plugin

export * from './event-types.js'
export { contentHash, eventKey } from './event-key.js'
export { LAYERS, LayerViolationError, declareLayer, derivedLayer, readDeclared, transportLayer } from './event-layers.js'
export type { DeclaredLayer, Layer } from './event-layers.js'
export { buildEvent, chargeKey, dedupeKeyFor, replyIdempotencyKey, unstableDedupeKey } from './event-build.js'
export { ConfigError, WILDCARD_HOSTS, assertBindHost, strict, validateConfig } from './config.js'
