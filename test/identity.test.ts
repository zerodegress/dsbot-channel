import { describe, expect, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  IDENTITY_ACCOUNTS_PER_NODE_MAX,
  IDENTITY_ACCOUNTS_TOTAL_MAX,
  IDENTITY_NODES_MAX,
  buildIdentity,
} from '../src/identity.js'
import type { MountedAccountSpace } from '../src/identity.js'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { staticCredentials } from '../src/adapters/p2p/p2p-secrets.js'

const REF = 'p2p-secret-identity'
const credentials = staticCredentials({ [REF]: 'shared-value' })

const mounted: MountedAccountSpace[] = [
  { kind: 'p2p', instance: 'inst-a', peers: ['peer-a'] },
  { kind: 'onebot', instance: 'qq-main', peers: [] },
]

const account = (kind: string, instance: string, accountId: string) => ({ kind, instance, accountId })

function person(id: string, accounts: { kind: string; instance: string; accountId: string }[]) {
  return { id, accounts }
}

describe('the identity graph a profile declares', () => {
  test('is empty when the block is absent', () => {
    const graph = buildIdentity(undefined, mounted)
    expect(graph.nodes).toEqual([])
    expect(graph.resolve(account('onebot', 'qq-main', '1'))).toBeNull()
  })

  test('resolves a bound account and leaves an unbound one alone', () => {
    const graph = buildIdentity(
      { people: [person('alice', [account('onebot', 'qq-main', '10001')])] },
      mounted,
    )
    expect(graph.resolve(account('onebot', 'qq-main', '10001'))).toBe('alice')
    expect(graph.resolve(account('onebot', 'qq-main', '20002'))).toBeNull()
  })

  test('keeps one node over many accounts, and one account under one node', () => {
    const graph = buildIdentity(
      {
        people: [
          person('alice', [account('onebot', 'qq-main', '10001'), account('p2p', 'peer-a', 'bot-a')]),
          person('bob', [account('onebot', 'qq-main', '20002')]),
        ],
      },
      mounted,
    )
    expect(graph.resolve(account('onebot', 'qq-main', '10001'))).toBe('alice')
    expect(graph.resolve(account('p2p', 'peer-a', 'bot-a'))).toBe('alice')
    expect(graph.resolve(account('onebot', 'qq-main', '20002'))).toBe('bob')
  })

  test('refuses the same account twice inside one node', () => {
    expect(() =>
      buildIdentity(
        { people: [person('alice', [account('onebot', 'qq-main', '1'), account('onebot', 'qq-main', '1')])] },
        mounted,
      ),
    ).toThrow(/lists the account .* twice/)
  })

  test('refuses one account under two nodes, naming both', () => {
    expect(() =>
      buildIdentity(
        {
          people: [
            person('alice', [account('onebot', 'qq-main', '1')]),
            person('bob', [account('onebot', 'qq-main', '1')]),
          ],
        },
        mounted,
      ),
    ).toThrow(/belongs to both "alice" and "bob"/)
  })

  test('refuses a node id used twice', () => {
    expect(() =>
      buildIdentity(
        {
          people: [person('alice', [account('onebot', 'qq-main', '1')])],
          bots: [{ id: 'alice', accounts: [account('p2p', 'peer-a', 'b')] }],
        },
        mounted,
      ),
    ).toThrow(/node id "alice" twice/)
  })

  test('refuses a field it does not read', () => {
    expect(() => buildIdentity({ people: [], friends: [] }, mounted)).toThrow(/identity names a field it does not read: friends/)
    expect(() =>
      buildIdentity({ people: [{ id: 'a', accounts: [], extra: 1 }] }, mounted),
    ).toThrow(/names a field it does not read: extra/)
    expect(() =>
      buildIdentity({ people: [{ id: 'a', accounts: [{ kind: 'onebot', instance: 'qq-main', accountId: '1', x: 1 }] }] }, mounted),
    ).toThrow(/names a field it does not read: x/)
  })

  test('refuses an empty, over-long or unprintable field', () => {
    expect(() => buildIdentity({ people: [{ id: '', accounts: [account('onebot', 'qq-main', '1')] }] }, mounted)).toThrow(
      /must be a non-empty string/,
    )
    expect(() =>
      buildIdentity({ people: [person('x'.repeat(65), [account('onebot', 'qq-main', '1')])] }, mounted),
    ).toThrow(/longer than 64 characters/)
    expect(() =>
      buildIdentity({ people: [person('a\u0001', [account('onebot', 'qq-main', '1')])] }, mounted),
    ).toThrow(/printable characters/)
  })

  test('holds the declared bounds', () => {
    const many = Array.from({ length: IDENTITY_NODES_MAX + 1 }, (_unused, index) =>
      person(`p${index}`, [account('onebot', 'qq-main', `${index}`)]),
    )
    expect(() => buildIdentity({ people: many }, mounted)).toThrow(new RegExp(`at most ${IDENTITY_NODES_MAX} nodes`))

    const crowded = person(
      'alice',
      Array.from({ length: IDENTITY_ACCOUNTS_PER_NODE_MAX + 1 }, (_unused, index) =>
        account('onebot', 'qq-main', `${index}`),
      ),
    )
    expect(() => buildIdentity({ people: [crowded] }, mounted)).toThrow(
      new RegExp(`at most ${IDENTITY_ACCOUNTS_PER_NODE_MAX} accounts`),
    )

    const total = Array.from({ length: IDENTITY_ACCOUNTS_TOTAL_MAX / IDENTITY_ACCOUNTS_PER_NODE_MAX + 1 }, (_unused, node) =>
      person(
        `p${node}`,
        Array.from({ length: IDENTITY_ACCOUNTS_PER_NODE_MAX }, (_ignored, index) =>
          account('onebot', 'qq-main', `${node}-${index}`),
        ),
      ),
    )
    expect(() => buildIdentity({ people: total }, mounted)).toThrow(
      new RegExp(`at most ${IDENTITY_ACCOUNTS_TOTAL_MAX} accounts`),
    )
  })

  test('checks a p2p account against mounted instances and configured peers', () => {
    expect(() =>
      buildIdentity({ people: [person('alice', [account('p2p', 'peer-a', 'bot-a')])] }, mounted),
    ).not.toThrow()
    expect(() =>
      buildIdentity({ people: [person('alice', [account('p2p', 'inst-a', 'bot-a')])] }, mounted),
    ).not.toThrow()
    expect(() =>
      buildIdentity({ people: [person('alice', [account('p2p', 'peer-z', 'bot-a')])] }, mounted),
    ).toThrow(/mounted nowhere; known instances and configured peers: inst-a, peer-a/)
  })

  test('checks an onebot account against the mounted onebot instances', () => {
    expect(() =>
      buildIdentity({ people: [person('alice', [account('onebot', 'qq-main', '1')])] }, mounted),
    ).not.toThrow()
    expect(() =>
      buildIdentity({ people: [person('alice', [account('onebot', 'qq-other', '1')])] }, mounted),
    ).toThrow(/mounted nowhere; known instances: qq-main/)
  })

  test('keeps a third-party binding but says so once', () => {
    const warnings: string[] = []
    const graph = buildIdentity(
      { people: [person('alice', [account('x-thing', 'somewhere', '1')])] },
      mounted,
      (message) => warnings.push(message),
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('x-thing')
    expect(graph.resolve(account('x-thing', 'somewhere', '1'))).toBe('alice')
  })
})

describe('the identity block at mount', () => {
  async function mount(identity: unknown): Promise<Context> {
    const ctx = new Context()
    await ctx.plugin({
      name: 'probe-services',
      apply(scope: Context) {
        scope.provide('credentials')
        scope.set('credentials', credentials)
        scope.provide('sessionController')
        scope.set('sessionController', {
          create: () => Promise.resolve({ sessionId: 'session-1' }),
          prompt: () => Promise.resolve({ accepted: true }),
        })
      },
    })
    await ctx.plugin(registryPlugin)
    await ctx.plugin(entry, {
      identity,
      adapters: [
        {
          channel: 'inst-a',
          botName: 'bot-a',
          transport: { peers: [{ instance: 'peer-a', secret: REF }], listen: { host: '127.0.0.1', port: 0 } },
        },
      ],
    })
    return ctx
  }

  test('refuses a broken graph while the profile loads', async () => {
    await expect(
      mount({ people: [person('alice', [account('p2p', 'nobody', 'bot')])] }),
    ).rejects.toThrow(/mounted nowhere/)
    await expect(
      mount({
        people: [
          person('alice', [account('p2p', 'peer-a', 'bot')]),
          person('bob', [account('p2p', 'peer-a', 'bot')]),
        ],
      }),
    ).rejects.toThrow(/belongs to both/)
  })
})
