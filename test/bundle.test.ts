import { describe, expect, test } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  name: string
  files: string[]
  dsh?: { bundle?: { patch?: string } }
}

describe('bundle manifest', () => {
  test('points at a patch file that ships with the package', () => {
    const patch = pkg.dsh?.bundle?.patch
    expect(patch).toBe('./cordis.patch.yml')
    expect(pkg.files).toContain('cordis.patch.yml')
    expect(existsSync(join(root, String(patch).slice(2)))).toBe(true)
  })

  test('inserts the plugin row disabled by default', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).toMatch(/^- insert:/m)
    expect(patch).toContain(`name: ${pkg.name}`)
    expect(patch).toMatch(/disabled: true/)
  })

  test('ships no secret value', () => {
    const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
    expect(patch).not.toMatch(/secret:\s*\S+/)
  })
})
