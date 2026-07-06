/**
 * Standard Red Notes: pure helpers for the srn-admin in-container CLI
 * (packages/auth/bin/srn_admin.ts).
 *
 * DELIBERATELY dependency-free (no DI container, no domain imports, no IO): the
 * CLI's fast path (help / status / logs / config) must be importable without
 * pulling the auth server's module graph, and everything here must be
 * unit-testable without boot side effects. IO is injected via tiny seams.
 */

/* ------------------------------------------------------------------------- *
 * Argument parsing
 * ------------------------------------------------------------------------- */

export interface ParsedArgs {
  positionals: string[]
  options: Record<string, string | boolean>
}

/**
 * Minimal argv parser: `--key value`, `--key=value` and boolean flags. A flag
 * listed in `booleanFlags` never consumes the following token; any other
 * `--key` consumes the next token as its value unless that token is itself an
 * option (starts with `--`) or absent — in which case it degrades to `true`.
 */
export function parseArgs(argv: string[], booleanFlags: ReadonlySet<string> = BOOLEAN_FLAGS): ParsedArgs {
  const positionals: string[] = []
  const options: Record<string, string | boolean> = {}

  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positionals.push(token)
      continue
    }

    const body = token.slice(2)
    const equalsAt = body.indexOf('=')
    if (equalsAt >= 0) {
      options[body.slice(0, equalsAt)] = body.slice(equalsAt + 1)
      continue
    }

    if (booleanFlags.has(body)) {
      options[body] = true
      continue
    }

    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) {
      options[body] = true
    } else {
      options[body] = next
      index++
    }
  }

  return { positionals, options }
}

/** Flags that never take a value. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(['json', 'help'])

/* ------------------------------------------------------------------------- *
 * Ban option parsing (pure — used by the `ban` command in bin/srn_admin.ts)
 * ------------------------------------------------------------------------- */

export type CliBanType = 'permanent' | 'temporary' | 'shadow'

export interface ParsedBanOptions {
  banType: CliBanType
  bannedUntil: Date | null
}

/**
 * Parse the `ban` command's --type / --until / --duration options into a
 * concrete ban kind + optional expiry. Kept dependency-free and deterministic
 * (`now` is injected) so it is unit-testable without the DI container.
 *
 *   - --type defaults to 'permanent'; only permanent|temporary|shadow are valid.
 *   - a 'temporary' ban REQUIRES exactly one of --duration <positive minutes>
 *     or --until <ISO-8601 date in the future-ish>; --duration wins if both are
 *     supplied.
 *   - permanent / shadow ignore --until / --duration (bannedUntil = null).
 */
export function parseBanOptions(
  options: Record<string, string | boolean>,
  now: number = Date.now(),
): { ok: true; value: ParsedBanOptions } | { ok: false; error: string } {
  const typeRaw = (stringOption(options, 'type') ?? 'permanent').toLowerCase()
  if (typeRaw !== 'permanent' && typeRaw !== 'temporary' && typeRaw !== 'shadow') {
    return { ok: false, error: "--type takes 'permanent', 'temporary' or 'shadow'" }
  }
  const banType = typeRaw as CliBanType

  if (banType !== 'temporary') {
    return { ok: true, value: { banType, bannedUntil: null } }
  }

  const durationRaw = stringOption(options, 'duration')
  const untilRaw = stringOption(options, 'until')
  if (durationRaw !== undefined) {
    const minutes = Number(durationRaw)
    if (!Number.isFinite(minutes) || minutes <= 0) {
      return { ok: false, error: '--duration takes a positive number of minutes' }
    }
    return { ok: true, value: { banType, bannedUntil: new Date(now + minutes * 60_000) } }
  }
  if (untilRaw !== undefined) {
    const bannedUntil = new Date(untilRaw)
    if (Number.isNaN(bannedUntil.getTime())) {
      return { ok: false, error: '--until takes an ISO-8601 date (e.g. 2026-12-31T00:00:00Z)' }
    }
    return { ok: true, value: { banType, bannedUntil } }
  }

  return { ok: false, error: 'a temporary ban requires --until <ISO date> or --duration <minutes>' }
}

/** Read an option as a trimmed non-empty string, else undefined. */
export function stringOption(options: Record<string, string | boolean>, name: string): string | undefined {
  const value = options[name]
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()

  return trimmed === '' ? undefined : trimmed
}

/* ------------------------------------------------------------------------- *
 * Table + byte formatting
 * ------------------------------------------------------------------------- */

