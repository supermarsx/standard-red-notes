/**
 * Standard Red Notes: persisted feed of achievement-unlock notifications.
 *
 * The centralized NotificationsController derives its alert entries from live
 * app conditions, but an achievement unlock is a one-off *event* — so unlocks
 * are recorded here (web-local localStorage, mirroring the achievements module's
 * own persistence pattern: storage + a CustomEvent for same-tab subscribers and
 * the native `storage` event for other tabs). The controller merges these
 * records into its notification list; dismissing the notification removes the
 * record. Every storage access is guarded and nothing ever throws into a caller
 * — AchievementsService records unlocks fire-and-forget.
 */

export type AchievementNotificationRecord = {
  /** The unlocked achievement's catalog id (see achievementDefinitions.ts). */
  achievementId: string
  /** ISO timestamp of the unlock. */
  at: string
}

const STORAGE_KEY = 'standardnotes.notifications.achievements.v1'
const CHANGE_EVENT = 'sn-achievement-notifications-changed'

const isRecord = (value: unknown): value is AchievementNotificationRecord => {
  if (!value || typeof value !== 'object') {
    return false
  }
  const candidate = value as Partial<AchievementNotificationRecord>
  return typeof candidate.achievementId === 'string' && typeof candidate.at === 'string'
}

/** Oldest-first list of recorded unlock notifications. Never throws. */
export function listAchievementNotifications(): AchievementNotificationRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : null
    return Array.isArray(parsed) ? parsed.filter(isRecord) : []
  } catch {
    return []
  }
}

function persist(records: AchievementNotificationRecord[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(records))
  } catch {
    // Private mode / quota — the notification simply won't persist.
  }
}

function notifyChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    // Non-DOM environments.
  }
}

/** Record an unlock (deduped by achievement id). Fire-and-forget: never throws. */
export function recordAchievementNotification(achievementId: string): void {
  try {
    const records = listAchievementNotifications()
    if (records.some((record) => record.achievementId === achievementId)) {
      return
    }
    records.push({ achievementId, at: new Date().toISOString() })
    persist(records)
    notifyChanged()
  } catch {
    // Never throw into instrumentation callers.
  }
}

/** Remove a recorded unlock (the user dismissed its notification). Never throws. */
export function removeAchievementNotification(achievementId: string): void {
  try {
    const records = listAchievementNotifications()
    const remaining = records.filter((record) => record.achievementId !== achievementId)
    if (remaining.length === records.length) {
      return
    }
    persist(remaining)
    notifyChanged()
  } catch {
    // Ignore.
  }
}

/** Subscribe to feed changes (same-tab CustomEvent + cross-tab storage event). */
export function subscribeAchievementNotifications(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      callback()
    }
  }
  try {
    window.addEventListener(CHANGE_EVENT, callback)
    window.addEventListener('storage', onStorage)
  } catch {
    return () => {}
  }
  return () => {
    try {
      window.removeEventListener(CHANGE_EVENT, callback)
      window.removeEventListener('storage', onStorage)
    } catch {
      // Ignore.
    }
  }
}
