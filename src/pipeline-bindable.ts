import type { PipelineNodeSpec } from './pipeline-config.js'

/** Nodes whose work this version does not supply, so declaring one would run nothing. */
export const UNBOUND_REASON: Record<string, string> = {
  budget:
    'a budget node needs a session-scoped verdict, which the pipeline dependency cannot carry yet; the gate already refuses a hard window',
  score: 'a score node needs a scoring function this version does not supply',
  judge: 'a judge node needs a model call this version does not supply',
  prepare: 'a prepare node needs a hook this version does not supply',
}

/** The reason a node cannot run here, or undefined when it can. */
export function unboundReason(node: PipelineNodeSpec): string | undefined {
  return UNBOUND_REASON[node.type]
}
