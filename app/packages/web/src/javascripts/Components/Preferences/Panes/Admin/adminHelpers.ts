/**
 * Standard Red Notes: pure, unit-tested helpers backing the Admin pane's new
 * users list, all-services status, and logs tab. Keeping the param-building,
 * formatting and colour logic here (rather than inline in the React components)
 * keeps them deterministic and testable.
 */

// The server clamps the users-list page size to this maximum.
export const ADMIN_USERS_MAX_LIMIT = 1500
export const ADMIN_USERS_DEFAULT_PAGE_SIZE = 100

// ---------------------------------------------------------------------------
// Users list — filter state -> API params
// ---------------------------------------------------------------------------

export type SubscriptionFilter = 'any' | 'active' | 'inactive' | 'none'
export type BannedFilter = 'any' | 'yes' | 'no'

export type AdminUsersFilterState = {
  // Free-text email search (debounced in the UI). Empty = no filter.
  email: string
  // yyyy-mm-dd values straight from <input type="date">, or '' for no bound.
  createdAfter: string
  createdBefore: string
  // Exact role name, or '' for any.
  role: string
  subscription: SubscriptionFilter
  banned: BannedFilter
}

export type AdminListUsersParams = {
  limit: number
  offset: number
  sort?: string
  email?: string
  createdAfter?: string
  createdBefore?: string
  role?: string
  banned?: boolean
  subscription?: string
}

export const emptyAdminUsersFilterState = (): AdminUsersFilterState => ({
  email: '',
  createdAfter: '',
  createdBefore: '',
  role: '',
  subscription: 'any',
  banned: 'any',
})

/** True when no filter is narrowing the list (used for empty-state copy). */
export const adminUsersFiltersAreEmpty = (filters: AdminUsersFilterState): boolean =>
  filters.email.trim() === '' &&
  filters.createdAfter === '' &&
  filters.createdBefore === '' &&
  filters.role === '' &&
  filters.subscription === 'any' &&
  filters.banned === 'any'

const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max)

/**
 * Convert a yyyy-mm-dd date-input value into an ISO instant. `end` picks the
 * inclusive end-of-day so a "before" bound covers the whole selected day.
 * Returns undefined for empty/invalid input so the param is simply omitted.
 */
