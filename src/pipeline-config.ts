import type { NodeType, SkipTarget } from './pipeline.js'
import { DEFAULT_MAX_TURN_MS, NODE_TYPES, SKIP_TARGETS } from './pipeline.js'

export interface PipelineNodeSpec {
  id: string
  type: NodeType
  restrictSkip?: readonly SkipTarget[]
  mayRestrict?: boolean
  /** The share of the quota a budget node allows before it restricts, from 0 to 1. */
  softLimit?: number
}

export interface PipelineSettings {
  maxTurnMs: number
  judgeTimeoutMs: number
}

export const DEFAULT_PIPELINE: PipelineSettings = { maxTurnMs: DEFAULT_MAX_TURN_MS, judgeTimeoutMs: 8_000 }

export interface CheckReport {
  fatal: string[]
  warnings: string[]
}


/** Load time checks: illegal declarations refuse to load, odd orders only warn. */
export function checkPipeline(nodes: readonly PipelineNodeSpec[]): CheckReport {
  const fatal: string[] = []
  const warnings: string[] = []
  const index = (type: NodeType) => nodes.findIndex((node) => node.type === type)

  for (const node of nodes) {
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) {
      fatal.push(`node "${node.id}": unknown type "${node.type}"`)
      continue
    }
    if (node.restrictSkip) {
      for (const target of node.restrictSkip) {
        if (!(SKIP_TARGETS as readonly string[]).includes(target)) {
          fatal.push(`node "${node.id}": illegal skip value "${target}"`)
        }
      }
      if (node.type !== 'budget') fatal.push(`node "${node.id}": only a budget node may declare restrict`)
    }
    if (node.softLimit !== undefined) {
      fatal.push(
        `node "${node.id}": softLimit is not supported in this version: a soft limit is computed but nothing acts on it yet`,
      )
    }
    if (node.mayRestrict && node.type !== 'budget') {
      fatal.push(`node "${node.id}": only a budget node may return restrict`)
    }
  }

  const budget = index('budget')
  if (budget >= 0) {
    const judge = index('judge')
    if (judge >= 0 && judge < budget) warnings.push('judge runs before budget')
    const allow = index('allow')
    if (allow >= 0 && allow < budget) warnings.push('allow runs before budget')
  }
  const deny = index('deny')
  const allow = index('allow')
  if (nodes.length > 0 && allow < 0) {
    warnings.push('no "allow" node: every message is denied while this pipeline is attached')
  }
  if (deny >= 0 && allow >= 0 && allow < deny) warnings.push('allow runs before deny')

  const score = index('score')
  const judge = index('judge')
  if (score >= 0 && judge >= 0 && judge < score) warnings.push('judge runs before score')

  nodes.forEach((node, position) => {
    if (node.type !== 'prepare') return
    const later = nodes.slice(position + 1)
    if (later.some((item) => item.type === 'allow' || item.type === 'judge')) {
      warnings.push('prepare does not run after every allow and judge')
    }
  })

  for (let i = 1; i < nodes.length; i += 1) {
    if (nodes[i]!.type === nodes[i - 1]!.type) warnings.push(`consecutive nodes of type "${nodes[i]!.type}"`)
  }

  return { fatal, warnings }
}
