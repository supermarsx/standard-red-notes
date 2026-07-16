// Standard Red Notes: bundle the in-container admin CLI ("srn-admin",
// bin/srn_admin.ts) into a single CJS file so it can be wrapped into a
// standalone native executable by @yao-pkg/pkg.
//
// Mirrors ../home-server/esbuild.config.mjs: we bundle the already-tsc-built
// entry (dist/bin/srn_admin.js) — NOT the .ts — because the CLI relies on the
// auth package's TypeScript experimental decorators + emitDecoratorMetadata
// (inversify DI); tsc has already applied those, so esbuild only has to flatten
// the require graph.
//
// The server workspace uses Yarn PnP, so esbuild needs the PnP resolver plugin
// to find @standardnotes/* workspaces and the zipped dependencies.
//
// Native / non-bundleable modules are marked external, identically to
// home-server (whose bundle already includes this same auth dependency graph,
// so the exclusion set is proven): the CLI targets MySQL deployments (mysql2 is
// pure JS); the SQLite driver (better-sqlite3, a native addon) is excluded —
// TypeORM only require()s it when DB_TYPE=sqlite, so a MySQL deployment never
// loads it. OCR (tesseract.js, WASM) and the optional native CBOR accelerator
// likewise fall back / are unused on this path.
//
// Unlike home-server there is NO migrations merge / SRN_MIGRATIONS_DIR banner:
// srn-admin runs the container in the lean 'cli' mode which never runs
// migrations; it targets an already-migrated database.
import { build } from 'esbuild'
import { pnpPlugin } from '@yarnpkg/esbuild-plugin-pnp'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, 'dist/bin/srn_admin.js')
const outfile = path.join(here, 'dist/bundle/srn-admin.cjs')

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  plugins: [pnpPlugin()],
  external: [
    // Native SQLite driver — excluded (MySQL-mode); TypeORM lazy-loads it only
    // when DB_TYPE=sqlite.
    'better-sqlite3',
    // OCR engine ships WASM + worker assets, not bundleable.
    'tesseract.js',
    // Optional native CBOR accelerator; cbor-x falls back to a pure-JS encoder.
    'cbor-extract',
    // Other DB drivers TypeORM may probe but we don't use.
    'pg',
    'pg-native',
    'sqlite3',
    'oracledb',
    'mssql',
    'mongodb',
    'redis',
    'sql.js',
  ],
})

process.stdout.write('Bundled srn-admin CLI into dist/bundle/srn-admin.cjs\n')