export const dateBoundToISO = (value: string, end: boolean): string | undefined => {
  if (!value) {
    return undefined
  }
  const iso = end ? `${value}T23:59:59.999Z` : `${value}T00:00:00.000Z`
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

/**
 * Build the (already-serialisable) params object for `adminListUsers` from the
 * UI filter state + the requested page. Page size is clamped to the server cap
 * and the offset is derived from the (zero-based) page. Empty filters are
 * omitted so they never reach the query string.
 */
export const buildAdminListUsersParams = (
  filters: AdminUsersFilterState,
  page: number,
  pageSize: number,
): AdminListUsersParams => {
  const limit = clamp(Math.floor(pageSize) || ADMIN_USERS_DEFAULT_PAGE_SIZE, 1, ADMIN_USERS_MAX_LIMIT)
  const safePage = Math.max(0, Math.floor(page) || 0)
  const params: AdminListUsersParams = {
    limit,
    offset: safePage * limit,
    // Most-recent users first by default.
    sort: '-createdAt',
  }

  const email = filters.email.trim()
  if (email !== '') {
    params.email = email
  }
  const createdAfter = dateBoundToISO(filters.createdAfter, false)
  if (createdAfter) {
    params.createdAfter = createdAfter
  }
  const createdBefore = dateBoundToISO(filters.createdBefore, true)
  if (createdBefore) {
    params.createdBefore = createdBefore
  }
  if (filters.role !== '') {
    params.role = filters.role
  }
  if (filters.subscription !== 'any') {
    params.subscription = filters.subscription
  }
  if (filters.banned !== 'any') {
    params.banned = filters.banned === 'yes'
  }

  return params
}

// ---------------------------------------------------------------------------
// Users list — row formatting
// ---------------------------------------------------------------------------

export type AdminUserRow = {
  uuid: string
  email: string
  createdAt: string
  updatedAt: string
  roles: string[]
  subscription: { plan: string | null; active: boolean } | null
  banned: boolean
  // Standard Red Notes: the effective ban KIND for a banned row, or null. Older
  // servers omit it, so the row badge falls back to a generic "Banned".
  banType?: 'temporary' | 'permanent' | 'shadow' | null
  // Standard Red Notes: reversible administrative suspension (distinct from ban).
  // Older servers omit it, so it is optional and treated as not-suspended.
  suspended?: boolean
  mfaEnabled: boolean
  storageUsedBytes: number | null
  storageLimitBytes: number | null
}

/** Locale date-time for a row's created/updated timestamp; passes through unparseable input. */
export const formatAdminUserDate = (value: string | null | undefined): string => {
  if (!value) {
    return '—'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** Human summary of a user's subscription cell. */
export const formatAdminUserSubscription = (
  subscription: { plan: string | null; active: boolean } | null,
): string => {
  if (!subscription) {
    return 'None'
  }
  const plan = subscription.plan && subscription.plan.trim() !== '' ? subscription.plan : 'Unknown plan'
  return subscription.active ? `${plan} (active)` : `${plan} (inactive)`
}

/** Comma-joined role list, or a dash when the user has no roles. */
export const formatAdminUserRoles = (roles: string[] | null | undefined): string =>
  roles && roles.length > 0 ? roles.join(', ') : '—'

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * Compact binary byte formatter (self-contained so the helper stays pure and
 * unit-testable). -1 and null are handled by the callers below.
 */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '0 B'
  }
  let value = bytes
  let unitIndex = 0
  while (value >= 1024 && unitIndex < BYTE_UNITS.length - 1) {
    value /= 1024
    unitIndex += 1
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10
  return `${rounded} ${BYTE_UNITS[unitIndex]}`
}

/** "used / limit" label for the storage column. -1 or null limit = Unlimited. */
export const formatAdminUserStorage = (
  usedBytes: number | null | undefined,
  limitBytes: number | null | undefined,
): string => {
  const usedLabel = usedBytes == null ? 'Unknown' : formatBytes(usedBytes)
  const limitLabel = limitBytes == null || limitBytes === -1 ? 'Unlimited' : formatBytes(limitBytes)
  return `${usedLabel} / ${limitLabel}`
}

// ---------------------------------------------------------------------------
// Server tab — all-services status chips
// ---------------------------------------------------------------------------

export type ServiceStatus = 'ok' | 'degraded' | 'down' | 'unknown'

export type ServerService = {
  name: string
  reachable: boolean
  status: ServiceStatus
  detail?: string
  // Standard Red Notes (task #66): the service's readiness-probe response time in
  // ms. Present when a probe actually ran; omitted for the gateway itself and for
  // 'not configured' services.
  responseTimeMs?: number
}

// ---------------------------------------------------------------------------
// Server tab — per-service latency (task #66)
// ---------------------------------------------------------------------------

/** Above this many ms a healthy service's latency is shown in amber. */
export const SERVICE_LATENCY_WARN_MS = 500

/** Compact latency label ("42 ms", "1.3 s"), or '' when there is nothing to show. */
export const formatServiceLatency = (ms: number | null | undefined): string => {
  if (ms == null || !Number.isFinite(ms) || ms < 0) {
    return ''
  }
  if (ms < 1000) {
    return `${Math.round(ms)} ms`
  }
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
}

/**
 * Text-colour class for a latency label: red on a failed/down probe, amber when
 * a reachable service is slow (> SERVICE_LATENCY_WARN_MS), else muted.
 */
export const serviceLatencyClass = (ms: number | null | undefined, status: string | null | undefined): string => {
  if (status === 'down') {
    return 'text-danger'
  }
  if (ms != null && Number.isFinite(ms) && ms > SERVICE_LATENCY_WARN_MS) {
    return 'text-warning'
  }
  return 'text-passive-1'
}

/**
 * Tailwind classes for a service-status chip. Falls back to the neutral
 * "unknown" style for any unexpected status string the server might send.
 */
export const serviceStatusChipClass = (status: string | null | undefined): string => {
  switch (status) {
    case 'ok':
      return 'bg-success text-success-contrast'
    case 'degraded':
      return 'bg-warning text-warning-contrast'
    case 'down':
      return 'bg-danger text-danger-contrast'
    default:
      return 'bg-passive-4 text-foreground'
  }
}

/** Short label shown inside a service chip. */
export const serviceStatusLabel = (status: string | null | undefined): string => {
  switch (status) {
    case 'ok':
      return 'OK'
    case 'degraded':
      return 'Degraded'
    case 'down':
      return 'Down'
    default:
      return 'Unknown'
  }
}

// ---------------------------------------------------------------------------
// Server tab — service lifecycle controls (restart/stop/start)
// ---------------------------------------------------------------------------

export type ServiceControlAction = 'restart' | 'stop' | 'start'

/** The supervisord program whose restart interrupts the admin's own connection. */
export const SERVICE_CONTROL_SELF_PROGRAM = 'api-gateway'

/**
 * Standard Red Notes: the realtime WebSocket gateway runs IN-PROCESS inside the
 * api-gateway (attachWebSocketGateway) — it is NOT a separate process/container.
 * So "restart the WebSocket gateway" maps to restarting the api-gateway program
 * under the hood. This is the service-array row name for that in-process gateway.
 */
export const WS_GATEWAY_SERVICE = 'websocket-gateway'

/**
 * Map a service-array row name to the supervisord PROGRAM that controls it. Almost
 * always identity, except the in-process WebSocket gateway, which is controlled by
 * restarting the api-gateway process it runs inside.
 */
export const serviceControlProgramFor = (name: string): string =>
  name === WS_GATEWAY_SERVICE ? SERVICE_CONTROL_SELF_PROGRAM : name

/**
 * True when this action on this service will drop the admin's own connection.
 * Restarting the api-gateway OR the in-process WebSocket gateway (which restarts
 * the api-gateway) both interrupt this very connection.
 */
export const serviceActionIsSelfInterrupting = (name: string, action: ServiceControlAction): boolean =>
  serviceControlProgramFor(name) === SERVICE_CONTROL_SELF_PROGRAM && action === 'restart'

/** Past-tense verb for a success toast ("Restarted auth"). */
export const serviceActionPastTense = (action: ServiceControlAction): string => {
  switch (action) {
    case 'restart':
      return 'Restarted'
    case 'stop':
      return 'Stopped'
    case 'start':
      return 'Started'
  }
}

/**
 * Copy for the DANGER confirm dialog shown before a lifecycle action. Names the
 * service and warns about the interruption; the api-gateway restart gets the
 * strongest warning because it drops the admin's own connection.
 */
export const serviceActionDialogCopy = (
  name: string,
  action: ServiceControlAction,
): { title: string; text: string; confirmButtonText: string } => {
  // The in-process WebSocket gateway: make clear this restarts the api-gateway
  // process it runs inside (and therefore drops the admin's own connection).
  if (name === WS_GATEWAY_SERVICE && action === 'restart') {
    return {
      title: 'Restart the WebSocket gateway?',
      text: 'The realtime WebSocket gateway runs inside the API gateway process, so restarting it restarts the API gateway. Your admin connection will drop for a few seconds and realtime sync briefly reconnects. You may need to reload this page afterwards. Continue?',
      confirmButtonText: 'Restart gateway',
    }
  }
  if (serviceActionIsSelfInterrupting(name, action)) {
    return {
      title: 'Restart the API gateway?',
      text: `Restarting "${name}" will drop your admin connection for a few seconds while it comes back up. You may need to reload this page afterwards. Continue?`,
      confirmButtonText: 'Restart gateway',
    }
  }

  switch (action) {
    case 'restart':
      return {
        title: `Restart ${name}?`,
        text: `Restarting "${name}" will briefly interrupt anything it is serving (for example, restarting auth will briefly interrupt sign-ins). Continue?`,
        confirmButtonText: 'Restart',
      }
    case 'stop':
      return {
        title: `Stop ${name}?`,
        text: `Stopping "${name}" takes it OFFLINE until you start it again. Features it powers will fail while it is stopped. Continue?`,
        confirmButtonText: 'Stop',
      }
    case 'start':
      return {
        title: `Start ${name}?`,
        text: `Start the stopped "${name}" service so it can serve requests again?`,
        confirmButtonText: 'Start',
      }
  }
}

// ---------------------------------------------------------------------------
// Server tab — OPT-IN container restart (Redis cache + MariaDB via the
// docker-socket-proxy). Off by default; controls appear only when the /services
// `docker` block reports the capability enabled AND reachable.
// ---------------------------------------------------------------------------

/** The docker capability block returned alongside adminListServices. */
export type DockerControl = {
  enabled: boolean
  available: boolean
  containers: string[]
}

/** Friendly labels for the allowlisted infrastructure containers. */
const DOCKER_CONTAINER_LABELS: Record<string, string> = {
  cache: 'Redis cache',
  db: 'Database (MariaDB)',
}

/** Human label for an allowlisted container name, falling back to the raw name. */
export const dockerContainerLabel = (name: string): string => DOCKER_CONTAINER_LABELS[name] ?? name

/**
 * DANGER-confirm copy for restarting an infrastructure container. Restarting the
 * database or cache briefly interrupts every service that depends on it.
 */
export const dockerRestartDialogCopy = (name: string): { title: string; text: string; confirmButtonText: string } => {
  const label = dockerContainerLabel(name)
  return {
    title: `Restart ${label}?`,
    text: `Restarting the "${label}" container briefly takes it offline while it comes back up. Sign-ins, sync and anything that depends on it will fail for a few seconds. This restarts the whole container (not a single process). Continue?`,
    confirmButtonText: 'Restart',
  }
}

// ---------------------------------------------------------------------------
// Server settings (AI tab + Server tab rows) — types, source chips, payload
// validation. Mirrors the fixed /v1/admin/server-settings contract.
// ---------------------------------------------------------------------------

/** Where the currently-active value of a setting comes from. */
export type SettingSource = 'env' | 'persisted' | 'default'

/** A masked named assistant profile from the server view (no secret returned). */
export type AdminAiProfileView = {
  id: string
  name: string
  provider: 'anthropic' | 'openai-compatible' | 'ollama' | 'codex-subscription'
  baseUrl?: string | null
  model?: string | null
  models?: string[]
  enabled: boolean
  keyConfigured: boolean
}

/** A masked backend (provider/connection) profile from the server view. */
export type AdminBackendProfileView = {
  id: string
  name: string
  type: 'api-key' | 'subscription'
  provider?: 'anthropic' | 'openai-compatible' | 'ollama' | null
  baseUrl?: string | null
  model?: string | null
  models?: string[]
  subscriptionId?: string | null
  keyConfigured: boolean
}

/** Assistant-profile assignments from the server view (user/role -> profile id). */
export type AdminAssignmentsView = {
  users: Record<string, string>
  roles: Record<string, string>
}

export type AdminServerSettings = {
  ai?: {
    anthropicConfigured?: boolean
    openaiConfigured?: boolean
    openaiBaseUrl?: string | null
    ollamaUrl?: string | null
    dailyRequestLimit?: number | null
    fiveHourTokenLimit?: number | null
    weeklyTokenLimit?: number | null
    subscriptionMode?: string | null
    // Standard Red Notes: MULTIPLE named profiles + the default selector.
    profiles?: AdminAiProfileView[]
    defaultProfileId?: string | null
    // Standard Red Notes: decoupled backend profiles + user/role assignments.
    backendProfiles?: AdminBackendProfileView[]
    assignments?: AdminAssignmentsView
  }
  updateCheck?: {
    url?: string | null
  }
  nextcloudBackups?: {
    enabled?: boolean
  }
  // Standard Red Notes: REGISTRATION policy (default role for new users + email
  // domain allow/block policy). Persisted gateway-side; enforced auth-side.
  registration?: {
    defaultRole?: string
    domainMode?: 'off' | 'allowlist' | 'blocklist'
    domainList?: string[]
    /** Assignable (canonical non-admin) role choices for the selector. */
    assignableRoles?: string[]
    // Standard Red Notes: EMAIL CONFIRMATION (part 2). OFF by default.
    emailConfirmationEnabled?: boolean
    emailConfirmationGating?: 'block_signin' | 'warn'
    emailConfirmationSubject?: string
    emailConfirmationBody?: string
    emailConfirmationBaseUrl?: string
    /** Gating-mode choices for the selector. */
    gatingModes?: Array<'block_signin' | 'warn'>
  }
  // Standard Red Notes: OCR config (server-side E2E-downgrade endpoint + the
  // browser-OCR intent). serverEnabled/defaultLanguage/maxPages/maxImageBytes are
  // gateway-enforced at runtime; clientEnabled/clientDefaultLanguage are the
  // baked-window.* intent surfaced via GET /v1/ocr/config.
  ocr?: {
    serverEnabled?: boolean
    defaultLanguage?: string
    maxPages?: number
    maxImageBytes?: number
    clientEnabled?: boolean
    clientDefaultLanguage?: string
  }
  // Standard Red Notes: WORKFLOWS (n8n) config. enabled/n8nUrl/uiTokenTtlSeconds
  // are runtime; uiBasePath is the boot-bound editor-proxy mount (restart to
  // change).
  workflows?: {
    enabled?: boolean
    n8nUrl?: string
    uiBasePath?: string
    uiTokenTtlSeconds?: number
  }
  // Standard Red Notes: PLUGINS gallery repo base URL. The gateway proxies the
  // repo server-side so the browse-plugins gallery loads same-origin under the
  // strict CSP. The index is fetched at `<repoUrl>/packages.json`.
  plugins?: {
    repoUrl?: string
    // Standard Red Notes: opt-in to serving trusted-repo plugin components
    // SAME-ORIGIN so their iframes render under the strict CSP `frame-src 'self'`.
    sameOriginRendering?: boolean
  }
}

export type AdminServerSettingsResponse = {
  settings?: AdminServerSettings
  sources?: Record<string, string>
}

/** Human label for a source chip. Unknown strings fall back to "default". */
export const settingSourceLabel = (source: string | null | undefined): string => {
  switch (source) {
    case 'env':
      return 'From environment'
    case 'persisted':
      return 'Saved override'
    default:
      return 'Default'
  }
}

/**
 * Chip classes for a setting-source chip. A persisted override is highlighted
 * (it wins over env); env is informational; default is neutral.
 */
export const settingSourceChipClass = (source: string | null | undefined): string => {
  switch (source) {
    case 'env':
      return 'bg-contrast text-foreground'
    case 'persisted':
      return 'bg-info text-info-contrast'
    default:
      return 'bg-passive-4 text-foreground'
  }
}

/**
 * Look up a setting's source in the `sources` map, tolerating either flat
 * ("anthropicApiKey") or dotted ("ai.anthropicApiKey") key styles so a server
 * revision cannot silently break the chips. Missing = 'default'.
 */
export const settingSource = (
  sources: Record<string, string> | null | undefined,
  ...keys: string[]
): SettingSource => {
  if (sources) {
    for (const key of keys) {
      const value = sources[key]
      if (value === 'env' || value === 'persisted' || value === 'default') {
        return value
      }
    }
  }
  return 'default'
}

export type SettingUpdateResult<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Validate + normalise a URL field before it is sent as a server setting.
 * Empty input means "clear the persisted override" and maps to explicit null;
 * anything else must be an http(s) URL. Trailing whitespace is trimmed.
 */
export const buildUrlSettingUpdate = (input: string): SettingUpdateResult<string | null> => {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { ok: true, value: null }
  }
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    return { ok: false, error: 'Enter a full http(s):// URL, or leave empty to clear.' }
  }
  return { ok: true, value: trimmed }
}

