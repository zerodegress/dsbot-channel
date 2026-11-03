import { ConfigError } from './config.js'
import type { AuthorKind } from './event-types.js'

/** Bounds that keep a profile from growing an identity graph without limit. */
export const IDENTITY_ID_MAX = 64
export const IDENTITY_KIND_MAX = 64
export const IDENTITY_INSTANCE_MAX = 128
export const IDENTITY_ACCOUNT_MAX = 256
export const IDENTITY_NODES_MAX = 512
export const IDENTITY_ACCOUNTS_PER_NODE_MAX = 64
export const IDENTITY_ACCOUNTS_TOTAL_MAX = 4096

/** One platform account, named the way its transport already names it. */
export interface AccountKey {
  kind: string
  instance: string
  accountId: string
}

/** One graph node: a person, or a bot when it is declared under `bots`. */
export interface IdentityNode {
  id: string
  kind: AuthorKind
  accounts: readonly AccountKey[]
}

/** What one mounted adapter tells the graph about the accounts it can carry. */
export interface MountedAccountSpace {
  kind: string
  instance: string
  /** Peer instances configured on this adapter, when it has any. */
  peers: readonly string[]
}

/** The resolved graph: immutable after the profile is read. */
export class IdentityGraph {
  readonly #byAccount: ReadonlyMap<string, string>
  readonly nodes: readonly IdentityNode[]

  constructor(nodes: readonly IdentityNode[]) {
    this.nodes = nodes
    const map = new Map<string, string>()
    for (const node of nodes) for (const account of node.accounts) map.set(keyOf(account), node.id)
    this.#byAccount = map
  }

  /** The node an account belongs to, or null when no binding names it. */
  resolve(account: AccountKey): string | null {
    return this.#byAccount.get(keyOf(account)) ?? null
  }
}

export const EMPTY_IDENTITY = new IdentityGraph([])

function keyOf(account: AccountKey): string {
  return JSON.stringify([account.kind, account.instance, account.accountId])
}

function fail(message: string, path: readonly (string | number)[]): never {
  throw new ConfigError(message, [...path])
}

function record(value: unknown, path: readonly (string | number)[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`identity.${path.join('.')} must be an object`, path)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, path: readonly (string | number)[], max: number): string {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`identity.${path.join('.')} must be a non-empty string`, path)
  }
  if (value.length > max) {
    fail(`identity.${path.join('.')} is longer than ${max} characters`, path)
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code <= 0x1f || code === 0x7f) {
      fail(`identity.${path.join('.')} must be printable characters`, path)
    }
  }
  return value
}

function readNode(raw: unknown, path: readonly (string | number)[], kind: AuthorKind): IdentityNode {
  const node = record(raw, path)
  const unknown = Object.keys(node).filter((key) => key !== 'id' && key !== 'accounts')
  if (unknown.length > 0) fail(`identity.${path.join('.')} names a field it does not read: ${unknown.join(', ')}`, path)
  const id = text(node.id, [...path, 'id'], IDENTITY_ID_MAX)
  if (!Array.isArray(node.accounts) || node.accounts.length === 0) {
    fail(`identity.${path.join('.')}.accounts must be a non-empty list`, [...path, 'accounts'])
  }
  if (node.accounts.length > IDENTITY_ACCOUNTS_PER_NODE_MAX) {
    fail(
      `identity.${path.join('.')}.accounts carries at most ${IDENTITY_ACCOUNTS_PER_NODE_MAX} accounts`,
      [...path, 'accounts'],
    )
  }
  const seen = new Set<string>()
  const accounts = node.accounts.map((entry, index) => {
    const account = readAccount(entry, [...path, 'accounts', index])
    const key = keyOf(account)
    if (seen.has(key)) {
      fail(
        `identity.${path.join('.')} lists the account ${describe(account)} twice`,
        [...path, 'accounts', index],
      )
    }
    seen.add(key)
    return account
  })
  return { id, kind, accounts }
}

function readAccount(raw: unknown, path: readonly (string | number)[]): AccountKey {
  const account = record(raw, path)
  const unknown = Object.keys(account).filter((key) => key !== 'kind' && key !== 'instance' && key !== 'accountId')
  if (unknown.length > 0) fail(`identity.${path.join('.')} names a field it does not read: ${unknown.join(', ')}`, path)
  return {
    kind: text(account.kind, [...path, 'kind'], IDENTITY_KIND_MAX),
    instance: text(account.instance, [...path, 'instance'], IDENTITY_INSTANCE_MAX),
    accountId: text(account.accountId, [...path, 'accountId'], IDENTITY_ACCOUNT_MAX),
  }
}

