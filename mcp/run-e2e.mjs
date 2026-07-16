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

// Opt-in override: by default the e2e bundle resolves the published
// @standardnotes/snjs pinned in package.json (what the MCP ships against). Set
// SNJS_DIST=<abs path to a snjs.js webpack bundle> to instead bundle a specific
// build — e.g. the workspace app/packages/snjs/dist after `yarn workspace
// @standardnotes/snjs build`, which is the ONLY build carrying unreleased fixes
// like the local-only persistence fix (commit 55785604). Leaves default runs
// untouched for anyone not setting the var.
const snjsDistOverride = process.env.SNJS_DIST ? path.resolve(process.env.SNJS_DIST).replace(/\\/g, '/') : undefined
const snjsOverridePlugin = snjsDistOverride
  ? [
      {
        name: 'snjs-dist-override',
        setup(b) {
          b.onResolve({ filter: /^@standardnotes\/snjs$/ }, () => ({ path: snjsDistOverride }))
        },
      },
    ]
  : []
if (snjsDistOverride) {
  console.log(`[run-e2e] SNJS_DIST override active -> @standardnotes/snjs resolves to ${snjsDistOverride}`)
}

const commonBuild = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  legalComments: 'none',
  plugins: snjsOverridePlugin,
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
}

// The MCP-protocol e2e spawns the real server (dist/index.cjs), so build it first.
await build({
  ...commonBuild,
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.cjs', import.meta.url)),
})

const e2eDir = fileURLToPath(new URL('./src/e2e', import.meta.url))
const tests = readdirSync(e2eDir).filter((f) => f.endsWith('.e2e.ts')).sort()

let failed = 0
for (const test of tests) {
  const name = test.replace('.e2e.ts', '')
  const outfile = fileURLToPath(new URL(`./dist/e2e/${name}.cjs`, import.meta.url))
  await build({ ...commonBuild, entryPoints: [path.join(e2eDir, test)], outfile })
  console.log(`\n=== e2e: ${name} ===`)
  const res = spawnSync('node', [outfile], { stdio: 'inherit' })
  if (res.status !== 0) failed++
}

console.log(failed === 0 ? '\nALL E2E SUITES PASSED' : `\n${failed} E2E SUITE(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
