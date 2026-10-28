import type { MatchRule, PipelineDeps } from './build-pipeline.js'
import { ConfigError } from './config.js'
import type { PipelineNodeSpec } from './pipeline-config.js'
import type { PipelineEvent } from './pipeline.js'

export interface PolicyConfig {
  deny?: { words?: readonly string[] | undefined; regexes?: readonly string[] | undefined } | undefined
  allow?: { peers?: readonly string[] | undefined } | undefined
}

export interface CompiledPolicy {
  specs: PipelineNodeSpec[]
  deps: PipelineDeps
}

function textOf(event: PipelineEvent): string {
  return event.text.toLowerCase()
}

function wordsConfigError(index: number): ConfigError {
  return new ConfigError('a deny word cannot be empty', ['deny', 'words', index], ['deny'])
}

/** Turns operator configuration into the rules a pipeline node needs. */
export function compilePolicy(policy: PolicyConfig): CompiledPolicy {
  const wordRules: MatchRule[] = (policy.deny?.words ?? []).map((word, index) => {
    const needle = word.trim().toLowerCase()
    if (needle === '') throw wordsConfigError(index)
    return {
      id: `word:${needle}`,
      reason: `denied: word "${needle}" present`,
      matches: (event) => textOf(event).includes(needle),
    }
  })

  const regexRules: MatchRule[] = (policy.deny?.regexes ?? []).map((source, index) => {
    let pattern: RegExp
    try {
      pattern = new RegExp(source, 'i')
    } catch {
      throw new ConfigError(
        `a deny pattern is not a valid regular expression: ${source}`,
        ['deny', 'regexes', index],
        ['deny'],
      )
    }
    return {
      id: `regex:${source}`,
      reason: `denied: pattern "${source}" matched`,
      matches: (event) => pattern.test(event.text),
    }
  })

  const peerRules: MatchRule[] = (policy.allow?.peers ?? []).map((peer, index) => {
    const name = peer.trim()
    if (name === '') throw new ConfigError('an allowed peer cannot be empty', ['allow', 'peers', index], ['allow'])
    return {
      id: `peer:${name}`,
      reason: `allowed: peer "${name}"`,
      matches: (event) => event.peer === name,
    }
  })

  const denyRules = [...wordRules, ...regexRules]
  const specs: PipelineNodeSpec[] = []
  if (denyRules.length > 0) specs.push({ id: 'deny', type: 'deny' })
  if (peerRules.length > 0) specs.push({ id: 'allow', type: 'allow' })

  return {
    specs,
    deps: {
      ...(denyRules.length > 0 ? { denyRules } : {}),
      ...(peerRules.length > 0 ? { allowRules: peerRules } : {}),
    },
  }
}
