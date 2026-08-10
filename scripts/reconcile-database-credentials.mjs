#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..')
const MAX_AUTOMATIC_ENVIRONMENT_BACKUPS = 20
export const CORE_RECOVERY_SERVICES = ['db', 'server', 'app']

export function parseArgs(argv) {
  const result = {
    backupDir: null,
    composeFile: null,
    envFile: null,
    execute: false,
    help: false,
    previousEnvFile: null,
    projectName: null,
    rotateDatabaseCredentials: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--execute') {
      result.execute = true
    } else if (argument === '--rotate-database-credentials') {
      result.rotateDatabaseCredentials = true
    } else if (argument === '--backup-dir') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) {
        throw new Error('--backup-dir requires an existing directory')
      }
      result.backupDir = path.resolve(value)
    } else if (argument === '--compose-file' || argument === '--env-file' || argument === '--previous-env-file') {
      const value = argv[++index]
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a file`)
      result[
        argument === '--compose-file' ? 'composeFile' : argument === '--env-file' ? 'envFile' : 'previousEnvFile'
      ] = path.resolve(value)
    } else if (argument === '--project-name') {
      const value = argv[++index]
      if (!value || !/^[a-z0-9][a-z0-9_-]*$/.test(value)) {
        throw new Error('--project-name requires a lowercase Compose project name')
      }
      result.projectName = value
    } else if (argument === '--help' || argument === '-h') {
      result.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  return result
}

export function parseEnvSource(source) {
  const values = {}
  for (const rawLine of String(source).split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const name = line.slice(0, separator).trim()
    let value = line.slice(separator + 1).trim()
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1)
    }
    values[name] = value
  }
  return values
}

export function fingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) return 'missing'
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

export function parseSha256Output(output) {
  const digest = String(output).trim().split(/\s+/, 1)[0]
  if (!/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error('Cold MariaDB volume backup checksum is invalid')
  }
  return digest
}

export function parseChecksumSidecar(output, expectedFilename) {
  const line = String(output).trim()
  const match = /^([a-f0-9]{64}) [ *](.+)$/.exec(line)
  if (!match || match[2] !== expectedFilename) {
    throw new Error('Cold MariaDB volume backup checksum sidecar does not reference the final archive')
  }
  return match[1]
}

export function pathsOverlap(left, right, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (!pathApi.isAbsolute(left) || !pathApi.isAbsolute(right)) return false
  const normalizedLeft = pathApi.resolve(left)
  const normalizedRight = pathApi.resolve(right)
  const contains = (parent, child) => {
    const relative = pathApi.relative(parent, child)
    return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
  }
  return contains(normalizedLeft, normalizedRight) || contains(normalizedRight, normalizedLeft)
}

export function defaultRecoveryDirectory(environment = process.env, platform = process.platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  if (platform === 'win32') {
    const stateRoot = environment.LOCALAPPDATA || environment.APPDATA
    if (!stateRoot || !pathApi.isAbsolute(stateRoot)) {
      throw new Error('Cannot resolve a durable Windows recovery directory from LOCALAPPDATA or APPDATA')
    }
    return pathApi.join(stateRoot, 'StandardRedNotes', 'recovery')
  }
  if (platform === 'darwin') {
    if (!environment.HOME || !pathApi.isAbsolute(environment.HOME)) {
      throw new Error('Cannot resolve a durable macOS recovery directory from HOME')
    }
    return pathApi.join(environment.HOME, 'Library', 'Application Support', 'StandardRedNotes', 'recovery')
  }
  const stateRoot =
    environment.XDG_STATE_HOME && pathApi.isAbsolute(environment.XDG_STATE_HOME)
      ? environment.XDG_STATE_HOME
      : environment.HOME && pathApi.isAbsolute(environment.HOME)
        ? pathApi.join(environment.HOME, '.local', 'state')
        : null
  if (!stateRoot) throw new Error('Cannot resolve a durable recovery directory from XDG_STATE_HOME or HOME')
  return pathApi.join(stateRoot, 'standard-red-notes', 'recovery')
}

export function selectSetupEnvironmentBackupNames(
  names,
  environmentBasename,
  limit = MAX_AUTOMATIC_ENVIRONMENT_BACKUPS,
) {
  const escapedBasename = environmentBasename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapedBasename}\\.bak\\.(\\d{14})$`)
  return names
    .filter((name) => pattern.test(name))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit)
}

function pathMatchesRealPath(target) {
  const resolved = realpathSync(target)
  return process.platform === 'win32' ? resolved.toLowerCase() === target.toLowerCase() : resolved === target
}

