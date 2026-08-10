import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
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
import {
  buildApplicationUserRepairSql,
  buildBackupDrillEnvironment,
  buildRootUserRepairSql,
  atomicallyRestoreEnvironment,
  CORE_RECOVERY_SERVICES,
  databaseCredentialPairAuthenticates,
  defaultRecoveryDirectory,
  fingerprint as credentialFingerprint,
  parseArgs as parseCredentialRecoveryArgs,
  parseChecksumSidecar,
  parseEnvSource,
  parseSha256Output,
  pathsOverlap,
  protectCurrentEnvironment,
  recoveryFailureRequiresFailClosed,
  selectSetupEnvironmentBackupNames,
  validatePreviousEnvironmentValues,
  sqlIdentifier as recoverySqlIdentifier,
  sqlString as recoverySqlString,
} from './reconcile-database-credentials.mjs'

test('database recovery requires explicit execution while backup location can default safely', () => {
  assert.deepEqual(parseCredentialRecoveryArgs([]), {
    backupDir: null,
    composeFile: null,
    envFile: null,
    execute: false,
    help: false,
    previousEnvFile: null,
    projectName: null,
    rotateDatabaseCredentials: false,
  })
  assert.deepEqual(parseCredentialRecoveryArgs(['--execute', '--backup-dir', '.']), {
    backupDir: resolve('.'),
    composeFile: null,
    envFile: null,
    execute: true,
    help: false,
    previousEnvFile: null,
    projectName: null,
    rotateDatabaseCredentials: false,
  })
  const scoped = parseCredentialRecoveryArgs([
    '--execute',
    '--backup-dir',
    '.',
    '--compose-file',
    'compose.yml',
    '--env-file',
    'test.env',
    '--previous-env-file',
    'previous.env',
    '--rotate-database-credentials',
    '--project-name',
    'srn-recovery-test',
  ])
  assert.equal(scoped.composeFile, resolve('compose.yml'))
  assert.equal(scoped.envFile, resolve('test.env'))
  assert.equal(scoped.previousEnvFile, resolve('previous.env'))
  assert.equal(scoped.projectName, 'srn-recovery-test')
  assert.equal(scoped.rotateDatabaseCredentials, true)
  assert.throws(() => parseCredentialRecoveryArgs(['--backup-dir', '--execute']), /requires an existing directory/)
  assert.throws(() => parseCredentialRecoveryArgs(['--force']), /Unknown argument/)
  assert.throws(() => parseCredentialRecoveryArgs(['--project-name', 'NOT SAFE']), /lowercase Compose project name/)
})

test('database recovery selects only bounded setup-generated backups newest first', () => {
  const candidates = [
    '.env.bak.20260809120000',
    '.env.bak.20260810120000',
    '.env.bak.latest',
    '.env.bak.20260810120000.extra',
    'other.env.bak.20260811120000',
  ]
  assert.deepEqual(selectSetupEnvironmentBackupNames(candidates, '.env', 2), [
    '.env.bak.20260810120000',
    '.env.bak.20260809120000',
  ])
})

test('database recovery requires root and application evidence and can fall back to an older candidate', () => {
  assert.equal(databaseCredentialPairAuthenticates({ applicationAuthenticated: false, rootAuthenticated: true }), false)
  assert.equal(
    databaseCredentialPairAuthenticates({ applicationAuthenticated: false, rootAuthenticated: false }),
    false,
  )
  const newestFirst = [
    { applicationAuthenticated: false, name: 'newest', rootAuthenticated: true },
    { applicationAuthenticated: true, name: 'older', rootAuthenticated: true },
  ]
  assert.equal(newestFirst.find(databaseCredentialPairAuthenticates)?.name, 'older')
})

test('automatic full rollback accepts an independently valid prior database identity', () => {
  const candidate = {
    MYSQL_DATABASE: 'prior_database',
    MYSQL_PASSWORD: 'prior-app-password',
    MYSQL_ROOT_PASSWORD: 'prior-root-password',
    MYSQL_USER: 'prior_user',
  }
  assert.equal(
    validatePreviousEnvironmentValues(
      candidate,
      { database: 'broken_new_database', rootPassword: 'new-root-password', user: 'broken_new_user' },
      { requireDifferentRoot: false, requireMatchingIdentity: false },
    ),
    candidate,
  )
  assert.throws(
    () =>
      validatePreviousEnvironmentValues(candidate, {
        database: 'broken_new_database',
        rootPassword: 'new-root-password',
        user: 'broken_new_user',
      }),
    /different database identity/,
  )
})