/** Left-aligned, padded plain-text table. Returns '' for no rows. */
export function formatTable(headers: string[], rows: string[][]): string {
  if (rows.length === 0) {
    return ''
  }
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? '').length)),
  )
  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, column) => (column === cells.length - 1 ? cell : (cell ?? '').padEnd(widths[column])))
      .join('  ')
      .trimEnd()

  return [renderRow(headers), renderRow(widths.map((width) => '-'.repeat(width))), ...rows.map(renderRow)].join('\n')
}

/** Human-readable byte count. null → '-', -1 → 'unlimited' (files-server convention). */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) {
    return '-'
  }
  if (bytes === -1) {
    return 'unlimited'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let value = bytes
  let unitIndex = -1
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Parse the <bytes|unlimited> argument of `storage-limit set`. Mirrors the
 * admin controller's setUserStorageLimit validation: an integer number of
 * bytes ≥ -1, where -1 (or the word 'unlimited') means unlimited.
 */
export function parseStorageLimitInput(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const trimmed = input.trim().toLowerCase()
  if (trimmed === 'unlimited') {
    return { ok: true, value: '-1' }
  }
  if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < -1) {
    return {
      ok: false,
      error: `Invalid storage limit '${input}'. Provide an integer number of bytes, or 'unlimited' (-1).`,
    }
  }

  return { ok: true, value: `${Number(trimmed)}` }
}

/* ------------------------------------------------------------------------- *
 * Admin-manageable per-user flags
 * ------------------------------------------------------------------------- */

export interface AdminFlagSpec {
  /** SettingName value, e.g. 'AI_ENABLED'. */
  name: string
  description: string
  /** Allowed values; undefined = free-form (mirrors the panel's validation). */
  allowedValues?: string[]
  /**
   * true when the flag is admin-manageable ONLY through this CLI (the in-app
   * admin panel's allow-list does not include it). These are plain per-user
   * opt-in booleans of the same class as the panel-managed ones.
   */
  cliOnly?: boolean
}

const STRICT_BOOLEAN = ['true', 'false']

/**
 * Mirror of BaseAdminController's ADMIN_MANAGEABLE_SETTINGS allow-list (and its
 * per-setting validators), plus the CLI-only strict-boolean user opt-ins
 * (CALDAV_ENABLED, REMINDER_DELIVERY_ENABLED). Keep in sync with
 * src/Infra/InversifyExpressUtils/Base/BaseAdminController.ts. Sensitive
 * settings (MFA secret, backup app passwords, ...) are deliberately absent and
 * are refused by name lookup.
 */
export const CLI_MANAGEABLE_FLAGS: AdminFlagSpec[] = [
  { name: 'AI_ENABLED', description: 'AI assistant access for this user' },
  { name: 'AI_REQUEST_LIMIT', description: 'Per-user AI request limit' },
  {
    name: 'EMAIL_BACKUP_FREQUENCY',
    description: 'Scheduled email-backup cadence',
    allowedValues: ['disabled', 'daily', 'weekly', 'monthly'],
  },
  { name: 'EMAIL_REMINDERS_ENABLED', description: 'Per-account email-reminder opt-in' },
  { name: 'OCR_SERVER_ALLOWED', description: 'Server-side OCR opt-in (leaves E2EE)', allowedValues: STRICT_BOOLEAN },
  {
    name: 'NEXTCLOUD_BACKUP_ALLOWED',
    description: 'Scheduled Nextcloud backups admin gate',
    allowedValues: STRICT_BOOLEAN,
  },
  { name: 'NEXTCLOUD_BACKUP_FREQUENCY', description: 'Nextcloud backup cadence (view/override)' },
  { name: 'WORKFLOWS_ENABLED', description: 'Workflows (n8n automation) admin gate', allowedValues: STRICT_BOOLEAN },
  {
    name: 'CALDAV_ENABLED',
    description: 'CalDAV bridge user opt-in (CLI-only override)',
    allowedValues: STRICT_BOOLEAN,
    cliOnly: true,
  },
  {
    name: 'REMINDER_DELIVERY_ENABLED',
    description: 'Reminder-delivery user opt-in (CLI-only override)',
    allowedValues: STRICT_BOOLEAN,
    cliOnly: true,
  },
]

/** The per-user server storage limit takes a dedicated subscription-setting path. */
export const STORAGE_LIMIT_SETTING = 'FILE_UPLOAD_BYTES_LIMIT'
export const STORAGE_USED_SETTING = 'FILE_UPLOAD_BYTES_USED'

export function findFlagSpec(name: string): AdminFlagSpec | undefined {
  return CLI_MANAGEABLE_FLAGS.find((spec) => spec.name === name.toUpperCase())
}

