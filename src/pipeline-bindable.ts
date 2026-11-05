import type { PipelineNodeSpec } from './pipeline-config.js'

/** The rules a bot can match, folded over every adapter that answers for it. */
export interface RuleBindings {
  deny: boolean
  allow: boolean
}

/** The reason a rule node matches nothing, or undefined when the bot has a rule for it. */
export function unboundRuleReason(node: PipelineNodeSpec, rules: RuleBindings): string | undefined {
  if (node.type === 'deny' && !rules.deny) {
    return 'a deny node has no rule to match: add policy.deny words or regexes'
  }
  if (node.type === 'allow' && !rules.allow) return 'an allow node has no rule to match: add policy.allow peers'
  return undefined
}
