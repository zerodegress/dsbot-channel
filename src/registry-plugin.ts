import type { Context } from '@deepseek-ai/cordis'
import { createWarn } from './warn.js'
import { AdapterRegistry, REGISTRY_SERVICE } from './adapter-registry.js'
import { createOneBotAdapter } from './adapters/onebot/index.js'
import { createMailAdapter } from './adapters/mail/index.js'
import { createWebhookAdapter } from './adapters/webhook/index.js'
import { createP2PAdapter } from './adapters/p2p/index.js'

/** The composition root for transports: mounted before the adapters and the gateway. */
export const registryPlugin = {
  name: 'dsbot-channel/registry',
  apply(ctx: Context): void {
    if (ctx.get(REGISTRY_SERVICE) !== undefined) {
      createWarn(ctx)('dsbot-channel: a registry already exists in this context; the second mount keeps the first')
      return
    }
    const registry = new AdapterRegistry()
    registry.builtin('p2p', createP2PAdapter)
    registry.builtin('onebot', createOneBotAdapter)
    registry.builtin('mail', createMailAdapter)
    registry.builtin('webhook', createWebhookAdapter)
    ctx.provide(REGISTRY_SERVICE)
    ctx.set(REGISTRY_SERVICE, registry)
  },
}

export default registryPlugin