/**
 * Validate a flag write. Mirrors the panel's validators: strict-boolean flags
 * accept only 'true'/'false'; the email-backup cadence accepts only real
 * frequencies; everything else is free-form. `null` (an unset) is always valid.
 */
export function validateFlagValue(
  spec: AdminFlagSpec,
  value: string | null,
): { ok: true } | { ok: false; error: string } {
  if (value === null || spec.allowedValues === undefined || spec.allowedValues.includes(value)) {
    return { ok: true }
  }

  return {
    ok: false,
    error: `Invalid value '${value}' for ${spec.name}. Allowed: ${spec.allowedValues.join(' | ')}.`,
  }
}

/* ------------------------------------------------------------------------- *
 * Log tailing (ported from api-gateway's AdminLogsService — the CLI runs in the
 * same container, so the supervisord log files are local)
 * ------------------------------------------------------------------------- */

export interface CliLogEntry {
  timestamp: string | null
  service: string | null
  level: string | null
  message: string
}

export interface CliLogsQuery {
  limit: number
  service?: string
  level?: string
}

export interface CliLogsResult {
  entries: CliLogEntry[]
  truncated: boolean
}

/** Filesystem seam so log tailing is unit-testable without a real directory. */
export interface LogFileSystemLike {
  readdir(directory: string): Promise<string[]>
  readFile(filePath: string): Promise<string>
  joinPath(...parts: string[]): string
}

/**
 * Parse one log line: winston JSON lines carry timestamp/service/level; plain
 * lines only fill `message` (service inferred from the file name). Identical
 * semantics to AdminLogsService.parseLine.
 */
export function parseLogLine(line: string, serviceFromFile: string): CliLogEntry {
  const trimmed = line.trim()
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>
      const timestamp = parsed.timestamp ?? parsed.time ?? parsed['@timestamp']
      const message = parsed.message ?? parsed.msg ?? ''

      return {
        timestamp: typeof timestamp === 'string' ? timestamp : timestamp != null ? String(timestamp) : null,
        service: typeof parsed.service === 'string' ? parsed.service : serviceFromFile,
        level: typeof parsed.level === 'string' ? parsed.level : null,
        message: typeof message === 'string' ? message : JSON.stringify(message),
      }
    } catch {
      // Fall through to plain-line handling.
    }
  }

  return { timestamp: null, service: serviceFromFile, level: null, message: trimmed }
}

function logTimeValue(timestamp: string | null): number {
  if (timestamp === null) {
    return 0
  }
  const asNumber = Number(timestamp)
  if (Number.isFinite(asNumber) && timestamp.trim() !== '') {
    return asNumber
  }
  const parsed = Date.parse(timestamp)

  return Number.isNaN(parsed) ? 0 : parsed
}

/**
 * Merged, newest-first tail over the per-service supervisord log files
 * (`<service>.log` / `<service>.err`). Missing/unreadable directory degrades to
 * an empty result. Same algorithm as AdminLogsService.tail: per file, scan from
 * the newest line backwards keeping matches until `limit`, then merge and sort.
 */
export async function tailLogFiles(
  fileSystem: LogFileSystemLike,
  logsDirectory: string,
  query: CliLogsQuery,
): Promise<CliLogsResult> {
  const limit = query.limit

  let fileNames: string[]
  try {
    fileNames = await fileSystem.readdir(logsDirectory)
  } catch {
    return { entries: [], truncated: false }
  }

  const logFiles = fileNames.filter((name) => name.endsWith('.log') || name.endsWith('.err'))
  const serviceFilter = query.service?.toLowerCase()
  const levelFilter = query.level?.toLowerCase()

  let candidates: CliLogEntry[] = []
  let truncated = false

  for (const fileName of logFiles) {
    const serviceFromFile = fileName.replace(/\.(log|err)$/, '')
    if (serviceFilter !== undefined && serviceFromFile.toLowerCase() !== serviceFilter) {
      continue
    }

    let content: string
    try {
      content = await fileSystem.readFile(fileSystem.joinPath(logsDirectory, fileName))
    } catch {
      continue
    }

    const lines = content.split(/\r?\n/).filter((line) => line.trim() !== '')

    let keptFromThisFile = 0
    for (let index = lines.length - 1; index >= 0; index--) {
      const entry = parseLogLine(lines[index], serviceFromFile)
      if (levelFilter !== undefined && (entry.level?.toLowerCase() ?? '') !== levelFilter) {
        continue
      }
      if (serviceFilter !== undefined && (entry.service?.toLowerCase() ?? '') !== serviceFilter) {
        continue
      }
      if (keptFromThisFile >= limit) {
        truncated = true
        break
      }
      candidates.push(entry)
      keptFromThisFile++
    }
  }

  candidates.sort((a, b) => logTimeValue(b.timestamp) - logTimeValue(a.timestamp))

  if (candidates.length > limit) {
    truncated = true
    candidates = candidates.slice(0, limit)
  }

  return { entries: candidates, truncated }
}