test('database recovery chooses durable OS state paths and restores the intended core stack', () => {
  assert.equal(
    defaultRecoveryDirectory({ LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local' }, 'win32'),
    'C:\\Users\\operator\\AppData\\Local\\StandardRedNotes\\recovery',
  )
  assert.equal(
    defaultRecoveryDirectory({ HOME: '/home/operator' }, 'linux'),
    '/home/operator/.local/state/standard-red-notes/recovery',
  )
  assert.equal(
    defaultRecoveryDirectory({ HOME: '/Users/operator' }, 'darwin'),
    '/Users/operator/Library/Application Support/StandardRedNotes/recovery',
  )
  assert.deepEqual(CORE_RECOVERY_SERVICES, ['db', 'server', 'app'])
})

test('database recovery preserves the rotated environment before atomic full rollback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'srn-environment-rollback-'))
  const activeEnvironment = join(directory, '.env')
  const previousEnvironment = join(directory, '.env.bak.20260810120000')
  try {
    writeFileSync(activeEnvironment, 'MYSQL_PASSWORD=rotated\nAUTH_JWT_SECRET=rotated\n')
    writeFileSync(previousEnvironment, 'MYSQL_PASSWORD=previous\nAUTH_JWT_SECRET=previous\n')
    const protectedCopy = protectCurrentEnvironment(activeEnvironment, directory, '20260810T120000Z')
    assert.equal(readFileSync(protectedCopy.backupPath, 'utf8'), readFileSync(activeEnvironment, 'utf8'))
    assert.match(readFileSync(protectedCopy.checksumPath, 'utf8'), new RegExp(`^${protectedCopy.digest}  `))

    atomicallyRestoreEnvironment(previousEnvironment, activeEnvironment, '20260810T120000Z')
    assert.equal(readFileSync(activeEnvironment, 'utf8'), readFileSync(previousEnvironment, 'utf8'))
    assert.equal(readFileSync(protectedCopy.backupPath, 'utf8'), 'MYSQL_PASSWORD=rotated\nAUTH_JWT_SECRET=rotated\n')
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
})

test('database recovery fails closed after runtime topology recreation even without SQL or env mutation', () => {
  assert.equal(
    recoveryFailureRequiresFailClosed({
      configurationMutationStarted: false,
      sqlMutationStarted: false,
      topologyMutationStarted: true,
    }),
    true,
  )
  assert.equal(
    recoveryFailureRequiresFailClosed({
      configurationMutationStarted: false,
      sqlMutationStarted: false,
      topologyMutationStarted: false,
    }),
    false,
  )
})

test('database credential recovery parses env values without evaluating them', () => {
  assert.deepEqual(parseEnvSource("# comment\nMYSQL_USER=std_notes_user\nMYSQL_PASSWORD='literal $VALUE'\nEMPTY=\n"), {
    MYSQL_USER: 'std_notes_user',
    MYSQL_PASSWORD: 'literal $VALUE',
    EMPTY: '',
  })
})

test('database credential recovery reports only deterministic SHA-256 fingerprints', () => {
  assert.equal(
    credentialFingerprint('secret-value'),
    'sha256:31160254d1297393d2ad00e1c01851aec834361e02c524b89fe06aff2879ce6a',
  )
  assert.equal(credentialFingerprint(''), 'missing')
})

test('database credential recovery validates independent SHA-256 output', () => {
  const digest = 'a'.repeat(64)
  assert.equal(parseSha256Output(`${digest}  /backup/archive.tar.gz\n`), digest)
  assert.throws(() => parseSha256Output('not-a-checksum'), /checksum is invalid/)
  assert.equal(parseChecksumSidecar(`${digest}  archive.tar.gz\n`, 'archive.tar.gz'), digest)
  assert.throws(
    () => parseChecksumSidecar(`${digest}  .archive.tar.gz.partial\n`, 'archive.tar.gz'),
    /does not reference the final archive/,
  )
})

test('database credential recovery rejects overlapping backup and database volume paths', () => {
  assert.equal(
    pathsOverlap('/var/lib/docker/volumes/db/_data', '/var/lib/docker/volumes/db/_data/backups', 'linux'),
    true,
  )
  assert.equal(pathsOverlap('/var/lib/docker/volumes', '/var/lib/docker/volumes/db/_data', 'linux'), true)
  assert.equal(pathsOverlap('/srv/backups', '/var/lib/docker/volumes/db/_data', 'linux'), false)
  assert.equal(pathsOverlap('C:\\backups', '/var/lib/docker/volumes/db/_data', 'win32'), false)
})

test('database credential recovery isolates the backup drill environment', () => {
  const environment = buildBackupDrillEnvironment({
    baseEnvironment: {
      NODE_OPTIONS: '--require malicious.js',
      PATH: 'trusted-execution-path',
      RANDOM_OVERRIDE: 'blocked',
    },
    composeFile: resolve('compose.yml'),
    envFile: {
      MYSQL_DATABASE: 'standard_notes_db',
      MYSQL_PASSWORD: 'application-secret',
      MYSQL_ROOT_PASSWORD: 'root-secret',
      MYSQL_USER: 'std_notes_user',
      NODE_OPTIONS: '--require env-malicious.js',
      PATH: 'untrusted-env-path',
    },
    envFilePath: resolve('test.env'),
    projectName: 'srn-recovery-test',
  })
  assert.deepEqual(environment, {
    PATH: 'trusted-execution-path',
    MYSQL_PASSWORD: 'application-secret',
    MYSQL_ROOT_PASSWORD: 'root-secret',
    MYSQL_DATABASE: 'standard_notes_db',
    MYSQL_USER: 'std_notes_user',
    COMPOSE_PROJECT_NAME: 'srn-recovery-test',
    COMPOSE_FILE: resolve('compose.yml'),
    COMPOSE_ENV_FILES: resolve('test.env'),
  })
  assert.equal(environment.NODE_OPTIONS, undefined)
  assert.equal(environment.RANDOM_OVERRIDE, undefined)
})

test('database credential recovery safely quotes the bounded SQL contract', () => {
  assert.equal(recoverySqlIdentifier('standard_notes_db'), '`standard_notes_db`')
  assert.equal(recoverySqlString("slash\\quote'"), "'slash\\\\quote'''")
  assert.throws(() => recoverySqlIdentifier('notes`; DROP DATABASE notes'), /ASCII letters/)
  assert.throws(() => recoverySqlString('line\nbreak'), /single-line/)

  const sql = buildApplicationUserRepairSql({
    database: 'standard_notes_db',
    hosts: ['127.0.0.1', 'localhost'],
    password: "new\\password'",
    user: 'std_notes_user',
  })
  assert.match(sql, /^CREATE USER IF NOT EXISTS 'std_notes_user'@'%' IDENTIFIED BY /)
  assert.match(sql, /ALTER USER 'std_notes_user'@'%'/)
  assert.match(sql, /GRANT ALL PRIVILEGES ON `standard_notes_db`\.\*/)
  assert.match(sql, /'std_notes_user'@'127\.0\.0\.1'/)
  assert.match(sql, /'std_notes_user'@'localhost'/)
  assert.doesNotMatch(sql, /DROP|FLUSH|mysql\./i)
  assert.throws(
    () =>
      buildApplicationUserRepairSql({
        database: 'standard_notes_db',
        hosts: ['unexpected-host'],
        password: 'new-password',
        user: 'std_notes_user',
      }),
    /unexpected database account host/,
  )

  const rootSql = buildRootUserRepairSql({ hosts: ['localhost', '127.0.0.1'], password: "new\\password'" })
  assert.match(rootSql, /^ALTER USER 'root'@'localhost' IDENTIFIED BY /)
  assert.match(rootSql, /ALTER USER 'root'@'127\.0\.0\.1'/)
  assert.doesNotMatch(rootSql, /CREATE|GRANT|FLUSH/i)
  assert.throws(
    () => buildRootUserRepairSql({ hosts: ['unexpected-host'], password: 'new-password' }),
    /unexpected MariaDB root account host/,
  )
})

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
