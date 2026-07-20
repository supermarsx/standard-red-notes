#!/usr/bin/env node
import { createReadStream, createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..')
const DATABASE_READY_TIMEOUT_MS = 120_000
const DATABASE_READY_RETRY_MS = 1_000

export async function runBackupRestoreDrill(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)

  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'srn-backup-restore-'))
  const backupFile = args.output ? path.resolve(args.output) : path.join(tempDir, 'backup.sql')
  const restoreDb = args.restoreDb ?? `srn_restore_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  let createdRestoreDb = false

  validateRestoreDatabaseName(restoreDb)

  try {
    console.log('Standard Red Notes backup/restore drill')
    console.log(`Repository: ${REPO_ROOT}`)

    const { authenticatedUser, database: sourceDb } = await waitForDatabaseReady()
    await mysqlServer('SELECT 1;')

    console.log(`Authenticated database readiness passed as ${authenticatedUser}.`)
    console.log(`Source database: ${sourceDb}`)
    console.log(`Backup file: ${backupFile}`)
    console.log(`Temporary restore database: ${restoreDb}`)

    await dockerToFile(
      [
        'compose',
        'exec',
        '-T',
        'db',
        'sh',
        '-c',
        'exec mariadb-dump -uroot -p"$MYSQL_ROOT_PASSWORD" --single-transaction --routines --events "$MYSQL_DATABASE"',
      ],
      backupFile,
    )

    const backupSize = statSync(backupFile).size
    if (backupSize <= 0) {
      throw new Error('Backup file is empty')
    }
    console.log(`Dumped ${formatBytes(backupSize)}.`)

    await mysqlServer(`CREATE DATABASE ${quoteIdentifier(restoreDb)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)
    createdRestoreDb = true

    await dockerFromFile(
      [
        'compose',
        'exec',
        '-T',
        'db',
        'sh',
        '-c',
        `exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" ${shellSingleQuote(restoreDb)}`,
      ],
      backupFile,
    )

    const sourceTables = await tableNames(sourceDb)
    const restoredTables = await tableNames(restoreDb)
    compareLists(sourceTables, restoredTables, 'table list')
    if (sourceTables.length === 0) {
      throw new Error('No tables found in the source database; refusing to call this a valid restore')
    }

    const sourceCounts = await tableCounts(sourceDb, sourceTables)
    const restoredCounts = await tableCounts(restoreDb, restoredTables)
    compareMaps(sourceCounts, restoredCounts, 'table row counts')

    const sourceChecksums = await tableChecksums(sourceDb, sourceTables)
    const restoredChecksums = await tableChecksums(restoreDb, restoredTables)
    compareChecksums(sourceChecksums, restoredChecksums)

    const totalRows = [...sourceCounts.values()].reduce((sum, value) => sum + value, 0)
    const checksummed = [...sourceChecksums.values()].filter((value) => value !== null).length
    console.log(`Verified ${sourceTables.length} tables, ${totalRows} rows, ${checksummed} table checksums.`)
    console.log('Backup/restore drill passed.')
  } finally {
    if (createdRestoreDb && !args.keepRestoreDatabase) {
      await mysqlServer(`DROP DATABASE IF EXISTS ${quoteIdentifier(restoreDb)};`).catch((error) => {
        console.error(`Warning: failed to drop temporary database ${restoreDb}: ${error.message}`)
      })
    }
    if (!args.output && !args.keepBackup) {
      rmSync(tempDir, { recursive: true, force: true })
    } else if (!args.output) {
      console.log(`Kept backup at ${backupFile}`)
    }
  }
}

export function parseArgs(argv) {
  const parsed = {
    help: false,
    keepBackup: false,
    keepRestoreDatabase: false,
    output: null,
    restoreDb: null,
  }

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      parsed.help = true
    } else if (arg === '--keep-backup') {
      parsed.keepBackup = true
    } else if (arg === '--keep-restore-db') {
      parsed.keepRestoreDatabase = true
    } else if (arg === '--output') {
      parsed.output = requireValue(argv, ++i, '--output')
    } else if (arg === '--restore-db') {
      parsed.restoreDb = requireValue(argv, ++i, '--restore-db')
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }

  return parsed
}

