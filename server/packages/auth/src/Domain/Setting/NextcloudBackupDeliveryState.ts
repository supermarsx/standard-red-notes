import { Uuid } from '@standardnotes/domain-core'

export type NextcloudBackupOutcome = 'succeeded' | 'failed'

export interface ActiveNextcloudBackupRequest {
  requestUuid: string
  requestedAt: number
}

export interface CompletedNextcloudBackupRequest {
  requestUuid: string
  outcome: NextcloudBackupOutcome
  completedAt: number
}

export interface NextcloudBackupDeliveryState {
  activeRequest: ActiveNextcloudBackupRequest | null
  consecutiveFailures: number
  retryNotBefore: number | null
  completed: CompletedNextcloudBackupRequest[]
}

export const NEXTCLOUD_BACKUP_IN_FLIGHT_TIMEOUT_MS = 30 * 60 * 1_000
export const NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS = 15 * 60 * 1_000
export const NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1_000
export const NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY = 32
export const NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES = 32
export const NEXTCLOUD_BACKUP_MAX_STATE_BYTES = 64 * 1_024

const MAX_JAVASCRIPT_TIMESTAMP_MS = 8_640_000_000_000_000

export function emptyNextcloudBackupDeliveryState(): NextcloudBackupDeliveryState {
  return {
    activeRequest: null,
    consecutiveFailures: 0,
    retryNotBefore: null,
    completed: [],
  }
}

export function parseNextcloudBackupDeliveryState(value: string): NextcloudBackupDeliveryState | null {
  if (Buffer.byteLength(value, 'utf8') > NEXTCLOUD_BACKUP_MAX_STATE_BYTES) {
    return null
  }

  try {
    const parsed = JSON.parse(value) as Partial<NextcloudBackupDeliveryState> | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null
    }
    if (
      !Object.prototype.hasOwnProperty.call(parsed, 'activeRequest') ||
      (parsed.activeRequest !== null && !isActiveRequest(parsed.activeRequest))
    ) {
      return null
    }
    if (
      !Object.prototype.hasOwnProperty.call(parsed, 'consecutiveFailures') ||
      !isFailureCount(parsed.consecutiveFailures)
    ) {
      return null
    }
    if (
      !Object.prototype.hasOwnProperty.call(parsed, 'retryNotBefore') ||
      (parsed.retryNotBefore !== null && !isTimestamp(parsed.retryNotBefore))
    ) {
      return null
    }
    if (!Object.prototype.hasOwnProperty.call(parsed, 'completed') || !Array.isArray(parsed.completed)) {
      return null
    }
    if (!parsed.completed.every(isCompletedRequest)) {
      return null
    }

    const activeRequest = isActiveRequest(parsed.activeRequest) ? parsed.activeRequest : null
    const consecutiveFailures = parsed.consecutiveFailures
    const retryNotBefore = isTimestamp(parsed.retryNotBefore) ? parsed.retryNotBefore : null
    const completed = deduplicateCompletedRequests(parsed.completed).slice(-NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY)

    return {
      activeRequest,
      consecutiveFailures,
      retryNotBefore,
      completed,
    }
  } catch {
    return null
  }
}

export function appendNextcloudBackupCompletion(
  state: NextcloudBackupDeliveryState,
  completion: CompletedNextcloudBackupRequest,
): CompletedNextcloudBackupRequest[] {
  return [...state.completed.filter((entry) => entry.requestUuid !== completion.requestUuid), completion].slice(
    -NEXTCLOUD_BACKUP_MAX_COMPLETED_HISTORY,
  )
}

export function nextNextcloudBackupRetryDelayMs(consecutiveFailures: number): number {
  const safeFailures = Math.min(
    Math.max(Number.isSafeInteger(consecutiveFailures) ? consecutiveFailures : 1, 1),
    NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES,
  )
  const exponent = Math.min(safeFailures - 1, 16)

  return Math.min(NEXTCLOUD_BACKUP_INITIAL_RETRY_DELAY_MS * 2 ** exponent, NEXTCLOUD_BACKUP_MAX_RETRY_DELAY_MS)
}

export function nextFailureCount(current: number): number {
  const safeCurrent = Number.isSafeInteger(current)
    ? Math.min(Math.max(current, 0), NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES)
    : 0

  return Math.min(safeCurrent + 1, NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES)
}

export function isValidNextcloudBackupTimestamp(value: unknown): value is number {
  return isTimestamp(value)
}

function isActiveRequest(value: unknown): value is ActiveNextcloudBackupRequest {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<ActiveNextcloudBackupRequest>

  return isUuid(candidate.requestUuid) && isTimestamp(candidate.requestedAt)
}

function isCompletedRequest(value: unknown): value is CompletedNextcloudBackupRequest {
  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as Partial<CompletedNextcloudBackupRequest>

  return (
    isUuid(candidate.requestUuid) &&
    (candidate.outcome === 'succeeded' || candidate.outcome === 'failed') &&
    isTimestamp(candidate.completedAt)
  )
}

function isFailureCount(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= NEXTCLOUD_BACKUP_MAX_CONSECUTIVE_FAILURES
  )
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= MAX_JAVASCRIPT_TIMESTAMP_MS
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && !Uuid.create(value).isFailed()
}

function deduplicateCompletedRequests(completed: CompletedNextcloudBackupRequest[]): CompletedNextcloudBackupRequest[] {
  const byRequestUuid = new Map<string, CompletedNextcloudBackupRequest>()
  for (const entry of completed) {
    byRequestUuid.delete(entry.requestUuid)
    byRequestUuid.set(entry.requestUuid, entry)
  }

  return [...byRequestUuid.values()]
}