function requireOperatorOwned(stats, label) {
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the current operator`)
  }
}

function validateProtectedDirectory(directory, label) {
  const stats = lstatSync(directory)
  if (!stats.isDirectory() || stats.isSymbolicLink() || !pathMatchesRealPath(directory)) {
    throw new Error(`${label} must be a real directory, not a symbolic link or junction`)
  }
  requireOperatorOwned(stats, label)
  if (process.platform !== 'win32' && (stats.mode & 0o077) !== 0) {
    throw new Error(`${label} must not be accessible by group or other users`)
  }
}

function resolveRecoveryDirectory(explicitDirectory) {
  if (explicitDirectory) {
    if (!existsSync(explicitDirectory)) throw new Error('--backup-dir must be an existing protected directory')
    validateProtectedDirectory(explicitDirectory, '--backup-dir')
    return explicitDirectory
  }
  const directory = defaultRecoveryDirectory()
  mkdirSync(directory, { mode: 0o700, recursive: true })
  requireOperatorOwned(lstatSync(directory), 'Default recovery directory')
  if (process.platform !== 'win32') chmodSync(directory, 0o700)
  validateProtectedDirectory(directory, 'Default recovery directory')
  return directory
}

function discoverSetupEnvironmentBackups(environmentPath) {
  const directory = path.dirname(environmentPath)
  const names = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .map((entry) => entry.name)
  return selectSetupEnvironmentBackupNames(names, path.basename(environmentPath)).map((name) =>
    path.join(directory, name),
  )
}

export function protectCurrentEnvironment(environmentPath, recoveryDirectory, timestamp) {
  const name = `environment-before-rollback-${timestamp}.env`
  const backupPath = path.join(recoveryDirectory, name)
  const checksumPath = `${backupPath}.sha256`
  copyFileSync(environmentPath, backupPath, fsConstants.COPYFILE_EXCL)
  chmodSync(backupPath, 0o600)
  const digest = createHash('sha256').update(readFileSync(backupPath)).digest('hex')
  const sourceDigest = createHash('sha256').update(readFileSync(environmentPath)).digest('hex')
  if (digest !== sourceDigest) throw new Error('Protected current environment does not match the active source')
  writeFileSync(checksumPath, `${digest}  ${name}\n`, { flag: 'wx', mode: 0o600 })
  chmodSync(checksumPath, 0o600)
  return { backupPath, checksumPath, digest }
}

export function atomicallyRestoreEnvironment(sourcePath, environmentPath, timestamp, expectedDigest = null) {
  const temporaryPath = `${environmentPath}.recovery-${process.pid}-${timestamp}.tmp`
  try {
    const source = readFileSync(sourcePath)
    const sourceDigest = createHash('sha256').update(source).digest('hex')
    if (expectedDigest && sourceDigest !== expectedDigest) {
      throw new Error('Trusted setup environment changed during validation')
    }
    writeFileSync(temporaryPath, source, { flag: 'wx', mode: 0o600 })
    const descriptor = openSync(temporaryPath, 'r+')
    try {
      fsyncSync(descriptor)
    } finally {
      closeSync(descriptor)
    }
    renameSync(temporaryPath, environmentPath)
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
    throw error
  }
}

const BACKUP_DRILL_BASE_ENVIRONMENT_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'ComSpec',
  'COMSPEC',
  'SystemRoot',
  'SYSTEMROOT',
  'SystemDrive',
  'WINDIR',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'TEMP',
  'TMP',
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'DOCKER_CONFIG',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
  'DOCKER_CLI_PLUGIN_EXTRA_DIRS',
  'XDG_CONFIG_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSH_AUTH_SOCK',
]

const BACKUP_DRILL_DATABASE_ENVIRONMENT_KEYS = ['MYSQL_PASSWORD', 'MYSQL_ROOT_PASSWORD', 'MYSQL_DATABASE', 'MYSQL_USER']

export function buildBackupDrillEnvironment({
  baseEnvironment = process.env,
  composeFile = null,
  envFile,
  envFilePath = null,
  projectName = null,
}) {
  const environment = {}
  for (const key of BACKUP_DRILL_BASE_ENVIRONMENT_KEYS) {
    if (typeof baseEnvironment[key] === 'string') environment[key] = baseEnvironment[key]
  }
  for (const key of BACKUP_DRILL_DATABASE_ENVIRONMENT_KEYS) {
    if (typeof envFile[key] === 'string') environment[key] = envFile[key]
  }
  if (projectName) environment.COMPOSE_PROJECT_NAME = projectName
  if (composeFile) environment.COMPOSE_FILE = composeFile
  if (envFilePath) environment.COMPOSE_ENV_FILES = envFilePath
  return environment
}

export function sqlIdentifier(value) {
  const text = String(value)
  if (!/^[A-Za-z0-9_]{1,64}$/.test(text)) {
    throw new Error('Database and user names must contain only ASCII letters, digits, and underscores')
  }
  return `\`${text}\``
}