function describe(account: AccountKey): string {
  return `(${account.kind}, ${account.instance}, ${account.accountId})`
}

/** Every mounted space a built-in kind may name, keyed the way bindings spell it. */
function knownInstances(mounted: readonly MountedAccountSpace[], kind: string): string[] {
  const names = new Set<string>()
  for (const space of mounted) {
    if (space.kind !== kind) continue
    names.add(space.instance)
    if (kind === 'p2p') for (const peer of space.peers) names.add(peer)
  }
  return [...names]
}

function checkCrossReference(
  account: AccountKey,
  path: readonly (string | number)[],
  mounted: readonly MountedAccountSpace[],
  warn: (message: string) => void,
): void {
  if (account.kind !== 'p2p' && account.kind !== 'onebot') {
    // A third-party kind names its instances however it likes; we cannot check that namespace.
    if (!mounted.some((space) => space.kind === account.kind && space.instance === account.instance)) {
      warn(
        `dsbot-channel: identity account ${describe(account)} names an instance of kind "${account.kind}" ` +
          `that is not mounted here; the binding is kept because this build cannot check that namespace`,
      )
    }
    return
  }
  const known = knownInstances(mounted, account.kind)
  if (known.includes(account.instance)) return
  const where = account.kind === 'p2p' ? 'instances and configured peers' : 'instances'
  const listed = known.length === 0 ? 'none' : known.join(', ')
  fail(
    `identity account ${describe(account)} names an instance of kind "${account.kind}" that is mounted nowhere; ` +
      `known ${where}: ${listed}`,
    path,
  )
}

/** Reads the global `identity` block, refusing anything a later reader would have to guess at. */
export function buildIdentity(
  raw: unknown,
  mounted: readonly MountedAccountSpace[] = [],
  warn: (message: string) => void = () => undefined,
): IdentityGraph {
  if (raw === undefined) return EMPTY_IDENTITY
  const root = record(raw, [])
  const unknown = Object.keys(root).filter((key) => key !== 'people' && key !== 'bots')
  if (unknown.length > 0) fail(`identity names a field it does not read: ${unknown.join(', ')}`, [])

  const nodes: IdentityNode[] = []
  for (const [field, kind] of [
    ['people', 'person'],
    ['bots', 'bot'],
  ] as const) {
    const list = root[field]
    if (list === undefined) continue
    if (!Array.isArray(list)) fail(`identity.${field} must be a list`, [field])
    list.forEach((entry, index) => {
      nodes.push(readNode(entry, [field, index], kind))
    })
  }
  if (nodes.length > IDENTITY_NODES_MAX) {
    fail(`identity declares at most ${IDENTITY_NODES_MAX} nodes`, [])
  }
  const totalAccounts = nodes.reduce((sum, node) => sum + node.accounts.length, 0)
  if (totalAccounts > IDENTITY_ACCOUNTS_TOTAL_MAX) {
    fail(`identity declares at most ${IDENTITY_ACCOUNTS_TOTAL_MAX} accounts`, [])
  }

  const byId = new Map<string, IdentityNode>()
  for (const node of nodes) {
    const existing = byId.get(node.id)
    if (existing !== undefined) {
      fail(`identity declares the node id "${node.id}" twice`, [])
    }
    byId.set(node.id, node)
  }

  const owner = new Map<string, string>()
  for (const [nodeIndex, node] of nodes.entries()) {
    const field = node.kind === 'bot' ? 'bots' : 'people'
    node.accounts.forEach((account, accountIndex) => {
      checkCrossReference(account, [field, nodeIndex, 'accounts', accountIndex], mounted, warn)
      const key = keyOf(account)
      const claimed = owner.get(key)
      if (claimed !== undefined) {
        fail(
          `identity account ${describe(account)} belongs to both "${claimed}" and "${node.id}"`,
          [],
        )
      }
      owner.set(key, node.id)
    })
  }

  return new IdentityGraph(nodes.map((node) => Object.freeze({ ...node, accounts: Object.freeze([...node.accounts]) })))
}
