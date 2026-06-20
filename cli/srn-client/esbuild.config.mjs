import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Mirror the proven MCP-bridge build: bundle snjs + sncrypto-web for Node and
// alias the bare `libsodium-wrappers` import (what sncrypto-web's published
// bundle uses) to a SUMO live-binding shim so argon2 (crypto_pwhash) is present.
// snjs/sncrypto reference browser globals (`self`, `window`) at module load, so
// a banner injects them before the bundle evaluates.
const sumoShim = fileURLToPath(new URL('./src/libsodium-sumo-shim.mjs', import.meta.url))

await build({
  entryPoints: [fileURLToPath(new URL('./src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('./dist/index.cjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  alias: {
    'libsodium-wrappers': sumoShim,
  },
  banner: {
    js: [
      'globalThis.self = globalThis.self || globalThis;',
      'globalThis.window = globalThis.window || globalThis;',
      'globalThis.document = globalThis.document || {};',
      "globalThis.navigator = globalThis.navigator || { userAgent: 'node' };",
    ].join(' '),
  },
  logLevel: 'info',
})
