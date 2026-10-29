import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  dependencies?: Record<string, string>
  dsh?: { bundle?: { patch?: string } }
}

describe('bundle manifest', () => {
  test('points at a patch file that ships with the package', () => {
    const patch = pkg.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(existsSync(join(root, String(patch).slice(2)))).toBe(true)
  })

  test('inserts the plugin row enabled, because an empty adapter list is already idle', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^- insert:/m)
    expect(patch).toContain(`name: ${pkg.name}`)
    expect(patch).toMatch(/adapters: \[\]/)
    expect(patch).not.toMatch(/disabled:/)
  })

  test('ships no secret value', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toMatch(/secret:\s*\S+/)
  })
})

describe('runtime dependencies', () => {
  const config = readFileSync(join(root, 'rolldown.config.ts'), 'utf8')

  test('the tool helper is installed, because the bundle imports it at runtime', () => {
    expect(pkg.dependencies?.['@deepseek-ai/dsh-tools']).toBeDefined()
  })

  test('the tool helper stays external, or the harness would be copied into the bundle', () => {
    expect(config).toContain(`'@deepseek-ai/dsh-tools'`)
  })

  test('the schema library is installed for the same reason', () => {
    expect(pkg.dependencies?.['@deepseek-ai/schemastery']).toBeDefined()
  })
})
