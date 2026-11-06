import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { URL, fileURLToPath, pathToFileURL } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const dist = join(root, 'dist')
const warningBytes = 500 * 1024

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const targets = new Set()
for (const value of Object.values(pkg.exports ?? {})) {
  const target = typeof value === 'string' ? value : value?.default
  if (typeof target === 'string' && target.endsWith('.js')) targets.add(target.replace(/^\.\//, ''))
}
if (typeof pkg.main === 'string') targets.add(pkg.main.replace(/^\.\//, ''))

let names
try {
  names = readdirSync(dist).filter((name) => name.endsWith('.js'))
} catch {
  console.error('verify:dist: dist is missing; run pnpm build:dist first')
  process.exit(1)
}

const bundling = names.filter((name) => readFileSync(join(dist, name), 'utf8').includes('__require'))
if (bundling.length > 0) {
  console.error(`verify:dist: ${bundling.join(', ')} still carry __require; a commonjs dependency or a Node builtin reached the bundle`)
  process.exit(1)
}

if (!names.includes('index.js') || !names.some((name) => name.startsWith('registry-plugin-'))) {
  console.error('verify:dist: expected dist/index.js and dist/registry-plugin-*.js')
  process.exit(1)
}

for (const name of names) {
  const bytes = statSync(join(dist, name)).size
  const kb = (bytes / 1024).toFixed(1)
  if (bytes > warningBytes) console.warn(`verify:dist: ${name} is ${kb} kB; check that no commonjs dependency was bundled`)
  else console.log(`verify:dist: ${name} is ${kb} kB`)
}

if (targets.size === 0) {
  console.error('verify:dist: package.json names no js entry to import')
  process.exit(1)
}

for (const target of targets) {
  let missing = false
  try {
    statSync(join(root, target))
  } catch {
    missing = true
  }
  if (missing) {
    console.error(`verify:dist: ${target} is exported but missing`)
    process.exit(1)
  }
  const url = pathToFileURL(join(root, target)).href
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(url)})`], {
    stdio: 'inherit',
  })
  if (run.status !== 0) {
    console.error(`verify:dist: ${target} does not load in an esm host`)
    process.exit(1)
  }
}

console.log(`verify:dist: ${[...targets].join(', ')} load in an esm host`)