/**
 * Validate + normalise an API-key field. Keys are write-only: an empty input
 * is NOT a clear here (the Clear button sends null explicitly) — it is a no-op
 * guard the caller checks before enabling Save.
 */
export const buildApiKeySettingUpdate = (input: string): SettingUpdateResult<string> => {
  const trimmed = input.trim()
  if (trimmed === '') {
    return { ok: false, error: 'Enter an API key first.' }
  }
  return { ok: true, value: trimmed }
}

/**
 * Validate + normalise the daily request limit input. Empty or 0 = unlimited,
 * sent as explicit null so any persisted cap is cleared. Otherwise a positive
 * integer.
 */
export const buildDailyLimitSettingUpdate = (input: string): SettingUpdateResult<number | null> => {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed === '0') {
    return { ok: true, value: null }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: 'Enter a whole number of requests per day, or 0 / empty for unlimited.' }
  }
  // Any spelling of zero ("00", "0.0") is unlimited too.
  return { ok: true, value: value === 0 ? null : value }
}

/**
 * Validate + normalise a rolling-window TOKEN limit input. Same rules as the
 * daily request limit: empty or 0 = unlimited (sent as null to clear any
 * persisted cap), otherwise a positive integer number of tokens.
 */
export const buildTokenLimitSettingUpdate = (input: string): SettingUpdateResult<number | null> => {
  const trimmed = input.trim()
  if (trimmed === '' || trimmed === '0') {
    return { ok: true, value: null }
  }
  const value = Number(trimmed)
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    return { ok: false, error: 'Enter a whole number of tokens, or 0 / empty for unlimited.' }
  }
  return { ok: true, value: value === 0 ? null : value }
}

