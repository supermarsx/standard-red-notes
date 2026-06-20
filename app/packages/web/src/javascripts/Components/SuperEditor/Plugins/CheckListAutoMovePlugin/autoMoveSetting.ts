/**
 * Standard Red Notes: web-local persistence for the "completed checklist tasks
 * move out of the way" behavior (GitHub forum issue 3928).
 *
 * This is intentionally NOT a synced preference. The app's synced/local PrefKeys
 * live in @standardnotes/snjs (the models/services packages), which are off
 * limits for the web-only workstream (changing them needs build:snjs). So we
 * persist the opt-in toggle directly in localStorage, mirroring the
 * trusted-device-token pattern already used in the web client.
 *
 * Default is OFF: with no stored value the editor behaves exactly as before, so
 * existing notes/users are unaffected until they explicitly opt in.
 */
const STORAGE_KEY = 'sn_super_checklist_auto_move_completed'
const CHANGE_EVENT = 'sn-super-checklist-auto-move-changed'

export const getChecklistAutoMoveEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // localStorage unavailable (e.g. private mode) -> fail to the default (off).
    return false
  }
}

export const setChecklistAutoMoveEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // No-op; the toggle simply won't persist across reloads.
  }
  // Notify same-tab listeners (the native `storage` event only fires in OTHER
  // tabs). React hooks below subscribe to this to re-render live.
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    // Ignore (non-DOM environments).
  }
}

/**
 * Subscribe to changes to the toggle (both same-tab via CustomEvent and
 * cross-tab via the storage event). Returns an unsubscribe function.
 */
export const subscribeChecklistAutoMove = (callback: () => void): (() => void) => {
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