/* ------------------------------------------------------------------------- *
 * .env parsing + effective operator config
 * ------------------------------------------------------------------------- */

/**
 * Minimal dotenv-style parser for the entrypoint-generated per-package .env
 * files (plain KEY=VALUE lines; no expansion). Surrounding single/double
 * quotes are stripped; comment/blank lines are ignored.
 */
export function parseEnvFileContent(content: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const equalsAt = line.indexOf('=')
    if (equalsAt <= 0) {
      continue
    }
    const key = line.slice(0, equalsAt).trim()
    let value = line.slice(equalsAt + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }

  return result
}

export type OperatorService = 'auth' | 'api-gateway' | 'analytics'

export interface OperatorEnvSpec {
  /** Env name as the service reads it (post prefix-strip), e.g. WORKFLOWS_ENABLED. */
  env: string
  service: OperatorService
  /** How the service parses the raw string. */
  kind: 'boolean-strict' | 'boolean-loose' | 'string' | 'number'
  defaultValue: string | null
  description: string
  restartRequired: boolean
  redact?: boolean
  note?: string
}

/** Compose-level prefix the docker entrypoint strips into each package's .env. */
export const SERVICE_ENV_PREFIX: Record<OperatorService, string> = {
  auth: 'AUTH_SERVER_',
  'api-gateway': 'API_GATEWAY_',
  analytics: '',
}

/**
 * The known operator envs surfaced by `srn-admin config`, with the exact parse
 * semantics of the code that consumes them. All of these are read at BOOT: they
 * are read-only from the CLI and changing them means editing the operator .env
 * (compose level) and restarting the stack.
 */
export const OPERATOR_ENVS: OperatorEnvSpec[] = [
  {
    env: 'WORKFLOWS_ENABLED',
    service: 'api-gateway',
    kind: 'boolean-loose',
    defaultValue: 'false',
    description: 'Master switch: workflows (n8n) proxying at the gateway',
    restartRequired: true,
  },
  {
    env: 'OCR_SERVER_ENABLED',
    service: 'api-gateway',
    kind: 'boolean-loose',
    defaultValue: 'false',
    description: 'Master switch: server-side OCR endpoint',
    restartRequired: true,
  },
  {
    env: 'CALDAV_ENABLED',
    service: 'api-gateway',
    kind: 'boolean-loose',
    defaultValue: 'false',
    description: 'Master switch: CalDAV bridge',
    restartRequired: true,
  },
  {
    env: 'REMINDER_DELIVERY_ENABLED',
    service: 'api-gateway',
    kind: 'boolean-loose',
    defaultValue: 'false',
    description: 'Master switch: reminder delivery',
    restartRequired: true,
  },
  {
    env: 'UPDATE_CHECK_URL',
    service: 'api-gateway',
    kind: 'string',
    defaultValue: null,
    description: 'Self-hosted "check for updates" endpoint (unset = disabled)',
    restartRequired: true,
  },
  {
    env: 'NEXTCLOUD_BACKUPS_ENABLED',
    service: 'auth',
    kind: 'boolean-strict',
    defaultValue: 'false',
    description: 'Master switch: scheduled Nextcloud backups',
    restartRequired: true,
  },
  {
    env: 'DISABLE_USER_REGISTRATION',
    service: 'auth',
    kind: 'boolean-strict',
    defaultValue: 'false',
    description: 'Boot-time registration block (signup is refused when EITHER this or the persisted flag is on)',
    restartRequired: true,
    note: "persisted runtime flag: see 'srn-admin registration status'",
  },
  {
    env: 'STANDARD_RED_FEATURES_MODE',
    service: 'auth',
    kind: 'string',
    defaultValue: 'included',
    description: 'Feature entitlement mode (included | legacy)',
    restartRequired: true,
  },
  {
    env: 'STANDARD_RED_FULL_FEATURE_FILE_LIMIT_BYTES',
    service: 'auth',
    kind: 'number',
    defaultValue: '-1',
    description: 'Default per-user storage quota seeded at registration (-1 = unlimited)',
    restartRequired: true,
  },
  {
    env: 'SMTP_HOST',
    service: 'auth',
    kind: 'string',
    defaultValue: null,
    description: 'SMTP host (unset = outgoing email disabled)',
    restartRequired: true,
  },
  {
    env: 'SMTP_PORT',
    service: 'auth',
    kind: 'number',
    defaultValue: '587',
    description: 'SMTP port',
    restartRequired: true,
  },
  {
    env: 'SMTP_USER',
    service: 'auth',
    kind: 'string',
    defaultValue: null,
    description: 'SMTP username',
    restartRequired: true,
  },
  {
    env: 'SMTP_PASS',
    service: 'auth',
    kind: 'string',
    defaultValue: null,
    description: 'SMTP password',
    restartRequired: true,
    redact: true,
  },
  {
    env: 'SMTP_FROM',
    service: 'auth',
    kind: 'string',
    defaultValue: null,
    description: 'SMTP From address',
    restartRequired: true,
  },
  {
    env: 'ASSISTANT_ANTHROPIC_API_KEY',
    service: 'api-gateway',
    kind: 'string',
    defaultValue: null,
    description: 'Assistant provider: Anthropic API key',
    restartRequired: true,
    redact: true,
  },
  {
    env: 'ASSISTANT_OPENAI_API_KEY',
    service: 'api-gateway',
    kind: 'string',
    defaultValue: null,
    description: 'Assistant provider: OpenAI API key',
    restartRequired: true,
    redact: true,
  },
  {
    env: 'ASSISTANT_OLLAMA_URL',
    service: 'api-gateway',
    kind: 'string',
    defaultValue: null,
    description: 'Assistant provider: Ollama URL',
    restartRequired: true,
  },
  {
    env: 'ASSISTANT_DEFAULT_PROVIDER',
    service: 'api-gateway',
    kind: 'string',
    defaultValue: 'anthropic',
    description: 'Assistant default provider',
    restartRequired: true,
  },
  {
    env: 'ADMIN_EMAILS',
    service: 'analytics',
    kind: 'string',
    defaultValue: null,
    description: 'Analytics report recipients (NOTE: the analytics service is not part of this container)',
    restartRequired: true,
  },
]