export function requireValue(argv, index, flag) {
  const value = argv[index]
  if (!value || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`)
  }
  return value
}

function printHelp() {
  console.log(`Usage: node scripts/verify-backup-restore.mjs [options]

Creates a logical MariaDB backup from the running docker-compose stack, restores
it into a temporary database, compares tables/counts/checksums, then drops only
the temporary database.

Options:
  --output <path>        Keep the generated SQL dump at this path.
  --keep-backup         Keep the temporary SQL dump instead of deleting it.
  --restore-db <name>   Use a specific temporary database name.
  --keep-restore-db     Keep the temporary restore database for inspection.
  -h, --help            Show this help.
`)
}

async function mysqlServer(sql) {
  return dockerText(
    [
      'compose',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" --batch --raw --skip-column-names',
    ],
    { input: sql },
  )
}

async function mysqlApplication(sql) {
  return dockerText(
    [
      'compose',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      'exec mariadb -h 127.0.0.1 -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" --batch --raw --skip-column-names',
    ],
    { input: sql },
  )
}

async function waitForDatabaseReady() {
  const deadline = Date.now() + DATABASE_READY_TIMEOUT_MS
  let lastError = new Error('database readiness was not attempted')

  console.log('Waiting for authenticated SQL and database grants...')
  while (Date.now() < deadline) {
    try {
      const output = (await mysqlApplication('SELECT CURRENT_USER(), DATABASE();')).trim()
      const [authenticatedUser, database] = output.split('\t')
      if (!authenticatedUser || !database) {
        throw new Error(`unexpected readiness response: ${JSON.stringify(output)}`)
      }
      return { authenticatedUser, database }
    } catch (error) {
      lastError = error
      await delay(DATABASE_READY_RETRY_MS)
    }
  }

  throw new Error(
    `MariaDB did not accept authenticated SQL against MYSQL_DATABASE within ${DATABASE_READY_TIMEOUT_MS / 1_000}s\n${lastError.message}`,
  )
}

async function mysqlDatabase(database, sql) {
  return dockerText(
    [
      'compose',
      'exec',
      '-T',
      'db',
      'sh',
      '-c',
      `exec mariadb -uroot -p"$MYSQL_ROOT_PASSWORD" ${shellSingleQuote(database)} --batch --raw --skip-column-names`,
    ],
    { input: sql },
  )
}

async function tableNames(database) {
  const output = await mysqlDatabase(
    database,
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME;",
  )
  return output
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

async function tableCounts(database, tables) {
  const sql = tables.map((table) => `SELECT ${sqlString(table)}, COUNT(*) FROM ${quoteIdentifier(table)};`).join('\n')
  return parseTwoColumnMap(await mysqlDatabase(database, sql), Number)
}

async function tableChecksums(database, tables) {
  const sql = tables.map((table) => `CHECKSUM TABLE ${quoteIdentifier(table)};`).join('\n')
  return parseTwoColumnMap(
    await mysqlDatabase(database, sql),
    (value) => (value === 'NULL' ? null : value),
    (key) => key.replace(/^[^.]+\./, ''),
  )
}

export function parseTwoColumnMap(output, valueParser, keyParser = (key) => key) {
  const rows = new Map()
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [key, value] = line.split('\t')
    rows.set(keyParser(key), valueParser(value))
  }
  return rows
}

export function compareLists(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) {
    throw new Error(`${label} mismatch\nsource=${a}\nrestore=${b}`)
  }
}

export function compareMaps(source, restored, label) {
  const mismatches = []
  for (const [key, value] of source) {
    if (restored.get(key) !== value) {
      mismatches.push(`${key}: source=${value} restore=${restored.get(key)}`)
    }
  }
  if (mismatches.length) {
    throw new Error(`${label} mismatch:\n${mismatches.slice(0, 20).join('\n')}`)
  }
}

export function compareChecksums(source, restored) {
  const mismatches = []
  for (const [key, value] of source) {
    const restoredValue = restored.get(key)
    if (value === null && restoredValue === null) {
      continue
    }
    if (restoredValue !== value) {
      mismatches.push(`${key}: source=${value} restore=${restoredValue}`)
    }
  }
  if (mismatches.length) {
    throw new Error(`table checksum mismatch:\n${mismatches.slice(0, 20).join('\n')}`)
  }
}

export function validateRestoreDatabaseName(name) {
  if (!/^srn_restore_[A-Za-z0-9_]{1,48}$/.test(name)) {
    throw new Error('Restore database name must match srn_restore_[A-Za-z0-9_]{1,48}')
  }
}

export function quoteIdentifier(identifier) {
  return `\`${identifier.replace(/`/g, '``')}\``
}

export function sqlString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

export function shellSingleQuote(value) {
  return `'${value.replace(/'/g, "'\"'\"'")}'`
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function dockerText(args, options = {}) {
  const result = await run('docker', args, options)
  return result.stdout
}

async function dockerToFile(args, outputFile) {
  await run('docker', args, { outputFile })
}

async function dockerFromFile(args, inputFile) {
  await run('docker', args, { inputFile })
}

function run(command, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd: REPO_ROOT,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    const append = (target, chunk) => {
      const next = target + chunk.toString()
      return next.length > 1024 * 1024 ? next.slice(next.length - 1024 * 1024) : next
    }

    let outputDone = Promise.resolve()
    if (options.outputFile) {
      const output = createWriteStream(options.outputFile)
      child.stdout.pipe(output)
      outputDone = new Promise((done, fail) => {
        output.on('finish', done)
        output.on('error', fail)
      })
    } else {
      child.stdout.on('data', (chunk) => {
        stdout = append(stdout, chunk)
      })
    }

    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk)
    })

    if (options.inputFile) {
      createReadStream(options.inputFile).pipe(child.stdin)
    } else {
      child.stdin.end(options.input ?? '')
    }

    child.on('error', reject)
    child.on('close', async (code) => {
      try {
        await outputDone
        if (code !== 0) {
          reject(new Error(`${command} ${argv.join(' ')} failed with exit code ${code}\n${stderr}`))
          return
        }
        resolve({ stdout, stderr })
      } catch (error) {
        reject(error)
      }
    })
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  await runBackupRestoreDrill()
}
