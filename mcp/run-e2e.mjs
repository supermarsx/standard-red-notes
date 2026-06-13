// Bundles each src/e2e/*.e2e.ts (so the snjs browser bundle + cookie-jar
// polyfill are applied) and runs them in sequence against the live stack.
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const sumoShim = fileURLToPath(new URL('./src/libsodium-sumo-shim.mjs', import.meta.url))

const e2eDir = fileURLToPath(new URL('./src/e2e', import.meta.url))
const tests = readdirSync(e2eDir).filter((f) => f.endsWith('.e2e.ts')).sort()

let failed = 0
for (const test of tests) {
  const name = test.replace('.e2e.ts', '')
  const outfile = fileURLToPath(new URL(`./dist/e2e/${name}.cjs`, import.meta.url))
  await build({
    entryPoints: [path.join(e2eDir, test)],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'none',
    alias: { 'libsodium-wrappers': sumoShim },
    banner: {
      js: [
        'globalThis.self = globalThis.self || globalThis;',
        'globalThis.window = globalThis.window || globalThis;',
        'globalThis.document = globalThis.document || {};',
        "globalThis.navigator = globalThis.navigator || { userAgent: 'node' };",
      ].join(' '),
    },
    logLevel: 'silent',
  })
  console.log(`\n=== e2e: ${name} ===`)
  const res = spawnSync('node', [outfile], { stdio: 'inherit' })
  if (res.status !== 0) failed++
}

console.log(failed === 0 ? '\nALL E2E SUITES PASSED' : `\n${failed} E2E SUITE(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
