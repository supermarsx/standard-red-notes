// Module-resolution hook that lets `src/**.ts` be loaded directly by Node.
//
// Two gaps have to be bridged, and neither affects shipped code — the published
// artifact is a single esbuild CJS bundle, and esbuild already resolves both
// cases. This hook only exists so the tests can run the REAL sources and get
// coverage attributed to src/*.ts instead of to a bundle.
//
//  1. `./x.js` -> `./x.ts`. src/ uses NodeNext ESM specifiers because that is
//     what tsc/esbuild consume; Node's type stripping does not rewrite them, so
//     without this src/index.ts cannot be loaded from source at all — which is
//     exactly why the entry point sat at 0% coverage.
//
//  2. Extensionless relative specifiers inside dependencies.
//     @standardnotes/sncrypto-web ships a CommonJS-shaped `dist/index.js` with
//     `import ... from './crypto'`, but declares no "type", so Node's module
//     syntax detection loads it as ESM — where an extensionless specifier is
//     invalid. Resolve it the way a bundler/CommonJS would: try `.js`, then
//     `/index.js`.
//
//  3. The `libsodium-wrappers` -> SUMO-shim alias. esbuild.config.mjs aliases it
//     so argon2 (crypto_pwhash) exists and the members are live bindings; the
//     unaliased package cannot even be imported as ESM (its named re-exports are
//     not statically analysable). Applying the SAME alias here keeps the tested
//     module graph identical to the shipped bundle's.
//
// Installed with module.register() — see register-ts-resolver.mjs for why
// registerHooks() cannot be used here.
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SUMO_SHIM = pathToFileURL(fileURLToPath(new URL('../src/libsodium-sumo-shim.mjs', import.meta.url))).href

function exists(url) {
  try {
    return existsSync(fileURLToPath(url))
  } catch {
    return false
  }
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'libsodium-wrappers') {
    return nextResolve(SUMO_SHIM, context)
  }
  if (specifier.startsWith('.') && context.parentURL) {
    if (specifier.endsWith('.js')) {
      const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (exists(asTs)) {
        return nextResolve(asTs.href, context)
      }
    } else if (!/\.[cm]?[jt]sx?$/.test(specifier)) {
      for (const candidate of [specifier + '.js', specifier + '/index.js']) {
        const url = new URL(candidate, context.parentURL)
        if (exists(url)) {
          return nextResolve(url.href, context)
        }
      }
    }
  }
  return nextResolve(specifier, context)
}
