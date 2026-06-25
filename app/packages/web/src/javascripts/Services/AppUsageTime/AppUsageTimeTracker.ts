import { achievements, METRICS } from '@/Achievements'

/**
 * Standard Red Notes: ACTIVE app-usage time tracker (fire-and-forget).
 *
 * Accumulates minutes the app is actually in the foreground (only while
 * `document.visibilityState === 'visible'`) and, whenever the running total
 * crosses a whole hour, bumps the `appHoursSpent` achievement counter by the
 * number of whole hours, keeping the sub-hour remainder for next time.
 *
 * The accumulated minutes are persisted to localStorage so usage survives
 * reloads. All timer / localStorage / visibility access is guarded so this is
 * safe under SSR and in privacy modes where storage throws.
 */

const STORAGE_KEY = 'sn_app_active_minutes'
const TICK_MS = 60 * 1000 // 60s
const MINUTES_PER_HOUR = 60

function readMinutes(): number {
  if (typeof localStorage === 'undefined') {
    return 0
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) {
      return 0
    }
    const parsed = Number(raw)
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
  } catch {
    return 0
  }
}

function writeMinutes(minutes: number): void {
  if (typeof localStorage === 'undefined') {
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(minutes))
  } catch {
    /* storage may be unavailable (private mode); best-effort only */
  }
}

function isVisible(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'visible'
}

/**
 * Start accumulating active usage time. Returns a stop function that cancels the
 * timer; calling it more than once is safe. No-op (returns a no-op stopper) when
 * timers are unavailable (SSR).
 */
export function startAppUsageTimeTracking(): () => void {
  if (typeof window === 'undefined' || typeof window.setInterval !== 'function') {
    return () => {}
  }

  // Sub-hour remainder carried across reloads.
  let accumulatedMinutes = readMinutes() % MINUTES_PER_HOUR

  const tick = (): void => {
    if (!isVisible()) {
      return
    }

    accumulatedMinutes += 1

    if (accumulatedMinutes >= MINUTES_PER_HOUR) {
      const wholeHours = Math.floor(accumulatedMinutes / MINUTES_PER_HOUR)
      accumulatedMinutes -= wholeHours * MINUTES_PER_HOUR
      achievements.increment(METRICS.appHoursSpent, wholeHours)
    }

    writeMinutes(accumulatedMinutes)
  }

  const intervalId = window.setInterval(tick, TICK_MS)

  return () => {
    try {
      window.clearInterval(intervalId)
    } catch {
      /* nothing to clean up */
    }
  }
}
