import type { TurnRef } from './control-tools.js'

interface ToolLike {
  execute: (...args: never[]) => unknown
}

/** Wraps a tool so the turn records that a tool ran, even when the tool then throws. */
export function markToolRan<T extends ToolLike>(
  definition: T,
  turnOf: (sessionId: string | undefined) => TurnRef | undefined,
): T {
  const execute = (definition.execute as unknown as (...args: unknown[]) => unknown).bind(definition)
  return {
    ...definition,
    execute(...args: unknown[]): unknown {
      const exec = args[1] as { agent?: { id?: string } } | undefined
      const turn = turnOf(exec?.agent?.id)
      if (turn !== undefined) turn.toolRan = true
      return execute(...args)
    },
  } as T
}
