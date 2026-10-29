import type { Context } from '@deepseek-ai/cordis'

export type Warn = (message: string) => void

const SCOPE = 'dsbot-channel'

function toStderr(message: string): void {
  try {
    process.stderr.write(`${message}\n`)
  } catch {
    return
  }
}

/** Warns through the host logger, and through stderr when there is none. */
export function createWarn(ctx: Context): Warn {
  return (message: string): void => {
    let logged = false
    try {
      const logger = ctx.logger?.(SCOPE)
      if (typeof logger?.warn === 'function') {
        logger.warn(message)
        logged = true
      }
    } catch {
      logged = false
    }
    if (!logged) toStderr(message)
  }
}
