/**
 * Standard Red Notes: web-local (unsynced) settings for the centralized
 * notifications feature. Stored in localStorage under a versioned key, mirroring
 * the assistant/dictation/narration settings modules. Never throws.
 */

/** When a shown notification flips from unread to read. */
export type NotificationReadTrigger =
  /** Opening the notifications popover marks the listed alerts read. */
  | 'popup'
  /** Only opening the full Notifications tab marks alerts read. */
  | 'tab'
  /** Alerts are marked read after being visible for `readAfterSeconds`. */
  | 'time'

export interface NotificationsSettings {
  /** Master switch — when off, no notifications are surfaced at all. */
  enabled: boolean
  readTrigger: NotificationReadTrigger
  /** Seconds a notification must stay visible before the 'time' trigger marks it read. */
  readAfterSeconds: number
  /** Periodically toast the user when there are unread notifications. */
  reminderEnabled: boolean
  /** Minutes between reminder toasts. */
  reminderIntervalMinutes: number
  /** Per-source visibility toggles (the critical "sign in needed" alert ignores these). */
  sources: {
    /** "Data not backed up" (signed out). */
    backup: boolean
    /** "You're offline". */
    connectivity: boolean
    /** Sync problems / rate limiting. */
    sync: boolean
  }
}

export const READ_AFTER_SECONDS_MIN = 1
export const READ_AFTER_SECONDS_MAX = 120
export const REMINDER_INTERVAL_MIN = 1
export const REMINDER_INTERVAL_MAX = 24 * 60

export const DEFAULT_NOTIFICATIONS_SETTINGS: NotificationsSettings = {
  enabled: true,
  readTrigger: 'popup',
  readAfterSeconds: 5,
  reminderEnabled: true,
  reminderIntervalMinutes: 30,
  sources: {
    backup: true,
    connectivity: true,
    sync: true,
  },
}

const STORAGE_KEY = 'standardnotes.notifications.settings.v1'

const READ_TRIGGERS: NotificationReadTrigger[] = ['popup', 'tab', 'time']

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    return fallback
  }
  return Math.min(max, Math.max(min, Math.round(n)))
}

const asBool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback)

export function loadNotificationsSettings(): NotificationsSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return DEFAULT_NOTIFICATIONS_SETTINGS
    }
    const parsed = JSON.parse(raw) as Partial<NotificationsSettings>
    const sources = (parsed.sources ?? {}) as Partial<NotificationsSettings['sources']>
    return {
      enabled: asBool(parsed.enabled, DEFAULT_NOTIFICATIONS_SETTINGS.enabled),
      readTrigger: READ_TRIGGERS.includes(parsed.readTrigger as NotificationReadTrigger)
        ? (parsed.readTrigger as NotificationReadTrigger)
        : DEFAULT_NOTIFICATIONS_SETTINGS.readTrigger,
      readAfterSeconds: clampInt(
        parsed.readAfterSeconds,
        READ_AFTER_SECONDS_MIN,
        READ_AFTER_SECONDS_MAX,
        DEFAULT_NOTIFICATIONS_SETTINGS.readAfterSeconds,
      ),
      reminderEnabled: asBool(parsed.reminderEnabled, DEFAULT_NOTIFICATIONS_SETTINGS.reminderEnabled),
      reminderIntervalMinutes: clampInt(
        parsed.reminderIntervalMinutes,
        REMINDER_INTERVAL_MIN,
        REMINDER_INTERVAL_MAX,
        DEFAULT_NOTIFICATIONS_SETTINGS.reminderIntervalMinutes,
      ),
      sources: {
        backup: asBool(sources.backup, DEFAULT_NOTIFICATIONS_SETTINGS.sources.backup),
        connectivity: asBool(sources.connectivity, DEFAULT_NOTIFICATIONS_SETTINGS.sources.connectivity),
        sync: asBool(sources.sync, DEFAULT_NOTIFICATIONS_SETTINGS.sources.sync),
      },
    }
  } catch {
    return DEFAULT_NOTIFICATIONS_SETTINGS
  }
}

export function saveNotificationsSettings(settings: NotificationsSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* ignore quota / disabled storage */
  }
}
