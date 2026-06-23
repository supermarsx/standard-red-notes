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
import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const entry = path.join(here, 'dist/bin/server.js')
const outfile = path.join(here, 'dist/bundle/home-server.cjs')

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
  // Standalone binary: when running under @yao-pkg/pkg, point the services'
  // TypeORM migration loaders (SRN_MIGRATIONS_DIR) at a real `migrations/`
  // folder shipped next to the executable, since pkg's read-only snapshot fs
  // doesn't reliably glob bundled assets. No-op for a normal `node` run.
  banner: {
    js: "if (process.pkg && !process.env.SRN_MIGRATIONS_DIR) { process.env.SRN_MIGRATIONS_DIR = require('path').join(require('path').dirname(process.execPath), 'migrations') }",
  },
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

// Merge every bundled service's compiled migrations into one folder that ships
// next to the binary. In the home-server deployment all services share ONE
// database (and one `migrations` table) and there are no migration-name
// collisions across them, so a single merged set is correct. The DataSource
// SRN_MIGRATIONS_DIR overrides + the banner above point the loaders here.
const MIGRATION_SERVICES = ['auth', 'syncing-server', 'revisions', 'websockets']
const migrationsOut = path.join(here, 'dist/bundle/migrations')
let copied = 0
for (const dbType of ['mysql', 'sqlite']) {
  mkdirSync(path.join(migrationsOut, dbType), { recursive: true })
  for (const svc of MIGRATION_SERVICES) {
    const src = path.join(here, '..', svc, 'dist/migrations', dbType)
    let files
    try {
      files = readdirSync(src)
    } catch {
      continue
    }
    for (const file of files) {
      if (file.endsWith('.js')) {
        cpSync(path.join(src, file), path.join(migrationsOut, dbType, file))
        copied++
      }
    }
  }
}
console.log(`Merged ${copied} migration files into dist/bundle/migrations`)
