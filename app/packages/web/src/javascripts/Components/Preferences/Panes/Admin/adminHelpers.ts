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

/** Compact log timestamp; passes through non-ISO strings, blank -> ''. */
export const formatLogTimestamp = (value: string | null | undefined): string => {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
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
