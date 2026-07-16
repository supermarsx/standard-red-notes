import { ApplicationEvent, PrefKey, PrefDefaults, UpdateCheckIntervalValue } from '@standardnotes/snjs'
import { addToast, ToastType } from '@standardnotes/toast'
import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: self-hosted "Check for updates".
 *
 * The SERVER (api-gateway) performs the actual outbound check against the
 * operator-configured UPDATE_CHECK_URL and caches it; this client service only
 * calls the authenticated `/v1/updates/status` endpoint and schedules WHEN to
 * do so.
 *
 * Preferences: the auto-check toggle (PrefKey.UpdateCheckAutoEnabled) and the
 * schedule (PrefKey.UpdateCheckInterval) are SYNCED prefs — they express user
 * intent and should follow the user across devices. The LAST-CHECKED timestamp
 * is deliberately DEVICE-LOCAL (localStorage): each device checks
 * independently, so one device checking must not silence every other device
 * for the whole interval (a stale laptop opened a month later should check
 * immediately, not inherit the phone's fresh timestamp).
 *
 * Scheduling: on app launch (ApplicationEvent.Launched) the service checks if
 * the interval has elapsed since this device's last check ('every-load' always
 * checks; 'never' or the toggle off never checks). While the app stays open, a
 * cheap timer re-evaluates every 15 minutes so sub-day intervals fire without
 * a reload. Auto-check failures are silent (log-gated); the preferences pane
 * surfaces failures only after a manual check.
 */

const LAST_CHECKED_STORAGE_KEY = 'srn-update-check-last-checked-at'
const LAST_STATUS_STORAGE_KEY = 'srn-update-check-last-status'

/** How often the in-session timer re-evaluates whether a check is due. */
export const UPDATE_CHECK_TIMER_TICK_MS = 15 * 60 * 1000

/** Sentinel returned by {@link updateCheckIntervalToMs} for 'every-load'. */
export const UPDATE_CHECK_EVERY_LOAD_MS = 0
/** Sentinel returned by {@link updateCheckIntervalToMs} for 'never'. */
export const UPDATE_CHECK_NEVER_MS = Number.POSITIVE_INFINITY

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

/**
 * The dropdown options, in display order. 'Never' and the auto-check toggle
 * overlap deliberately: toggle off = no auto checks regardless of schedule;
 * schedule 'never' = the same effect. The pane keeps the UX coherent by
 * disabling this dropdown while the toggle is off.
 */
export const UPDATE_CHECK_INTERVAL_OPTIONS: { value: UpdateCheckIntervalValue; label: string }[] = [
  { value: 'every-load', label: 'Every load' },
  { value: 'every-hour', label: 'Every hour' },
  { value: 'every-6-hours', label: 'Every 6 hours' },
  { value: 'every-12-hours', label: 'Every 12 hours' },
  { value: 'every-day', label: 'Every day' },
  { value: 'every-3-days', label: 'Every 3 days' },
  { value: 'every-week', label: 'Every week' },
  { value: 'every-2-weeks', label: 'Every 2 weeks' },
  { value: 'every-month', label: 'Every month' },
  { value: 'every-3-months', label: 'Every 3 months' },
  { value: 'every-6-months', label: 'Every 6 months' },
  { value: 'every-year', label: 'Every year' },
  { value: 'never', label: 'Never' },
]

const INTERVAL_TO_MS: Record<UpdateCheckIntervalValue, number> = {
  'every-load': UPDATE_CHECK_EVERY_LOAD_MS,
  'every-hour': HOUR_MS,
  'every-6-hours': 6 * HOUR_MS,
  'every-12-hours': 12 * HOUR_MS,
  'every-day': DAY_MS,
  'every-3-days': 3 * DAY_MS,
  'every-week': 7 * DAY_MS,
  'every-2-weeks': 14 * DAY_MS,
  'every-month': 30 * DAY_MS,
  'every-3-months': 90 * DAY_MS,
  'every-6-months': 182 * DAY_MS,
  'every-year': 365 * DAY_MS,
  never: UPDATE_CHECK_NEVER_MS,
}

/**
 * PURE: interval option → milliseconds. 'every-load' maps to the
 * {@link UPDATE_CHECK_EVERY_LOAD_MS} (0) sentinel, 'never' to
 * {@link UPDATE_CHECK_NEVER_MS} (Infinity). Unknown values (e.g. a pref synced
 * from a newer client) fall back to the every-week default.
 */
export function updateCheckIntervalToMs(interval: UpdateCheckIntervalValue | string): number {
  return INTERVAL_TO_MS[interval as UpdateCheckIntervalValue] ?? INTERVAL_TO_MS['every-week']
}

/**
 * PURE: is an automatic check due? 'never' is never due; 'every-load' is
 * always due; otherwise a check is due when there is no valid device-local
 * last-checked timestamp yet, or the interval has elapsed since it.
 */
export function isCheckDue(
  lastCheckedAt: number | undefined | null,
  interval: UpdateCheckIntervalValue | string,
  now: number,
): boolean {
  const intervalMs = updateCheckIntervalToMs(interval)
  if (intervalMs === UPDATE_CHECK_NEVER_MS) {
    return false
  }
  if (intervalMs === UPDATE_CHECK_EVERY_LOAD_MS) {
    return true
  }
  if (typeof lastCheckedAt !== 'number' || !Number.isFinite(lastCheckedAt)) {
    return true
  }
  return now - lastCheckedAt >= intervalMs
}