export interface ResolvedOperatorEnv {
  env: string
  service: OperatorService
  /** Raw string the service sees (or null when unset everywhere). */
  raw: string | null
  /** Parsed effective value, e.g. 'on'/'off' for booleans, redacted for secrets. */
  effective: string
  source: 'operator env' | 'entrypoint default' | 'code default'
  restartRequired: boolean
  description: string
  note?: string
}

const LOOSE_TRUE = ['true', '1', 'yes', 'on']

/**
 * Resolve one operator env honestly:
 *   - raw value = the per-package .env file (what the running service actually
 *     loaded at boot), falling back to the code default;
 *   - source     = 'operator env' when the compose-level prefixed variable is
 *     present in the container environment, 'entrypoint default' when only the
 *     entrypoint-generated package .env carries it, else 'code default'.
 */
export function resolveOperatorEnv(
  spec: OperatorEnvSpec,
  processEnv: Record<string, string | undefined>,
  packageEnvFiles: Partial<Record<OperatorService, Record<string, string>>>,
): ResolvedOperatorEnv {
  const prefixed = `${SERVICE_ENV_PREFIX[spec.service]}${spec.env}`
  const fromProcess = processEnv[prefixed]
  const fromFile = packageEnvFiles[spec.service]?.[spec.env]

  let raw: string | null
  let source: ResolvedOperatorEnv['source']
  if (fromFile !== undefined && fromFile !== '') {
    raw = fromFile
    source = fromProcess !== undefined && fromProcess !== '' ? 'operator env' : 'entrypoint default'
  } else if (fromProcess !== undefined && fromProcess !== '') {
    // Env present at compose level but the service's .env misses it (e.g. the
    // variable was added after the container last started).
    raw = fromProcess
    source = 'operator env'
  } else {
    raw = spec.defaultValue
    source = 'code default'
  }

  let effective: string
  if (raw === null) {
    effective = '(unset)'
  } else if (spec.redact) {
    effective = '(set)'
  } else if (spec.kind === 'boolean-strict') {
    effective = raw === 'true' ? 'on' : 'off'
  } else if (spec.kind === 'boolean-loose') {
    effective = LOOSE_TRUE.includes(raw.toLowerCase()) ? 'on' : 'off'
  } else {
    effective = raw
  }

  return {
    env: spec.env,
    service: spec.service,
    raw: spec.redact && raw !== null ? '(redacted)' : raw,
    effective,
    source,
    restartRequired: spec.restartRequired,
    description: spec.description,
    note: spec.note,
  }
}

/* ------------------------------------------------------------------------- *
 * Service health probing targets
 * ------------------------------------------------------------------------- */

