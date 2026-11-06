import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

const NAMES = [
  'bot-a',
  'bot-b',
  'bot-c',
  'bot-shared',
  'seal',
  'self-bot',
  'session-a',
  'relay',
  'other-bot',
  'other',
  'orca',
  'main',
  'a',
]

const slug = (name: string): string => name.replace(/[^a-z0-9]+/gi, '-')

const home = mkdtempSync(join(tmpdir(), 'dsbot-home-'))
mkdirSync(join(home, 'bot'), { recursive: true })
const bots = Object.fromEntries(
  NAMES.map((name) => [slug(name), { name, id: `session-${slug(name)}` }]),
)
writeFileSync(join(home, 'bot', 'state.json'), JSON.stringify({ bots }), 'utf8')
process.env.DSH_HOME = home

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
})
