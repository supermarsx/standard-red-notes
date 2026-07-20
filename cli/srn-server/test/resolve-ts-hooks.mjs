// Module-resolution hook: map a relative `./x.js` specifier to the `./x.ts`
// source next to it.
//
// src/ uses NodeNext ESM specifiers (`./cli.js`) because that is what `tsc`
// emits into dist/. Node's built-in type stripping does NOT rewrite `.js` to
// `.ts`, so without this hook `src/index.ts` cannot be loaded from source at
// all and the entry point is untestable — which is exactly why it sat at 0%.
//
// This is test-only: nothing in src/ or dist/ knows about it. Compiled output
// and the esbuild bundle keep resolving `./cli.js` the normal way.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
    const asTs = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(fileURLToPath(asTs))) {
      return nextResolve(asTs.href, context)
    }
  }
  return nextResolve(specifier, context)
}