export interface ServiceProbeTarget {
  name: string
  port: number
}

/**
 * The supervisord sibling services and their internal healthcheck ports (see
 * docker/docker-entrypoint.sh). Each package's entrypoint-generated .env
 * carries the authoritative PORT; the defaults match the entrypoint's.
 */
export function serviceProbeTargets(
  packageEnvFiles: Partial<Record<string, Record<string, string>>>,
): ServiceProbeTarget[] {
  const portOf = (packageName: string, fallback: number): number => {
    const raw = packageEnvFiles[packageName]?.PORT
    const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN

    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
  }

  return [
    { name: 'api-gateway', port: portOf('api-gateway', 3000) },
    { name: 'syncing-server', port: portOf('syncing-server', 3101) },
    { name: 'auth', port: portOf('auth', 3103) },
    { name: 'files', port: portOf('files', 3104) },
    { name: 'revisions', port: portOf('revisions', 3105) },
  ]
}

/* ------------------------------------------------------------------------- *
 * RBAC group matching (moved verbatim from bin/srn_admin.ts so it is testable
 * without the bin's boot side effects)
 * ------------------------------------------------------------------------- */

/** Minimal shape of a group as returned by Auth_ListGroups. */
export type GroupLike = { id?: { toString(): string }; props?: { name?: string } }

/**
 * Pure matcher: given the full group list and an identifier (a group uuid or a
 * group name), return the matching group's uuid. A uuid match is preferred
 * (only when the identifier is a valid uuid); otherwise an exact NAME match is
 * used — case-sensitive first, falling back to a UNIQUE case-insensitive
 * match. Ambiguous names and no-match both throw a helpful error.
 */
export function matchGroupUuidInList(groups: GroupLike[], identifier: string, identifierIsUuid: boolean): string {
  const entries = groups.map((group) => ({
    uuid: group.id?.toString() ?? '',
    name: group.props?.name ?? '',
  }))

  if (identifierIsUuid) {
    const byUuid = entries.find((entry) => entry.uuid === identifier)
    if (byUuid) {
      return byUuid.uuid
    }
  }

  const caseSensitive = entries.filter((entry) => entry.name === identifier)
  const matches =
    caseSensitive.length > 0
      ? caseSensitive
      : entries.filter((entry) => entry.name.toLowerCase() === identifier.toLowerCase())

  if (matches.length === 1) {
    return matches[0].uuid
  }
  if (matches.length > 1) {
    throw new Error(
      `"${identifier}" is ambiguous — it matches ${matches.length} groups: ${matches
        .map((entry) => entry.uuid)
        .join(', ')}. Pass the group uuid instead.`,
    )
  }
  throw new Error(`no group found for "${identifier}"`)
}

/* ------------------------------------------------------------------------- *
 * Date parsing for filters
 * ------------------------------------------------------------------------- */

/**
 * Parse a --created-after/--created-before style argument: epoch milliseconds
 * or anything Date.parse accepts (ISO-8601 recommended). Returns epoch ms.
 */
export function parseDateFilter(input: string): number | undefined {
  const trimmed = input.trim()
  if (/^\d{12,}$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10)
  }
  const parsed = Date.parse(trimmed)

  return Number.isNaN(parsed) ? undefined : parsed
}

/* ------------------------------------------------------------------------- *
 * Help text
 * ------------------------------------------------------------------------- */

export const ADMIN_ROLE_NAME = 'ADMIN_USER'

