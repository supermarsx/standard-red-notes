import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareChecksums,
  compareLists,
  compareMaps,
  formatBytes,
  parseArgs,
  parseTwoColumnMap,
  quoteIdentifier,
  shellSingleQuote,
  sqlString,
  validateRestoreDatabaseName,
} from './verify-backup-restore.mjs'

test('parseArgs defaults to a non-destructive, self-cleaning drill', () => {
  assert.deepEqual(parseArgs([]), {
    help: false,
    keepBackup: false,
    keepRestoreDatabase: false,
    output: null,
    restoreDb: null,
  })
})

test('parseArgs recognises both help spellings', () => {
  assert.equal(parseArgs(['--help']).help, true)
  assert.equal(parseArgs(['-h']).help, true)
})

test('parseArgs sets the retention flags independently', () => {
  const parsed = parseArgs(['--keep-backup'])
  assert.equal(parsed.keepBackup, true)
  assert.equal(parsed.keepRestoreDatabase, false)

  const other = parseArgs(['--keep-restore-db'])
  assert.equal(other.keepRestoreDatabase, true)
  assert.equal(other.keepBackup, false)
})

test('parseArgs reads values for --output and --restore-db', () => {
  const parsed = parseArgs(['--output', 'dump.sql', '--restore-db', 'srn_restore_manual'])
  assert.equal(parsed.output, 'dump.sql')
  assert.equal(parsed.restoreDb, 'srn_restore_manual')
})

test('parseArgs does not consume the next flag as a value', () => {
  assert.throws(() => parseArgs(['--output', '--keep-backup']), /--output requires a value/)
  assert.throws(() => parseArgs(['--restore-db']), /--restore-db requires a value/)
})

test('parseArgs rejects unknown arguments instead of ignoring them', () => {
  assert.throws(() => parseArgs(['--drop-everything']), /Unknown argument: --drop-everything/)
  assert.throws(() => parseArgs(['stray']), /Unknown argument: stray/)
})

test('validateRestoreDatabaseName accepts only the srn_restore_ namespace', () => {
  assert.doesNotThrow(() => validateRestoreDatabaseName('srn_restore_a'))
  assert.doesNotThrow(() => validateRestoreDatabaseName('srn_restore_1753000000_ab12cd'))
})

test('validateRestoreDatabaseName refuses names that could target a real database', () => {
  const rejected = [
    'production',
    'srn_restor_x',
    'SRN_RESTORE_x',
    'srn_restore_',
    'srn_restore_x; DROP DATABASE prod',
    'srn_restore_x`',
    'srn_restore_with-hyphen',
    'srn_restore_ x',
    `srn_restore_${'a'.repeat(49)}`,
  ]
  for (const name of rejected) {
    assert.throws(
      () => validateRestoreDatabaseName(name),
      /Restore database name must match srn_restore_/,
      `${JSON.stringify(name)} should have been rejected`,
    )
  }
  // 48 suffix characters is the documented upper bound and must still pass.
  assert.doesNotThrow(() => validateRestoreDatabaseName(`srn_restore_${'a'.repeat(48)}`))
})

test('quoteIdentifier wraps in backticks and doubles embedded backticks', () => {
  assert.equal(quoteIdentifier('notes'), '`notes`')
  assert.equal(quoteIdentifier('we`ird'), '`we``ird`')
  assert.equal(quoteIdentifier('a`;DROP'), '`a``;DROP`')
})

test('sqlString escapes backslashes and single quotes', () => {
  assert.equal(sqlString('notes'), "'notes'")
  assert.equal(sqlString("O'Brien"), "'O''Brien'")
  assert.equal(sqlString('back\\slash'), "'back\\\\slash'")
  // Backslashes are escaped first so a trailing backslash cannot escape the closing quote.
  assert.equal(sqlString('trail\\'), "'trail\\\\'")
})

test('shellSingleQuote produces a shell-safe single-quoted word', () => {
  assert.equal(shellSingleQuote('srn_restore_1'), "'srn_restore_1'")
  assert.equal(shellSingleQuote("it's"), `'it'"'"'s'`)
  assert.equal(shellSingleQuote("'; rm -rf /"), `''"'"'; rm -rf /'`)
})

test('parseTwoColumnMap parses tab-separated rows with a value parser', () => {
  const map = parseTwoColumnMap('notes\t12\nusers\t3\n', Number)
  assert.deepEqual([...map], [
    ['notes', 12],
    ['users', 3],
  ])
})

test('parseTwoColumnMap tolerates CRLF output and blank lines', () => {
  const map = parseTwoColumnMap('notes\t1\r\n\r\nusers\t2\r\n', Number)
  assert.equal(map.size, 2)
  assert.equal(map.get('notes'), 1)
  assert.equal(map.get('users'), 2)
})

test('parseTwoColumnMap applies the key parser used to strip the database prefix', () => {
  const map = parseTwoColumnMap(
    'srn_restore_1.notes\t123\nsrn_restore_1.users\tNULL\n',
    (value) => (value === 'NULL' ? null : value),
    (key) => key.replace(/^[^.]+\./, ''),
  )
  assert.deepEqual([...map], [
    ['notes', '123'],
    ['users', null],
  ])
})

test('formatBytes switches units at the binary boundaries', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KiB')
  assert.equal(formatBytes(1536), '1.5 KiB')
  assert.equal(formatBytes(1024 * 1024 - 1), '1024.0 KiB')
  assert.equal(formatBytes(1024 * 1024), '1.0 MiB')
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MiB')
})

test('compareLists accepts identical table lists', () => {
  assert.doesNotThrow(() => compareLists(['a', 'b'], ['a', 'b'], 'table list'))
})

test('compareLists rejects a missing or reordered table', () => {
  assert.throws(() => compareLists(['a', 'b'], ['a'], 'table list'), /table list mismatch/)
  assert.throws(() => compareLists(['a', 'b'], ['b', 'a'], 'table list'), /table list mismatch/)
})

test('compareMaps rejects a row count that did not survive the restore', () => {
  const source = new Map([
    ['notes', 10],
    ['users', 2],
  ])
  assert.doesNotThrow(() => compareMaps(source, new Map(source), 'table row counts'))

  assert.throws(
    () =>
      compareMaps(
        source,
        new Map([
          ['notes', 9],
          ['users', 2],
        ]),
        'table row counts',
      ),
    /table row counts mismatch:\nnotes: source=10 restore=9/,
  )
})

test('compareMaps rejects a table missing entirely from the restore', () => {
  assert.throws(
    () => compareMaps(new Map([['notes', 1]]), new Map(), 'table row counts'),
    /notes: source=1 restore=undefined/,
  )
})

test('compareChecksums treats two null checksums as equal', () => {
  const source = new Map([
    ['notes', '123'],
    ['views', null],
  ])
  assert.doesNotThrow(() => compareChecksums(source, new Map(source)))
})

test('compareChecksums rejects a differing or absent checksum', () => {
  assert.throws(
    () => compareChecksums(new Map([['notes', '123']]), new Map([['notes', '456']])),
    /table checksum mismatch:\nnotes: source=123 restore=456/,
  )
  assert.throws(
    () => compareChecksums(new Map([['notes', null]]), new Map([['notes', '456']])),
    /notes: source=null restore=456/,
  )
  assert.throws(
    () => compareChecksums(new Map([['notes', '123']]), new Map()),
    /notes: source=123 restore=undefined/,
  )
})