// ---------------------------------------------------------------------------
// Logs tab — level colouring + client-side text filter
// ---------------------------------------------------------------------------

export type LogEntry = {
  timestamp: string | null
  service: string | null
  level: string | null
  message: string
}

/** Text colour class for a log line, keyed on its (case-insensitive) level. */
export const logLevelColorClass = (level: string | null | undefined): string => {
  switch ((level ?? '').toLowerCase()) {
    case 'error':
    case 'fatal':
    case 'crit':
    case 'critical':
      return 'text-danger'
    case 'warn':
    case 'warning':
      return 'text-warning'
    case 'debug':
    case 'trace':
    case 'verbose':
      return 'text-passive-1'
    default:
      // info / notice / log / unknown
      return 'text-foreground'
  }
}

/**
 * Full, aligned log timestamp in LOCAL time: `YYYY-MM-DD HH:MM:SS` (seconds
 * included) so the exact timeframe of a line is unambiguous. Every value is the
 * same fixed width, which keeps the monospaced log column aligned. Passes
 * through non-ISO strings unchanged; blank/null -> ''.
 */
export const formatLogTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  const pad = (n: number): string => n.toString().padStart(2, '0')
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return `${datePart} ${timePart}`
}

/**
 * Case-insensitive client-side filter over a log line's message (the service
 * and level are filtered server-side; this is the extra free-text box).
 */
export const logMatchesText = (entry: LogEntry, text: string): boolean => {
  const needle = text.trim().toLowerCase()
  if (needle === '') {
    return true
  }
  return (entry.message ?? '').toLowerCase().includes(needle)
}
