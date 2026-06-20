/**
 * Standard Red Notes: web-local persistence for the "Manual sync" toggle.
 *
 * When ON, the sync engine suppresses AUTOMATIC syncs (item-change-triggered, the
 * periodic interval, network-return, backoff retries, and websocket-notification
 * pulls/pushes). Changes are still persisted locally; they only reach the server when
 * the user explicitly triggers a sync ("Sync now" / command). When OFF (the default),
 * syncing is fully automatic.
 *
 * This is intentionally NOT a synced preference. The app's synced/local PrefKeys live in
 * @standardnotes/snjs, which we keep changes minimal in. So we persist the toggle directly
 * in localStorage, mirroring the StripImageMetadata / autoMove / conflict-AI local-pref
 * precedent already in the web client. The snjs SyncService holds the runtime flag (set via
 * application.sync.setManualSyncMode); this module is only the persistence + UI source of truth.
 *
 * Default is OFF: with no stored value, automatic syncing is on (safe default — nothing is
 * at risk of being stranded on-device).
 */
const STORAGE_KEY = 'sn_manual_sync_mode'
const CHANGE_EVENT = 'sn-manual-sync-mode-changed'

export const getManualSyncModeEnabled = (): boolean => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    // Default OFF: only an explicit 'true' enables manual mode.
    return raw === 'true'
  } catch {
    // localStorage unavailable (e.g. private mode) -> fail to the default (off/automatic).
    return false
  }
}

export const setManualSyncModeEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // No-op; the toggle simply won't persist across reloads.
  }
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    // Ignore (non-DOM environments).
  }
}

/**
 * Subscribe to changes to the toggle (same-tab via CustomEvent, cross-tab via the storage
 * event). Returns an unsubscribe function.
 */
export const subscribeManualSyncMode = (callback: () => void): (() => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      callback()
    }
  }
  window.addEventListener(CHANGE_EVENT, callback)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(CHANGE_EVENT, callback)
    window.removeEventListener('storage', onStorage)
  }
}