/** Response shape of the gateway's GET /v1/updates/status. */
export type UpdateStatusResponse = {
  configured: boolean
  currentVersion: string
  latestVersion?: string
  updateAvailable?: boolean
  releaseUrl?: string
  checkedAt?: string
  error?: 'unreachable' | 'invalid-response'
}

/**
 * What the preferences pane renders: the last known server status plus the
 * DEVICE-LOCAL time this device last completed a check.
 */
export type UpdateCheckSnapshot = {
  checkedAt: number
  status: UpdateStatusResponse
}

/** Read this device's last completed check time (epoch ms), if any. */
export function readLastCheckedAt(): number | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  try {
    const raw = localStorage.getItem(LAST_CHECKED_STORAGE_KEY)
    if (raw === null) {
      return undefined
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function writeLastCheckedAt(timestamp: number): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(LAST_CHECKED_STORAGE_KEY, String(timestamp))
  } catch {
    /* best-effort; a full/blocked storage only degrades the display */
  }
}

/** Read the persisted last check result so the pane can render it on mount. */
export function readLastStatusSnapshot(): UpdateCheckSnapshot | undefined {
  if (typeof localStorage === 'undefined') {
    return undefined
  }
  try {
    const raw = localStorage.getItem(LAST_STATUS_STORAGE_KEY)
    if (raw === null) {
      return undefined
    }
    const parsed = JSON.parse(raw) as UpdateCheckSnapshot
    if (!parsed || typeof parsed.checkedAt !== 'number' || !parsed.status) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function writeLastStatusSnapshot(snapshot: UpdateCheckSnapshot): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(LAST_STATUS_STORAGE_KEY, JSON.stringify(snapshot))
  } catch {
    /* best-effort */
  }
}

/** The pane-facing result of a check attempt. */
export type UpdateCheckResult = { ok: true; snapshot: UpdateCheckSnapshot } | { ok: false; reason: 'network' }

export class UpdateCheckService {
  private disposer?: () => void
  private timer?: ReturnType<typeof setInterval>
  private hasToastedThisSession = false
  private checking = false

  constructor(private application: WebApplication) {
    this.disposer = this.application.addEventObserver(async (event) => {
      if (event === ApplicationEvent.Launched) {
        this.evaluateAutoCheck()
      }
    })

    // Light in-session timer so sub-day intervals fire without a reload. Each
    // tick is a couple of pref reads + a localStorage read — effectively free.
    this.timer = setInterval(() => this.evaluateAutoCheck(), UPDATE_CHECK_TIMER_TICK_MS)
  }

  deinit(): void {
    this.disposer?.()
    this.disposer = undefined
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    ;(this.application as unknown) = undefined
  }

  /** Run an automatic check if the toggle is on and the schedule says it's due. */
  evaluateAutoCheck(now = Date.now()): void {
    const autoEnabled = this.application.getPreference(
      PrefKey.UpdateCheckAutoEnabled,
      PrefDefaults[PrefKey.UpdateCheckAutoEnabled],
    )
    if (!autoEnabled) {
      return
    }

    const interval = this.application.getPreference(
      PrefKey.UpdateCheckInterval,
      PrefDefaults[PrefKey.UpdateCheckInterval],
    )
    if (!isCheckDue(readLastCheckedAt(), interval, now)) {
      return
    }

    void this.check({ force: false, auto: true })
  }

  /**
   * Perform one check against the gateway. Manual checks (`force: true`)
   * bypass the server's cache; automatic ones use it. Never throws — failures
   * come back as `{ ok: false }` (surfaced by the pane after a manual check,
   * silent/log-gated for automatic ones).
   */
  async check(options: { force: boolean; auto?: boolean }): Promise<UpdateCheckResult> {
    if (this.checking) {
      return { ok: false, reason: 'network' }
    }
    this.checking = true

    try {
      const path = options.force ? '/v1/updates/status?force=true' : '/v1/updates/status'
      const response = await this.application.assistantConfigRequest<UpdateStatusResponse>(path)

      if (!response || typeof response.configured !== 'boolean') {
        // 401 / proxy error bodies land here — treat as unreachable.
        throw new Error('malformed update status response')
      }

      const snapshot: UpdateCheckSnapshot = { checkedAt: Date.now(), status: response }
      writeLastCheckedAt(snapshot.checkedAt)
      writeLastStatusSnapshot(snapshot)

      if (response.updateAvailable && !this.hasToastedThisSession) {
        this.hasToastedThisSession = true
        this.showUpdateAvailableToast(response)
      }

      return { ok: true, snapshot }
    } catch (error) {
      if (options.auto) {
        // eslint-disable-next-line no-console
        console.debug('[UpdateCheck] Automatic update check failed', error)
      }
      return { ok: false, reason: 'network' }
    } finally {
      this.checking = false
    }
  }

  /** One non-spammy toast per session when an update is discovered. */
  private showUpdateAvailableToast(status: UpdateStatusResponse): void {
    const releaseUrl = status.releaseUrl
    addToast({
      type: ToastType.Regular,
      title: 'Update available',
      message: `Version ${status.latestVersion ?? 'unknown'} of your server's release channel is available.`,
      actions: releaseUrl
        ? [
            {
              label: 'View release',
              handler: () => {
                window.open(releaseUrl, '_blank', 'noopener noreferrer')
              },
            },
          ]
        : undefined,
      autoClose: false,
    })
  }
}
