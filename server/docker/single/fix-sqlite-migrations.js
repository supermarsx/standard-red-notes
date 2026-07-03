#!/usr/bin/env node
/*
 * Standard Red Notes — sqlite migration compatibility shim (single-container / LXC).
 *
 * The server's TypeORM migrations were authored MySQL-first: several of the
 * *sqlite* migrations use DOUBLE-QUOTED SQL string literals (e.g.
 *   INSERT INTO `roles` (...) VALUES ("e738...", "TRANSITION_USER", 1)
 * ). MySQL (ANSI_QUOTES off) treats "..." as a string, so these run fine there.
 * The fork's better-sqlite3 (12.x) ships SQLite with DQS OFF, which correctly
 * treats "..." as an IDENTIFIER — so those migrations fail on first boot with
 *   SqliteError: no such column: "e738..." - should this be a string literal in single-quotes?
 *
 * This shim rewrites those double-quoted SQL string literals to single-quoted in
 * the COMPILED (dist) sqlite migration files, at deploy time. It:
 *   - touches ONLY dist/migrations/sqlite/*.js (which run ONLY under the sqlite
 *     home-server path — the multi-container MySQL stack never executes them);
 *   - does NOT modify any repo/source file;
 *   - is idempotent (already single-quoted migrations are left untouched);
 *   - will become a harmless no-op once the migrations are fixed upstream.
 *
 * Usage: node fix-sqlite-migrations.js <packages-dir>
 *   e.g. node fix-sqlite-migrations.js /opt/server/packages
 */
'use strict'
const fs = require('fs')
const path = require('path')

const base = process.argv[2]
if (!base) {
  console.error('usage: fix-sqlite-migrations.js <packages-dir>')
  process.exit(2)
}

const DQ = String.fromCharCode(34) // "
const SQ = String.fromCharCode(39) // '
const BS = String.fromCharCode(92) // backslash

// Decode a JS single-quoted string body to its actual runtime value (resolves
// \<newline> line-continuations, \', \\, \n, \t, \r, ...).
function jsUnescape(s) {
  let out = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch !== BS) { out += ch; continue }
    const n = s[i + 1]
    i++
    if (n === '\n') { continue }
    if (n === '\r') { if (s[i + 1] === '\n') i++; continue }
    if (n === 'n') { out += '\n'; continue }
    if (n === 't') { out += '\t'; continue }
    if (n === 'r') { out += '\r'; continue }
    out += n
  }
  return out
}

// Match .query('...') where the single-quoted arg may span lines via \-escapes.
const re = new RegExp('\\.query\\(' + SQ + '((?:[^' + SQ + '\\\\]|\\\\[\\s\\S])*)' + SQ + '\\)', 'g')

let scanned = 0
let patched = 0
let dirs = []
try {
  dirs = fs.readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(base, d.name, 'dist', 'migrations', 'sqlite'))
} catch (e) {
  console.error('fix-sqlite-migrations: cannot read ' + base + ': ' + e.message)
  process.exit(1)
}

for (const dir of dirs) {
  let files = []
  try { files = fs.readdirSync(dir) } catch (e) { continue }
  for (const f of files) {
    if (!f.endsWith('.js')) continue
    const p = path.join(dir, f)
    const c = fs.readFileSync(p, 'utf8')
    scanned++
    const nc = c.replace(re, (m, body) => {
      const sql = jsUnescape(body)
      if (sql.indexOf(DQ) === -1) return m
      const fixed = sql.split(DQ).join(SQ)
      return '.query(' + JSON.stringify(fixed) + ')'
    })
    if (nc !== c) { fs.writeFileSync(p, nc); patched++ }
  }
}
console.log('[fix-sqlite-migrations] scanned ' + scanned + ' sqlite migration file(s), patched ' + patched)
