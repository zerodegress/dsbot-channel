import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import entry from '../src/index.js'
import { registryPlugin } from '../src/registry-plugin.js'
import { SKILL_DESCRIPTION, SKILL_NAME, skillPath } from '../src/skill-asset.js'

interface Registered {
  name: string
  description: string
  content: string
}

async function mount(options: { skill?: boolean; withSkills?: boolean } = {}): Promise<{ registered: Registered[]; ctx: Context }> {
  const registered: Registered[] = []
  const ctx = new Context()
  await ctx.plugin({
    name: 'probe-services',
    apply(scope: Context) {
      scope.provide('credentials')
      scope.set('credentials', { resolve: () => Promise.resolve(undefined) })
      scope.provide('sessionController')
      scope.set('sessionController', { create: () => Promise.resolve({ sessionId: 's' }), prompt: () => Promise.resolve({ accepted: true }) })
      if (options.withSkills !== false) {
        scope.provide('skills')
        scope.set('skills', {
          register: (skill: Registered) => {
            registered.push(skill)
            return () => undefined
          },
        })
      }
    },
  })
  await ctx.plugin(registryPlugin)
  await ctx.plugin(entry, {
    ...(options.skill === undefined ? {} : { skill: options.skill }),
    adapters: [],
  })
  return { registered, ctx }
}

describe('the skill a profile carries', () => {
  test('is registered under a kebab-case name with the packaged body', async () => {
    const { registered } = await mount()
    expect(registered).toHaveLength(1)
    expect(registered[0]!.name).toBe(SKILL_NAME)
    expect(SKILL_NAME).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    expect(registered[0]!.description).toBe(SKILL_DESCRIPTION)
    expect(registered[0]!.description).toContain('dsbot-channel')
    expect(registered[0]!.content).toBe(readFileSync(skillPath(), 'utf8'))
    expect(registered[0]!.content.startsWith('# dsbot-channel configuration')).toBe(true)
    expect(registered[0]!.content).toContain('## Judge provider')
  })

  test('is not registered when the profile turns it off', async () => {
    const { registered } = await mount({ skill: false })
    expect(registered).toHaveLength(0)
  })

  test('mounts without a skills service', async () => {
    const { registered } = await mount({ withSkills: false })
    expect(registered).toHaveLength(0)
  })
})
