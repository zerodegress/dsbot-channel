export type Config = Record<string, never>

/** Multi-channel ingress gateway for ds-bot. */
export const name = 'dsbot-channel'

export function apply() {}

export const plugin = { name, apply }

export default plugin
