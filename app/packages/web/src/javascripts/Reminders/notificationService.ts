import { addToast, ToastType } from '@standardnotes/toast'

/**
 * Standard Red Notes: a tiny notification service used by reminders (and
 * available app-wide).
 *
 * It wraps the Web `Notification` API:
 *  - Permission is NEVER requested on load. `requestPermission` must be called
 *    from a user gesture (e.g. the user enabling a reminder), per browser
 *    policy and to keep the feature opt-in/unobtrusive.
 *  - `showNotification` shows an OS notification when permission is granted, and
 *    ALWAYS falls back to an in-app toast (so the user still sees it when
 *    permission is denied/unsupported, or the page is focused).
 *
 * The service is intentionally framework-agnostic and side-effect-light so it
 * can be reused outside of reminders.
 */

export type NotificationPermissionState = 'default' | 'granted' | 'denied' | 'unsupported'

export type ShowNotificationResult = {
  /** Whether an OS notification was shown. */
  osNotificationShown: boolean
  /** Whether the in-app toast fallback was shown. */
  toastShown: boolean
}

export type ShowNotificationOptions = {
  body?: string
  /** Tag used to coalesce/replace OS notifications (e.g. a reminder id). */
  tag?: string
  /** Toast type for the in-app fallback. Defaults to Regular. */
  toastType?: ToastType
  /** Toast actions for the in-app fallback (e.g. "Open note"). */
  toastActions?: { label: string; handler: (toastId: string) => void }[]
  /** Called when the OS notification itself is clicked. */
  onClick?: () => void
}

function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && typeof window.Notification === 'function'
}

export function getNotificationPermission(): NotificationPermissionState {
  if (!isNotificationSupported()) {
    return 'unsupported'
  }
  return window.Notification.permission as NotificationPermissionState
}

export function notificationsSupported(): boolean {
  return isNotificationSupported()
}

/**
 * Request OS notification permission. MUST be called from a user gesture. Safe
 * to call when unsupported (returns 'unsupported') or already granted/denied
 * (returns the current state without re-prompting beyond what the browser does).
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (!isNotificationSupported()) {
    return 'unsupported'
  }
  if (window.Notification.permission !== 'default') {
    return window.Notification.permission as NotificationPermissionState
  }
  try {
    const result = await window.Notification.requestPermission()
    return result as NotificationPermissionState
  } catch {
    // Some older browsers use a callback form / throw; treat as denied-ish.
    return getNotificationPermission()
  }
}

/**
 * Show a notification. Uses the OS Notification API when permitted, and always
 * also shows an in-app toast as a fallback / focused-page surface.
 */
export function showNotification(title: string, options: ShowNotificationOptions = {}): ShowNotificationResult {
  let osNotificationShown = false

  if (isNotificationSupported() && window.Notification.permission === 'granted') {
    try {
      const notification = new window.Notification(title, {
        body: options.body,
        tag: options.tag,
      })
      if (options.onClick) {
        notification.onclick = () => {
          window.focus()
          options.onClick?.()
          notification.close()
        }
      }
      osNotificationShown = true
    } catch {
      osNotificationShown = false
    }
  }

  // Always surface in-app too, so a focused user / denied-permission user still
  // sees the reminder.
  addToast({
    type: options.toastType ?? ToastType.Regular,
    title,
    message: options.body ?? '',
    actions: options.toastActions,
  })

  return { osNotificationShown, toastShown: true }
}
