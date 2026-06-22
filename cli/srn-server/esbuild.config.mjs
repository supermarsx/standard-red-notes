import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// srn-server has zero runtime dependencies (Node built-ins only), so this bundle
// step is purely about producing a single, self-contained CJS entry that
// @yao-pkg/pkg can wrap into a native executable without tracing a node_modules
// tree. Output mirrors srn-client's `dist/index.cjs` so the packaging step is
// symmetric across both tools.
await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
})
