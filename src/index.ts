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
export { signBody, verifyRequest, digestBody } from './p2p-auth.js'
export type { AuthInput, AuthResult, PeerSecret } from './p2p-auth.js'
export { DedupeTable } from './p2p-dedupe.js'
export type { DedupeEntry, DedupeOptions } from './p2p-dedupe.js'
export { toP2PEvent } from './p2p-mapping.js'
export type { P2PInbound } from './p2p-mapping.js'
export { MAX_BODY_BYTES, P2P_ROUTE, handleMessage, parseRequest } from './p2p-protocol.js'
export type { HandleInput, HandleResult, P2PConfig, P2PPayload, Parsed } from './p2p-protocol.js'