export function usage(): string {
  return `srn-admin — in-container server administration for Standard Red Notes

USAGE
  srn-admin <command> [args] [--json]
  srn-admin help [command]

  A <user> may be an email address or a user uuid.
  A <group> may be a group name or a group uuid.

USERS
  users list [filters]               Paginated, filtered user table
  user <user>                        Rich whois: roles, ban, MFA, storage, flags
                                     (aliases: whois, list-roles)
  ban <user> [--reason TEXT] [--type permanent|temporary|shadow]
             [--until ISO | --duration MINUTES]
                                     Ban a user (permanent by default; a
                                     temporary ban needs --until/--duration; a
                                     shadow ban lets them connect but degrades sync)
  unban <user>                       Lift a ban
  reset-mfa <user>                   Clear a user's 2FA (and recovery codes)
  fix-quota <user>                   Recalculate a user's storage quota

ROLES & GROUPS
  roles list                         List every known role name
  roles grant <user> <ROLE>          Grant a role   (alias: grant-admin <user>)
  roles revoke <user> <ROLE>         Revoke a role  (alias: revoke-admin <user>)
  group list                         List all RBAC groups
  group create <name> [roles]        Create a group ([roles] = comma-separated)
  group delete <group>               Delete a group
  group set-roles <group> <r,r>      Replace a group's conferred roles
  group members <group>              List a group's members
  group add-user <group> <user>      Add a user to a group
  group remove-user <group> <user>   Remove a user from a group

FLAGS
  flags list                         Admin-manageable per-user settings
  flags get <user> [SETTING]         Read one flag (or all of them)
  flags set <user> <SETTING> <value> Write a flag (validated)
  flags unset <user> <SETTING>       Clear a flag back to its default
  storage-limit get <user>           Show storage used / limit
  storage-limit set <user> <bytes|unlimited>

SERVER
  registration status                Registration gate: env vs persisted flag
  registration enable|disable        Toggle the PERSISTED runtime flag
  registration policy [show]         Show the effective signup policy
  registration policy default-role   Set default role for new users
  registration policy domain-mode    Set email-domain mode (off|allow|block)
  registration policy domains        Set the email-domain allow/block list
  webhooks list [user]               Global webhooks (+ a user's, if given)
  webhooks create <url> <ev,ev> [--user <user>]
                                     Register a webhook (global unless --user)
  webhooks delete <webhook-uuid>     Delete any webhook
  config                             Effective operator config + source + restart info

DIAGNOSTICS
  status                             Health snapshot of every sibling service
  logs [--service X] [--level Y] [--tail N]
                                     Tail the container's per-service log files
  audit [--limit N] [--user X] [--action A] [--from ISO] [--to ISO]
                                     Query the admin/security audit log

'help <command>' prints details and every flag. 'users', 'roles', 'flags',
'webhooks' and 'registration' also accept 'help' as a subcommand.
`
}