export function sqlString(value) {
  const text = String(value)
  if (!text || /[\0\r\n]/.test(text)) {
    throw new Error('Database credentials must be non-empty single-line values')
  }
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`
}

export function buildApplicationUserRepairSql({ database, hosts = ['%'], password, user }) {
  const databaseIdentifier = sqlIdentifier(database)
  const userLiteral = sqlString(user)
  const passwordLiteral = sqlString(password)
  const safeHosts = [...new Set(['%', ...hosts])]
  if (safeHosts.some((host) => !['%', '127.0.0.1', 'localhost'].includes(host))) {
    throw new Error('Refusing to alter an unexpected database account host')
  }
  return safeHosts
    .flatMap((host) => {
      const hostLiteral = sqlString(host)
      return [
        `CREATE USER IF NOT EXISTS ${userLiteral}@${hostLiteral} IDENTIFIED BY ${passwordLiteral};`,
        `ALTER USER ${userLiteral}@${hostLiteral} IDENTIFIED BY ${passwordLiteral};`,
        `GRANT ALL PRIVILEGES ON ${databaseIdentifier}.* TO ${userLiteral}@${hostLiteral};`,
      ]
    })
    .join('\n')
}

export function buildRootUserRepairSql({ hosts, password }) {
  const safeHosts = [...new Set(hosts)]
  if (safeHosts.length < 1 || safeHosts.some((host) => !['%', '127.0.0.1', 'localhost'].includes(host))) {
    throw new Error('Refusing to alter an unexpected MariaDB root account host')
  }
  const passwordLiteral = sqlString(password)
  return safeHosts.map((host) => `ALTER USER 'root'@${sqlString(host)} IDENTIFIED BY ${passwordLiteral};`).join('\n')
}

function environmentMap(environment) {
  if (!Array.isArray(environment)) return environment ?? {}
  return Object.fromEntries(
    environment.map((entry) => {
      const text = String(entry)
      const separator = text.indexOf('=')
      return separator < 0 ? [text, ''] : [text.slice(0, separator), text.slice(separator + 1)]
    }),
  )
}

function validateCandidateComposeConfiguration(args, environmentPath, candidateEnvironment) {
  const configuration = JSON.parse(
    compose(buildComposePrefix(args, environmentPath), ['config', '--format', 'json'], {
      label: `Compose validation for ${environmentPath}`,
    }).stdout,
  )
  const database = environmentMap(configuration.services?.db?.environment)
  const server = environmentMap(configuration.services?.server?.environment)
  if (
    database.MYSQL_DATABASE !== candidateEnvironment.MYSQL_DATABASE ||
    database.MYSQL_USER !== candidateEnvironment.MYSQL_USER ||
    database.MYSQL_PASSWORD !== candidateEnvironment.MYSQL_PASSWORD ||
    database.MYSQL_ROOT_PASSWORD !== candidateEnvironment.MYSQL_ROOT_PASSWORD ||
    server.DB_DATABASE !== candidateEnvironment.MYSQL_DATABASE ||
    server.DB_USERNAME !== candidateEnvironment.MYSQL_USER ||
    server.DB_PASSWORD !== candidateEnvironment.MYSQL_PASSWORD
  ) {
    throw new Error('Candidate environment does not resolve to one consistent Compose database contract')
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
    input: options.input,
    maxBuffer: 16 * 1024 * 1024,
    env: options.env ?? process.env,
    windowsHide: true,
  })
  if (result.error) throw new Error(`${options.label ?? command} could not start`)
  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`${options.label ?? command} failed with exit code ${result.status}`)
  }
  return result
}

function docker(args, options) {
  return run('docker', args, options)
}

function compose(prefix, args, options) {
  return docker(['compose', ...prefix, ...args], options)
}

function buildComposePrefix(args, environmentFileOverride = null) {
  const prefix = []
  if (args.projectName) prefix.push('--project-name', args.projectName)
  const environmentFile = environmentFileOverride ?? args.envFile
  if (environmentFile) prefix.push('--env-file', environmentFile)
  if (args.composeFile) prefix.push('--file', args.composeFile)
  return prefix
}

function inspectContainer(id) {
  const result = docker(['inspect', id], {
    label: 'Docker container inspection',
  })
  return JSON.parse(result.stdout)[0]
}

function composeContainerId(prefix, service, includeStopped = false) {
  return compose(prefix, ['ps', ...(includeStopped ? ['--all'] : []), '-q', service], {
    label: `Compose ${service} lookup`,
  }).stdout.trim()
}

function printFingerprint(label, value) {
  console.log(`${label}: ${fingerprint(value)}`)
}

function sameSecret(left, right) {
  return typeof left === 'string' && left.length > 0 && left === right
}

function waitForRoot(containerId, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const result = docker(
      [
        'exec',
        containerId,
        'sh',
        '-ec',
        'exec mariadb -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --batch --raw --skip-column-names -e "SELECT 1"',
      ],
      { allowFailure: true, label: 'MariaDB root authentication' },
    )
    if (result.status === 0 && result.stdout.trim() === '1') return true
    if (/access denied/i.test(result.stderr)) return false
    const state = inspectContainer(containerId)?.State
    if (!state?.Running) return false
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  return false
}

function previousRootSql(containerId, password, sql, options = {}) {
  return docker(
    [
      'exec',
      '-i',
      containerId,
      'sh',
      '-ec',
      'IFS= read -r PREVIOUS_ROOT_PASSWORD; export MYSQL_PWD="$PREVIOUS_ROOT_PASSWORD"; exec mariadb -h 127.0.0.1 -uroot --batch --raw --skip-column-names',
    ],
    { ...options, input: `${password}\n${sql}` },
  )
}

function authenticatePreviousRoot(containerId, password) {
  const result = previousRootSql(containerId, password, 'SELECT 1;\n', {
    allowFailure: true,
    label: 'MariaDB previous-root authentication',
  })
  return result.status === 0 && result.stdout.trim() === '1'
}

function authenticateApplicationCredential(containerId, { database, password, user }) {
  const result = docker(
    [
      'exec',
      '-i',
      containerId,
      'sh',
      '-ec',
      'IFS= read -r CANDIDATE_PASSWORD; export MYSQL_PWD="$CANDIDATE_PASSWORD"; exec mariadb -h 127.0.0.1 -u"$1" "$2" --batch --raw --skip-column-names -e "SELECT CURRENT_USER(), DATABASE()"',
      '--',
      user,
      database,
    ],
    { allowFailure: true, input: `${password}\n`, label: 'MariaDB application authentication' },
  )
  if (result.status !== 0) return false
  const [authenticatedAccount, authenticatedDatabase] = result.stdout.trim().split('\t')
  return authenticatedAccount?.startsWith(`${user}@`) && authenticatedDatabase === database
}

function rootSql(containerId, sql, options = {}) {
  return docker(
    [
      'exec',
      '-i',
      containerId,
      'sh',
      '-ec',
      'exec mariadb -h 127.0.0.1 -uroot -p"$MYSQL_ROOT_PASSWORD" --batch --raw --skip-column-names',
    ],
    { ...options, input: sql },
  )
}

function waitForHealthy(prefix, service, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const containerId = composeContainerId(prefix, service)
    if (containerId) {
      const state = inspectContainer(containerId)?.State
      if (state?.Health?.Status === 'healthy') return containerId
      if (state && !state.Running) throw new Error(`${service} exited before becoming healthy`)
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000)
  }
  throw new Error(`${service} did not become healthy within ${timeoutMs / 1_000} seconds`)
}

function restorePreviouslyRunning(containerStates) {
  for (const { id, running } of containerStates) {
    if (running && id) docker(['start', id], { label: 'Original container-state restoration' })
  }
}

function failClosedAfterRecoveryMutation(prefix) {
  compose(prefix, ['stop', '--timeout', '60', 'app', 'server'], {
    label: 'Post-mutation writer shutdown',
  })
}

function printRootRecoveryGuidance(backupPath, backupSha256) {
  console.error('MariaDB root authentication failed; no SQL credential or grant was changed.')
  console.error(`Cold volume backup: ${backupPath}`)
  console.error(`Cold volume backup SHA-256: ${backupSha256}`)
  console.error('Stop here. Do not delete the volume or regenerate .env.')
  console.error(
    'Recovery requires an isolated maintenance window: stop every writer and MariaDB, preserve this backup, start the same MariaDB image with --skip-grant-tables and --skip-networking, FLUSH PRIVILEGES, repair root authentication, stop that recovery container, then rerun this tool. This tool does not perform that escalation.',
  )
}

export function databaseCredentialPairAuthenticates({ applicationAuthenticated, rootAuthenticated }) {
  return rootAuthenticated === true && applicationAuthenticated === true
}

export function recoveryFailureRequiresFailClosed({
  configurationMutationStarted,
  sqlMutationStarted,
  topologyMutationStarted,
}) {
  return configurationMutationStarted || sqlMutationStarted || topologyMutationStarted
}

export function validatePreviousEnvironmentValues(
  previousEnvironment,
  desiredIdentity,
  { requireDifferentRoot = true, requireMatchingIdentity = true } = {},
) {
  if (
    requireMatchingIdentity &&
    (previousEnvironment.MYSQL_USER !== desiredIdentity.user ||
      previousEnvironment.MYSQL_DATABASE !== desiredIdentity.database)
  ) {
    throw new Error('--previous-env-file belongs to a different database identity')
  }
  if (
    !previousEnvironment.MYSQL_ROOT_PASSWORD ||
    !previousEnvironment.MYSQL_PASSWORD ||
    !previousEnvironment.MYSQL_USER ||
    !previousEnvironment.MYSQL_DATABASE
  ) {
    throw new Error('--previous-env-file does not contain the complete MariaDB identity and credentials')
  }
  sqlIdentifier(previousEnvironment.MYSQL_USER)
  sqlIdentifier(previousEnvironment.MYSQL_DATABASE)
  sqlString(previousEnvironment.MYSQL_ROOT_PASSWORD)
  sqlString(previousEnvironment.MYSQL_PASSWORD)
  if (sameSecret(previousEnvironment.MYSQL_ROOT_PASSWORD, previousEnvironment.MYSQL_PASSWORD)) {
    throw new Error('--previous-env-file root and application credentials must be distinct')
  }
  if (requireDifferentRoot && sameSecret(previousEnvironment.MYSQL_ROOT_PASSWORD, desiredIdentity.rootPassword)) {
    throw new Error('--previous-env-file MYSQL_ROOT_PASSWORD must differ from the desired root credential')
  }
  return previousEnvironment
}

function readPreviousEnvironment(
  previousEnvPath,
  desiredIdentity,
  { requireDifferentRoot = true, requireMatchingIdentity = true } = {},
) {
  if (!previousEnvPath) return null
  if (!existsSync(previousEnvPath) || !lstatSync(previousEnvPath).isFile()) {
    throw new Error('--previous-env-file must be an existing regular file')
  }
  const previousStats = lstatSync(previousEnvPath)
  const resolvedPreviousPath = realpathSync(previousEnvPath)
  const pathsMatch =
    process.platform === 'win32'
      ? resolvedPreviousPath.toLowerCase() === previousEnvPath.toLowerCase()
      : resolvedPreviousPath === previousEnvPath
  if (previousStats.isSymbolicLink() || !pathsMatch) {
    throw new Error('--previous-env-file must not be a symbolic link or junction')
  }
  requireOperatorOwned(previousStats, '--previous-env-file')
  if (process.platform !== 'win32' && (previousStats.mode & 0o077) !== 0) {
    throw new Error('--previous-env-file must not be readable or writable by group or other users')
  }
  const source = readFileSync(previousEnvPath)
  const previousEnvironment = validatePreviousEnvironmentValues(parseEnvSource(source.toString('utf8')), desiredIdentity, {
    requireDifferentRoot,
    requireMatchingIdentity,
  })
  return {
    digest: createHash('sha256').update(source).digest('hex'),
    environment: previousEnvironment,
  }
}

export function runRecovery(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  if (args.help) {
    console.log('Usage: node scripts/reconcile-database-credentials.mjs --execute')
    console.log('Safely restores the newest trusted setup-generated environment that authenticates to MariaDB.')
    console.log('Recovery always cold-backs up MariaDB and preserves the current environment first.')
    console.log(
      'Advanced paths/scope: --backup-dir <dir> --env-file <file> --compose-file <file> --project-name <name>',
    )
    console.log('Advanced candidate override: --previous-env-file <explicit-protected-env-backup>')
    console.log('Intentional DB-only rotation: --rotate-database-credentials')
    return
  }
  if (!args.execute) throw new Error('Refusing recovery without --execute')
  args.backupDir = resolveRecoveryDirectory(args.backupDir)
  if (args.backupDir.includes(',')) {
    throw new Error('--backup-dir cannot contain a comma because Docker --mount uses comma delimiters')
  }
  console.log(`Protected recovery directory: ${args.backupDir}`)

  const envPath = args.envFile ?? path.join(REPOSITORY_ROOT, '.env')
  if (!existsSync(envPath)) throw new Error('Missing repository .env')
  const environmentStats = lstatSync(envPath)
  if (!environmentStats.isFile() || environmentStats.isSymbolicLink() || !pathMatchesRealPath(envPath)) {
    throw new Error('The active environment must be a real regular file, not a symbolic link or junction')
  }
  requireOperatorOwned(environmentStats, 'The active environment')
  const composePrefix = buildComposePrefix(args)
  const envFile = parseEnvSource(readFileSync(envPath, 'utf8'))
  const composeConfig = JSON.parse(
    compose(composePrefix, ['config', '--format', 'json'], {
      label: 'Compose configuration',
    }).stdout,
  )
  const databaseEnvironment = environmentMap(composeConfig.services?.db?.environment)
  const serverEnvironment = environmentMap(composeConfig.services?.server?.environment)
  const desiredAppPassword = envFile.MYSQL_PASSWORD
  const desiredRootPassword = envFile.MYSQL_ROOT_PASSWORD
  const databaseName = envFile.MYSQL_DATABASE
  const databaseUser = envFile.MYSQL_USER

  if ([desiredAppPassword, desiredRootPassword, databaseName, databaseUser].some((value) => !value)) {
    throw new Error('.env must define MYSQL_PASSWORD, MYSQL_ROOT_PASSWORD, MYSQL_DATABASE, and MYSQL_USER')
  }
  sqlIdentifier(databaseName)
  sqlIdentifier(databaseUser)
  sqlString(desiredAppPassword)
  sqlString(desiredRootPassword)
  if (sameSecret(desiredAppPassword, desiredRootPassword)) {
    throw new Error('MYSQL_PASSWORD and MYSQL_ROOT_PASSWORD must be distinct')
  }

  const databaseId = composeContainerId(composePrefix, 'db', true)
  if (!databaseId) throw new Error('The Compose db container does not exist')
  const databaseInspect = inspectContainer(databaseId)
  if (databaseInspect.State?.Running !== true) {
    throw new Error('The Compose db container must be running before credential recovery')
  }
  const databaseContainerEnvironment = environmentMap(databaseInspect.Config?.Env)
  const serverId = composeContainerId(composePrefix, 'server', true)
  const appId = composeContainerId(composePrefix, 'app', true)
  const serverInspect = serverId ? inspectContainer(serverId) : null
  const serverContainerEnvironment = environmentMap(serverInspect?.Config?.Env)

  console.log('Credential fingerprints (values are never printed):')
  printFingerprint('.env MYSQL_PASSWORD', desiredAppPassword)
  printFingerprint('Compose db MYSQL_PASSWORD', databaseEnvironment.MYSQL_PASSWORD)
  printFingerprint('Compose server DB_PASSWORD', serverEnvironment.DB_PASSWORD)
  printFingerprint('db container MYSQL_PASSWORD', databaseContainerEnvironment.MYSQL_PASSWORD)
  printFingerprint('server container DB_PASSWORD', serverContainerEnvironment.DB_PASSWORD)
  printFingerprint('.env MYSQL_ROOT_PASSWORD', desiredRootPassword)
  printFingerprint('Compose db MYSQL_ROOT_PASSWORD', databaseEnvironment.MYSQL_ROOT_PASSWORD)
  printFingerprint('db container MYSQL_ROOT_PASSWORD', databaseContainerEnvironment.MYSQL_ROOT_PASSWORD)

  console.log('Database identity (non-secret):')
  console.log(`.env: ${databaseName} / ${databaseUser}`)
  console.log(`Compose db: ${databaseEnvironment.MYSQL_DATABASE} / ${databaseEnvironment.MYSQL_USER}`)
  console.log(`Compose server: ${serverEnvironment.DB_DATABASE} / ${serverEnvironment.DB_USERNAME}`)
  console.log(
    `db container: ${databaseContainerEnvironment.MYSQL_DATABASE} / ${databaseContainerEnvironment.MYSQL_USER}`,
  )
  if (serverId) {
    console.log(
      `server container: ${serverContainerEnvironment.DB_DATABASE} / ${serverContainerEnvironment.DB_USERNAME}`,
    )
  }

  if (
    !sameSecret(desiredAppPassword, databaseEnvironment.MYSQL_PASSWORD) ||
    !sameSecret(desiredAppPassword, serverEnvironment.DB_PASSWORD) ||
    !sameSecret(desiredRootPassword, databaseEnvironment.MYSQL_ROOT_PASSWORD)
  ) {
    throw new Error(
      'Current shell/Compose credential inputs do not match .env; clear overrides or update .env before recovery',
    )
  }
  if (
    databaseName !== databaseEnvironment.MYSQL_DATABASE ||
    databaseName !== serverEnvironment.DB_DATABASE ||
    databaseUser !== databaseEnvironment.MYSQL_USER ||
    databaseUser !== serverEnvironment.DB_USERNAME
  ) {
    throw new Error('Compose database/user identity does not match .env; reconcile configuration before recovery')
  }
  if (
    databaseContainerEnvironment.MYSQL_DATABASE !== databaseName ||
    databaseContainerEnvironment.MYSQL_USER !== databaseUser ||
    (serverId &&
      (serverContainerEnvironment.DB_DATABASE !== databaseName ||
        serverContainerEnvironment.DB_USERNAME !== databaseUser))
  ) {
    throw new Error(
      'Running container database/user identity does not match .env; inspect the deployment before recovery',
    )
  }

  const databaseMount = (databaseInspect.Mounts ?? []).find(
    (mount) => mount.Type === 'volume' && mount.Destination === '/var/lib/mysql',
  )
  if (!databaseMount?.Name) throw new Error('Could not resolve the exact MariaDB named volume')
  const databaseVolumeInspect = JSON.parse(
    docker(['volume', 'inspect', databaseMount.Name], { label: 'MariaDB volume inspection' }).stdout,
  )[0]
  if (!databaseVolumeInspect?.Mountpoint) throw new Error('Could not resolve the MariaDB volume mountpoint')
  if (pathsOverlap(args.backupDir, databaseVolumeInspect.Mountpoint)) {
    throw new Error('--backup-dir must be external to the MariaDB volume mountpoint')
  }
  const databaseImage = String(databaseInspect.Config?.Image ?? '')
  if (!databaseImage) throw new Error('Could not resolve the running MariaDB image')
  const backupOwner =
    typeof process.getuid === 'function' && typeof process.getgid === 'function'
      ? `${process.getuid()}:${process.getgid()}`
      : null
  docker(
    [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--entrypoint',
      '/bin/sh',
      databaseImage,
      '-ec',
      `command -v tar >/dev/null && command -v sha256sum >/dev/null${backupOwner ? ' && command -v chown >/dev/null' : ''}`,
    ],
    { label: 'MariaDB backup-tool preflight' },
  )
  const rootInputMatchesContainer = sameSecret(desiredRootPassword, databaseContainerEnvironment.MYSQL_ROOT_PASSWORD)

  const states = [
    {
      id: appId,
      running: appId ? inspectContainer(appId).State?.Running === true : false,
    },
    { id: serverId, running: serverInspect?.State?.Running === true },
    { id: databaseId, running: databaseInspect.State?.Running === true },
  ]
  let configurationMutationStarted = false
  let protectedBackupPath = null
  let sqlMutationStarted = false
  let topologyMutationStarted = false
  try {
    for (const state of states.slice(0, 2)) {
      if (state.running) docker(['stop', '--time', '60', state.id], { label: 'Writer shutdown' })
    }
    if (states[2].running) docker(['stop', '--time', '60', databaseId], { label: 'MariaDB shutdown' })

    const timestamp = new Date().toISOString().replaceAll(/[-:.]/g, '').replace('Z', 'Z')
    const backupName = `mariadb-volume-${timestamp}.tar.gz`
    const backupPath = path.join(args.backupDir, backupName)
    const checksumPath = `${backupPath}.sha256`
    if (existsSync(backupPath) || existsSync(checksumPath)) {
      throw new Error('Refusing to overwrite an existing recovery backup')
    }
    docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'DAC_READ_SEARCH',
        ...(backupOwner ? ['--cap-add', 'CHOWN'] : []),
        '--security-opt',
        'no-new-privileges:true',
        '--mount',
        `type=volume,source=${databaseMount.Name},target=/source,readonly`,
        '--mount',
        `type=bind,source=${args.backupDir},target=/backup`,
        '--entrypoint',
        '/bin/sh',
        databaseImage,
        '-ec',
        `umask 077; tar -czf /backup/.${backupName}.partial -C /source .; mv /backup/.${backupName}.partial /backup/${backupName}; cd /backup; sha256sum ${backupName} > .${backupName}.sha256.partial; mv .${backupName}.sha256.partial ${backupName}.sha256; chmod 0600 ${backupName} ${backupName}.sha256${backupOwner ? `; chown ${backupOwner} ${backupName} ${backupName}.sha256` : ''}`,
      ],
      { label: 'Cold MariaDB volume backup' },
    )
    if (!existsSync(backupPath) || statSync(backupPath).size <= 0) {
      throw new Error('Cold MariaDB volume backup is missing or empty')
    }
    chmodSync(backupPath, 0o600)
    chmodSync(checksumPath, 0o600)
    const backupSha256 = parseChecksumSidecar(readFileSync(checksumPath, 'utf8'), backupName)
    docker(
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--cap-add',
        'DAC_READ_SEARCH',
        '--security-opt',
        'no-new-privileges:true',
        '--mount',
        `type=bind,source=${args.backupDir},target=/backup,readonly`,
        '--workdir',
        '/backup',
        '--entrypoint',
        'sha256sum',
        databaseImage,
        '-c',
        `${backupName}.sha256`,
      ],
      { label: 'Cold MariaDB volume backup checksum verification' },
    )
    protectedBackupPath = backupPath
    console.log(`Cold volume backup: ${backupPath}`)
    console.log(`Cold volume backup SHA-256: ${backupSha256}`)

    docker(['start', databaseId], { label: 'MariaDB restart' })
    let activeDatabaseId = databaseId
    let rootAuthenticated = rootInputMatchesContainer && waitForRoot(activeDatabaseId)
    const applicationAuthenticated = authenticateApplicationCredential(activeDatabaseId, {
      database: databaseName,
      password: desiredAppPassword,
      user: databaseUser,
    })
    const currentDatabaseContractAuthenticated = databaseCredentialPairAuthenticates({
      applicationAuthenticated,
      rootAuthenticated,
    })
    let rootCredentialChanged = false
    let effectiveEnvironment = envFile
    let effectiveDatabaseName = databaseName
    let effectiveDatabaseUser = databaseUser
    let selectedPreviousEnvironment = null
    let selectedPreviousEnvironmentDigest = null
    let selectedPreviousEnvironmentPath = null
    if (!currentDatabaseContractAuthenticated) {
      const automaticCandidates = args.previousEnvFile ? null : discoverSetupEnvironmentBackups(envPath)
      const candidatePaths = args.previousEnvFile ? [args.previousEnvFile] : automaticCandidates
      if (!args.previousEnvFile) {
        console.log(`Trusted setup environment candidates: ${candidatePaths.length} (newest first, maximum 20)`)
      }
      for (const candidatePath of candidatePaths) {
        let candidateEnvironment
        let candidateEnvironmentDigest
        try {
          const candidate = readPreviousEnvironment(
            candidatePath,
            {
              database: databaseName,
              rootPassword: desiredRootPassword,
              user: databaseUser,
            },
            {
              requireDifferentRoot: args.rotateDatabaseCredentials,
              requireMatchingIdentity: args.rotateDatabaseCredentials,
            },
          )
          candidateEnvironment = candidate.environment
          candidateEnvironmentDigest = candidate.digest
        } catch (error) {
          if (args.previousEnvFile) throw error
          const message = error instanceof Error ? error.message : String(error)
          console.warn(`Skipped trusted setup environment ${candidatePath}: ${message}`)
          continue
        }
        printFingerprint(
          `Candidate ${path.basename(candidatePath)} MYSQL_ROOT_PASSWORD`,
          candidateEnvironment.MYSQL_ROOT_PASSWORD,
        )
        const candidateRootAuthenticated = authenticatePreviousRoot(
          activeDatabaseId,
          candidateEnvironment.MYSQL_ROOT_PASSWORD,
        )
        const candidateApplicationAuthenticated = authenticateApplicationCredential(activeDatabaseId, {
          database: candidateEnvironment.MYSQL_DATABASE,
          password: candidateEnvironment.MYSQL_PASSWORD,
          user: candidateEnvironment.MYSQL_USER,
        })
        if (
          databaseCredentialPairAuthenticates({
            applicationAuthenticated: candidateApplicationAuthenticated,
            rootAuthenticated: candidateRootAuthenticated,
          })
        ) {
          try {
            validateCandidateComposeConfiguration(args, candidatePath, candidateEnvironment)
            const postValidationDigest = createHash('sha256').update(readFileSync(candidatePath)).digest('hex')
            if (postValidationDigest !== candidateEnvironmentDigest) {
              throw new Error('Candidate environment changed during authentication and Compose validation')
            }
          } catch (error) {
            if (args.previousEnvFile) throw error
            const message = error instanceof Error ? error.message : String(error)
            console.warn(`Skipped trusted setup environment ${candidatePath}: ${message}`)
            continue
          }
          selectedPreviousEnvironment = candidateEnvironment
          selectedPreviousEnvironmentDigest = candidateEnvironmentDigest
          selectedPreviousEnvironmentPath = candidatePath
          console.log(`Trusted setup environment authenticated: ${candidatePath}`)
          break
        }
        console.log(`Trusted setup environment did not authenticate: ${candidatePath}`)
      }
    }

    if (!args.rotateDatabaseCredentials) {
      if (currentDatabaseContractAuthenticated) {
        console.log('Current full database contract already authenticates; no environment rollback was required.')
      } else if (!selectedPreviousEnvironment || !selectedPreviousEnvironmentPath) {
        restorePreviouslyRunning(states)
        console.error('No trusted setup-generated environment backup authenticated; no environment or SQL was changed.')
        console.error(`Cold volume backup: ${backupPath}`)
        console.error(`Cold volume backup SHA-256: ${backupSha256}`)
        console.error(
          'Use --previous-env-file only to select an explicit protected backup after verifying its provenance.',
        )
        process.exitCode = 2
        return
      } else {
        const currentEnvironmentBackup = protectCurrentEnvironment(envPath, args.backupDir, timestamp)
        console.log(`Current environment backup: ${currentEnvironmentBackup.backupPath}`)
        console.log(`Current environment backup SHA-256: ${currentEnvironmentBackup.digest}`)
        configurationMutationStarted = true
        atomicallyRestoreEnvironment(
          selectedPreviousEnvironmentPath,
          envPath,
          timestamp,
          selectedPreviousEnvironmentDigest,
        )
        effectiveEnvironment = selectedPreviousEnvironment
        effectiveDatabaseName = selectedPreviousEnvironment.MYSQL_DATABASE
        effectiveDatabaseUser = selectedPreviousEnvironment.MYSQL_USER
        for (const [key, value] of Object.entries(effectiveEnvironment)) {
          if (typeof process.env[key] === 'string' && process.env[key] !== value) {
            throw new Error(
              `Shell environment override ${key} conflicts with the restored environment; clear it and rerun`,
            )
          }
        }
        console.log(`Full environment rollback: PASS (${selectedPreviousEnvironmentPath})`)
      }
    } else {
      if (!rootAuthenticated && selectedPreviousEnvironment) {
        const existingRootHosts = previousRootSql(
          activeDatabaseId,
          selectedPreviousEnvironment.MYSQL_ROOT_PASSWORD,
          "SELECT Host FROM mysql.user WHERE User = 'root' ORDER BY Host;\n",
          { label: 'MariaDB root-account host inspection' },
        )
          .stdout.trim()
          .split(/\r?\n/)
          .map((host) => host.trim())
          .filter(Boolean)
        sqlMutationStarted = true
        previousRootSql(
          activeDatabaseId,
          selectedPreviousEnvironment.MYSQL_ROOT_PASSWORD,
          `${buildRootUserRepairSql({ hosts: existingRootHosts, password: desiredRootPassword })}\n`,
          { label: 'MariaDB root credential repair' },
        )
        rootCredentialChanged = true
        if (!rootInputMatchesContainer) {
          compose(composePrefix, ['up', '-d', '--force-recreate', 'db'], {
            label: 'Compose root credential reconciliation',
          })
          activeDatabaseId = composeContainerId(composePrefix, 'db', true)
          if (!activeDatabaseId) throw new Error('MariaDB disappeared during root credential reconciliation')
        }
        rootAuthenticated = waitForRoot(activeDatabaseId)
        if (
          rootAuthenticated &&
          authenticatePreviousRoot(activeDatabaseId, selectedPreviousEnvironment.MYSQL_ROOT_PASSWORD)
        ) {
          throw new Error('Previous MariaDB root credential remained valid after repair')
        }
        if (rootAuthenticated) console.log('MariaDB root credential rotation: PASS')
      }
      if (!rootAuthenticated) {
        if (rootCredentialChanged) {
          throw new Error(
            'MariaDB root credential repair ran but the desired credential did not validate; preserve the cold backup and inspect the database before retrying',
          )
        }
        restorePreviouslyRunning(states)
        printRootRecoveryGuidance(backupPath, backupSha256)
        process.exitCode = 2
        return
      }
      console.log('MariaDB root authentication: PASS')

      const existingHosts = rootSql(
        activeDatabaseId,
        `SELECT Host FROM mysql.user WHERE User = ${sqlString(databaseUser)} ORDER BY Host;`,
        { label: 'MariaDB application-user host inspection' },
      )
        .stdout.trim()
        .split(/\r?\n/)
        .map((host) => host.trim())
        .filter(Boolean)
      const repairSql = buildApplicationUserRepairSql({
        database: databaseName,
        hosts: existingHosts,
        password: desiredAppPassword,
        user: databaseUser,
      })
      sqlMutationStarted = true
      const repair = rootSql(activeDatabaseId, repairSql, {
        label: 'MariaDB application-user repair',
      })
      if (repair.stdout.trim()) throw new Error('MariaDB repair returned unexpected output')
    }

    topologyMutationStarted = true
    compose(composePrefix, ['up', '-d', '--force-recreate', ...CORE_RECOVERY_SERVICES], {
      label: args.rotateDatabaseCredentials ? 'Compose credential reconciliation' : 'Compose environment rollback',
    })
    const healthyDatabaseId = waitForHealthy(composePrefix, 'db')
    const healthyDatabaseEnvironment = environmentMap(inspectContainer(healthyDatabaseId).Config?.Env)
    if (
      healthyDatabaseEnvironment.MYSQL_DATABASE !== effectiveDatabaseName ||
      healthyDatabaseEnvironment.MYSQL_USER !== effectiveDatabaseUser
    ) {
      throw new Error('Recovered MariaDB container identity does not match the effective environment')
    }

    let tableCount = null
    for (const host of ['127.0.0.1', 'db']) {
      const applicationProbe = docker(
        [
          'exec',
          healthyDatabaseId,
          'sh',
          '-ec',
          'exec mariadb -h "$1" -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE" --batch --raw --skip-column-names -e "SELECT CURRENT_USER(), COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()"',
          '--',
          host,
        ],
        { label: `Application database probe through ${host}` },
      ).stdout.trim()
      const [authenticatedAccount, count] = applicationProbe.split('\t')
      if (!authenticatedAccount?.startsWith(`${effectiveDatabaseUser}@`) || !/^\d+$/.test(count) || Number(count) < 1) {
        throw new Error(`Application database probe through ${host} did not reach the expected populated account`)
      }
      if (host === 'db' && authenticatedAccount !== `${effectiveDatabaseUser}@%`) {
        throw new Error('The service-network probe did not authenticate through the expected wildcard account')
      }
      tableCount = Number(count)
    }
    console.log(`Application database authentication and grants: PASS (${tableCount} tables)`)

    waitForHealthy(composePrefix, 'server', 300_000)
    waitForHealthy(composePrefix, 'app', 300_000)
    compose(composePrefix, ['exec', '-T', 'server', 'curl', '-fsS', 'http://localhost:3000/healthcheck/readiness'], {
      label: 'Server aggregate readiness probe',
    })
    compose(composePrefix, ['exec', '-T', 'app', 'wget', '-qO-', 'http://127.0.0.1:8080/healthcheck/readiness'], {
      label: 'Application front-door readiness probe',
    })
    console.log('Server and application readiness: PASS')

    const drillEnvironment = buildBackupDrillEnvironment({
      composeFile: args.composeFile,
      envFile: effectiveEnvironment,
      envFilePath: args.envFile,
      projectName: args.projectName,
    })
    run(process.execPath, [path.join(REPOSITORY_ROOT, 'scripts', 'verify-backup-restore.mjs')], {
      env: drillEnvironment,
      label: 'Backup/restore drill',
    })
    console.log('Backup/restore drill: PASS')
    console.log(
      args.rotateDatabaseCredentials
        ? 'Database credential reconciliation completed.'
        : 'Automatic full-environment recovery completed.',
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (
      !recoveryFailureRequiresFailClosed({
        configurationMutationStarted,
        sqlMutationStarted,
        topologyMutationStarted,
      })
    ) {
      try {
        restorePreviouslyRunning(states)
      } catch (restoreError) {
        const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError)
        throw new Error(`${message}; restoring the original running state also failed: ${restoreMessage}`)
      }
      throw error
    }
    try {
      failClosedAfterRecoveryMutation(composePrefix)
    } catch (shutdownError) {
      const shutdownMessage = shutdownError instanceof Error ? shutdownError.message : String(shutdownError)
      throw new Error(
        `${message}; recovery mutation occurred and writer shutdown also failed: ${shutdownMessage}; preserve ${protectedBackupPath ?? 'the cold backup'}`,
      )
    }
    throw new Error(
      `${message}; recovery changed ${sqlMutationStarted ? 'SQL credentials' : configurationMutationStarted ? 'the active environment' : 'the Compose runtime topology'}, so app/server were stopped instead of restoring stale containers; preserve ${protectedBackupPath ?? 'the cold backup'} and rerun after inspection`,
    )
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    runRecovery()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
