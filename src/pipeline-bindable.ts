import type { PipelineNodeSpec } from './pipeline-config.js'

/** Nodes whose work this version does not supply, so declaring one would run nothing. */
export const UNBOUND_REASON: Record<string, string> = {
  budget:
    'a budget node needs a session-scoped verdict, which the pipeline dependency cannot carry yet; the gate already refuses a hard window',
  score: 'a score node needs a scoring function this version does not supply',
}

/** The rules a bot can match, folded over every adapter that answers for it. */
export interface RuleBindings {
  deny: boolean
  allow: boolean
}

/** The reason a node cannot run here, or undefined when it can. */
export function unboundReason(node: PipelineNodeSpec): string | undefined {
  return UNBOUND_REASON[node.type]
}

/** The reason a rule node matches nothing, or undefined when the bot has a rule for it. */
export function unboundRuleReason(node: PipelineNodeSpec, rules: RuleBindings): string | undefined {
  if (node.type === 'deny' && !rules.deny) {
    return 'a deny node has no rule to match: add policy.deny words or regexes'
  }
  if (node.type === 'allow' && !rules.allow) return 'an allow node has no rule to match: add policy.allow peers'
  return undefined
}
