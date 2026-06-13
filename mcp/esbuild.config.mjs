import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

// Alias the bare `libsodium-wrappers` (what sncrypto-web's published bundle
// imports) to our SUMO live-binding shim so argon2 (crypto_pwhash) is present
// and the post-`ready` members resolve correctly through the bundler.
const sumoShim = fileURLToPath(new URL('./src/libsodium-sumo-shim.mjs', import.meta.url))

// @standardnotes/sncrypto-web's published bundle imports argon2 (crypto_pwhash)
// from the STANDARD `libsodium-wrappers`, which doesn't include it — it relies
// on the consuming bundler aliasing it to the `-sumo` build (the web app does
// this via webpack). Replicate that alias here so argon2 works headless.
//
// snjs/sncrypto reference browser globals (`self`, `window`) at module load,
// so we inject them via a banner that runs before the bundle evaluates.

const entry = process.argv[2] ?? 'src/index.ts'
const outfile = process.argv[3] ?? 'dist/index.cjs'

await build({
  entryPoints: [entry],
  outfile,
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
