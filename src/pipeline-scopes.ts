import type { CheckReport, PipelineNodeSpec } from './pipeline-config.js'
import { checkPipeline } from './pipeline-config.js'

export const SCOPE_LEVELS = ['global', 'bot', 'session'] as const
export type ScopeLevel = (typeof SCOPE_LEVELS)[number]

export interface InsertSpec {
  id: string
  type: string
  after?: string
  before?: string
}

/** What a bot or a session adds to the layer above it: a difference, never a whole pipeline. */
export interface PipelineLayer {
  inherit?: ScopeLevel
  remove?: readonly string[]
  insert?: readonly InsertSpec[]
  override?: Readonly<Record<string, Partial<PipelineNodeSpec>>>
}

export interface PipelineScopes {
  global: readonly PipelineNodeSpec[]
  bot?: PipelineLayer
  session?: PipelineLayer
}

export interface ScopeMerge {
  nodes: PipelineNodeSpec[]
  fatal: string[]
}

export interface ScopeCheck extends ScopeMerge, CheckReport {}

function applyLayer(
  base: readonly PipelineNodeSpec[],
  layer: PipelineLayer,
  level: ScopeLevel,
): ScopeMerge {
  const fatal: string[] = []
  const nodes = base.map((node) => ({ ...node }))
  const ids = new Set(nodes.map((node) => node.id))

  for (const id of layer.remove ?? []) {
    if (!ids.has(id)) {
      fatal.push(`${level}: remove names a node that does not exist: "${id}"`)
      continue
    }
    const at = nodes.findIndex((node) => node.id === id)
    nodes.splice(at, 1)
    ids.delete(id)
  }

  for (const spec of layer.insert ?? []) {
    const anchor = spec.after ?? spec.before
    if (anchor === undefined || (spec.after !== undefined && spec.before !== undefined)) {
      fatal.push(`${level}: insert "${spec.id}" must name exactly one of after or before`)
      continue
    }
    if (ids.has(spec.id)) {
      fatal.push(`${level}: insert reuses the node id "${spec.id}"`)
      continue
    }
    const at = nodes.findIndex((node) => node.id === anchor)
    if (at < 0) {
      fatal.push(`${level}: insert "${spec.id}" names an anchor that does not exist: "${anchor}"`)
      continue
    }
    const position = spec.after === undefined ? at : at + 1
    nodes.splice(position, 0, { id: spec.id, type: spec.type as PipelineNodeSpec['type'] })
    ids.add(spec.id)
  }

  for (const [id, patch] of Object.entries(layer.override ?? {})) {
    const node = nodes.find((candidate) => candidate.id === id)
    if (node === undefined) {
      fatal.push(`${level}: override names a node that does not exist: "${id}"`)
      continue
    }
    Object.assign(node, patch, { id })
  }

  return { nodes, fatal }
}

function checkInherit(layer: PipelineLayer, level: ScopeLevel, allowed: readonly ScopeLevel[]): string[] {
  if (layer.inherit === undefined) return []
  if (allowed.includes(layer.inherit)) return []
  return [`${level}: inherit must be one of ${allowed.join(', ')}, not "${layer.inherit}"`]
}

/** Resolves the layers and runs the pipeline checks on what came out, so a merged node is checked too. */
export function resolveAndCheck(scopes: PipelineScopes): ScopeCheck {
  const merged = resolvePipeline(scopes)
  const checked = checkPipeline(merged.nodes)
  return { nodes: merged.nodes, fatal: [...merged.fatal, ...checked.fatal], warnings: checked.warnings }
}

/** Resolves the three layers into the pipeline a session actually runs. */
export function resolvePipeline(scopes: PipelineScopes): ScopeMerge {
  let nodes = scopes.global.map((node) => ({ ...node }))
  const fatal: string[] = []

  if (scopes.bot !== undefined) {
    fatal.push(...checkInherit(scopes.bot, 'bot', ['global']))
    const merged = applyLayer(nodes, scopes.bot, 'bot')
    nodes = merged.nodes
    fatal.push(...merged.fatal)
  }

  if (scopes.session !== undefined) {
    fatal.push(...checkInherit(scopes.session, 'session', ['bot', 'global']))
    const base = scopes.session.inherit === 'global' ? scopes.global.map((node) => ({ ...node })) : nodes
    const merged = applyLayer(base, scopes.session, 'session')
    nodes = merged.nodes
    fatal.push(...merged.fatal)
  }

  return { nodes, fatal }
}
