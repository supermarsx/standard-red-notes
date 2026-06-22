// Standard Red Notes: bundle the all-in-one home-server (auth + syncing-server
// + files + revisions + api-gateway in one Express process) into a single CJS
// file so it can be wrapped into a standalone native executable by @yao-pkg/pkg.
//
// We bundle the already-tsc-built entry (dist/bin/server.js) — NOT the .ts —
// because the server relies on TypeScript experimental decorators +
// emitDecoratorMetadata (inversify DI); tsc has already applied those, so esbuild
// only has to flatten the require graph.
//
// The server workspace uses Yarn PnP, so esbuild needs the PnP resolver plugin to
// find @standardnotes/* workspaces and the zipped dependencies.
//
// Native / non-bundleable modules are marked external. This binary targets
// MySQL deployments (mysql2 is pure JS); the SQLite driver (better-sqlite3, a
// native addon) is excluded — TypeORM only require()s it when DB_TYPE=sqlite, so
// a MySQL deployment never loads it. OCR (tesseract.js, WASM) and the optional
// native CBOR accelerator likewise fall back / are unused on this path.
import { build } from 'esbuild'
import { pnpPlugin } from '@yarnpkg/esbuild-plugin-pnp'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('./dist/bin/server.js', import.meta.url))
const outfile = fileURLToPath(new URL('./dist/bundle/home-server.cjs', import.meta.url))

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
    // OCR engine ships WASM + worker assets, not bundleable; api-gateway only
    // loads it when server-side OCR is enabled.
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