const COMMAND_HELP: Record<string, string> = {
  'users list': `users list — paginated + filtered user table

USAGE
  srn-admin users list [--limit N] [--offset N] [--sort createdAt|email|updatedAt]
                       [--email CONTAINS] [--role ROLE] [--banned true|false]
                       [--subscription active|inactive|none]
                       [--created-after DATE] [--created-before DATE] [--json]

  DATE is ISO-8601 (e.g. 2026-01-31) or epoch milliseconds.
  Default: 100 rows, newest first. Columns: email, uuid, created, roles,
  banned, MFA, storage used/limit.`,
  user: `user <user> — rich whois (absorbs the old 'whois' and 'list-roles')

Shows uuid/email/created, direct + group-conferred + effective roles,
effective permissions, ban status, MFA on/off, storage used/limit and the
admin-manageable feature flags. --json for machine-readable output.`,
  ban: `ban <user> [--reason TEXT] [--type permanent|temporary|shadow]
          [--until ISO-DATE | --duration MINUTES]

Bans a user. --type selects the KIND (default 'permanent'):
  - permanent: blocks sign-in and rejects existing sessions (the historical
    behavior), now carrying the optional --reason.
  - temporary: same hard block, but ONLY until the deadline. Provide EITHER
    --until <ISO-8601 date> OR --duration <minutes from now>. Once expired the
    user is treated as not banned automatically.
  - shadow: the user CAN still sign in and connect, but their service is
    SILENTLY degraded (reduced sync page size + content-transfer allowance and
    disabled real-time push in the syncing-server). They are never told.
Permanent/temporary take effect on the next authenticated request; a shadow ban
takes effect once the session token refreshes. 'unban <user>' lifts any ban.`,
  'roles grant': `roles grant|revoke <user> <ROLE>

ROLE is validated against the known role names (see 'roles list').
'grant-admin <user>' / 'revoke-admin <user>' remain as aliases for the
${ADMIN_ROLE_NAME} role.`,
  flags: `flags — admin-manageable per-user settings

USAGE
  srn-admin flags list
  srn-admin flags get <user> [SETTING] [--json]
  srn-admin flags set <user> <SETTING> <value>
  srn-admin flags unset <user> <SETTING>

Only the allow-listed settings can be read/written (mirrors the admin panel's
ADMIN_MANAGEABLE_SETTINGS; sensitive settings are refused). Values are
validated per setting. FILE_UPLOAD_BYTES_LIMIT is routed to the dedicated
'storage-limit set' subscription-setting path automatically.`,
  'storage-limit': `storage-limit — per-user server storage limit

USAGE
  srn-admin storage-limit get <user>
  srn-admin storage-limit set <user> <bytes|unlimited>

The limit is a SUBSCRIPTION setting (integer bytes; -1/'unlimited' disables
the space check). New upload valet tokens honor the new limit immediately;
tokens issued earlier keep the old embedded limit until they expire.`,
  registration: `registration — instance-wide signup gate + policy

USAGE
  srn-admin registration status|enable|disable
  srn-admin registration policy [show] [--json]
  srn-admin registration policy default-role <CORE_USER|PRO_USER|VAULTS_USER|clear>
  srn-admin registration policy domain-mode <off|allowlist|blocklist>
  srn-admin registration policy domains <comma-separated-domains|clear>

Two independent switches gate signups; registration is blocked when EITHER
is on:
  - env DISABLE_USER_REGISTRATION: read at BOOT, read-only here (edit the
    operator .env and restart to change it);
  - the PERSISTED runtime flag (a REGISTRATION_DISABLED setting): what
    enable/disable toggles, effective immediately without a restart.
'status' reports both honestly. 'disable' writes the flag onto an admin
user's record (pass --as <user> to choose which); 'enable' clears EVERY
'true' row so no stale record keeps signups blocked.

'policy' shows/sets the effective signup policy (default role for new users +
email-domain allow/block policy). It reads the SAME persisted overlay the
admin panel writes (SERVER_SETTINGS_PATH) layered over the REGISTRATION_* env
baseline. A listed domain also matches its subdomains (example.com matches
mail.example.com); matching is case-insensitive. New signups are NEVER given
the admin role. Setting the policy requires SERVER_SETTINGS_PATH configured.`,
  webhooks: `webhooks — outbound webhook management

USAGE
  srn-admin webhooks list [user] [--json]
  srn-admin webhooks create <url> <event,event> [--user <user>]
  srn-admin webhooks delete <webhook-uuid>

Without --user, 'create' registers a GLOBAL (admin) webhook that fires for
events across all users. The HMAC signing secret is printed ONCE at creation.
Events: item.created item.updated item.deleted user.login session.revoked
admin.action. Target URLs must be public http(s) (SSRF guard).`,
  audit: `audit — query the admin/security audit log

USAGE
  srn-admin audit [--limit N] [--offset N] [--user ACTOR] [--action A]
                  [--from ISO] [--to ISO] [--json]

--user filters by the ACTING user (email or uuid). Newest first.`,
  status: `status — in-container health snapshot (no DI boot, fast)

Probes each supervisord sibling's localhost /healthcheck/readiness endpoint
(api-gateway :3000, syncing-server :3101, auth :3103, files :3104,
revisions :3105 — ports read from the entrypoint-generated package .env
files) plus raw TCP reachability of the DB and Redis. Worker processes have
no health port and are not probed — check 'logs --service <name>-worker'.`,
  logs: `logs — tail the container's per-service log files (no DI boot, fast)

USAGE
  srn-admin logs [--service X] [--level Y] [--tail N] [--json]

Reads SERVER_LOGS_PATH (default /var/lib/server/logs)/*.log|*.err — the same
files the admin panel's Logs tab shows. Printed oldest-first. Default tail:
100 lines.`,
  config: `config — effective operator configuration with source attribution

For each known operator env prints the effective value, where it came from
(operator env at compose level / entrypoint default / code default) and
whether changing it needs a restart. HONESTY: every env here is read at BOOT
and is read-only from this CLI — change it in the operator .env (the
compose-level file) and restart the stack. The only runtime-settable server
flag is the persisted registration gate ('registration enable|disable');
its persisted state needs a DB read, so it is shown by 'registration status'
rather than here.`,
  group: `group — RBAC group management

USAGE
  srn-admin group list
  srn-admin group create <name> [role,role]
  srn-admin group delete <group>
  srn-admin group set-roles <group> <role,role>
  srn-admin group members <group>
  srn-admin group add-user <group> <user>
  srn-admin group remove-user <group> <user>`,
}

/** Per-command help lookup; falls back to the global usage. */
export function helpFor(topic: string | undefined, subTopic?: string): string {
  if (topic === undefined) {
    return usage()
  }
  const alias: Record<string, string> = {
    whois: 'user',
    'list-roles': 'user',
    unban: 'ban',
    'grant-admin': 'roles grant',
    'revoke-admin': 'roles grant',
    roles: 'roles grant',
    users: 'users list',
  }
  const keys = [
    subTopic !== undefined ? `${topic} ${subTopic}` : undefined,
    topic,
    alias[subTopic !== undefined ? `${topic} ${subTopic}` : topic],
    alias[topic],
  ].filter((key): key is string => key !== undefined)

  for (const key of keys) {
    if (COMMAND_HELP[key] !== undefined) {
      return COMMAND_HELP[key] + '\n'
    }
  }

  return usage()
}
