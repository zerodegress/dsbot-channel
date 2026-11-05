import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/** The kebab-case name a host addresses this skill by. */
export const SKILL_NAME = 'dsbot-channel-config'

/** What the skill is for, in one routing line. */
export const SKILL_DESCRIPTION = 'Configures dsbot-channel adapters: channels, peers, delivery, pipeline and judge providers.'

/** Where the body lives beside the built entry, and beside the source in a checkout. */
export function skillPath(): string {
  return fileURLToPath(new URL('../assets/skill.md', import.meta.url))
}

export interface SkillRegistryLike {
  register: (skill: { name: string; description: string; content: string }) => () => void
}

/**
 * Registers the packaged skill with the host, when the host has a skills
 * service and the profile did not turn it off. A host without one mounts as
 * usual: the skill is a convenience, not a dependency.
 */
export function registerSkill(ctx: Context, enabled: boolean, warn: (message: string) => void): void {
  if (!enabled) return
  const skills = ctx.get('skills') as SkillRegistryLike | undefined
  if (skills === undefined || typeof skills.register !== 'function') return
  let content: string
  try {
    content = readFileSync(skillPath(), 'utf8')
  } catch {
    warn('dsbot-channel: the packaged skill was not read from assets/skill.md; the plugin mounts without it')
    return
  }
  ctx.effect(() => skills.register({ name: SKILL_NAME, description: SKILL_DESCRIPTION, content }), 'dsbot-channel: skill')
}
