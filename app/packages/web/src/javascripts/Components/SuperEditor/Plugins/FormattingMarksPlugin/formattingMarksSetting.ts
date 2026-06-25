/**
 * Standard Red Notes: web-local persistence + pub/sub for the "show formatting
 * marks" toggle (Word's ¶ button — renders pilcrows after blocks, line-break
 * arrows, and space middots purely on-screen).
 *
 * This is intentionally NOT a synced preference. The app's synced/local PrefKeys
 * live in @standardnotes/snjs (the models/services packages), which are off
 * limits for the web-only workstream. So we persist the toggle directly in
 * localStorage, mirroring the existing CheckListAutoMovePlugin/autoMoveSetting
 * pattern already used in this editor.
 *
 * IMPORTANT: this only flips a CSS class on the editor root element. It never
 * touches the Lexical editor state, so the saved note content is unaffected —
 * the marks exist solely as `::after`/`::before` pseudo-element decorations.
 *
 * Default is OFF: with no stored value the editor renders exactly as before.
 */
const STORAGE_KEY = 'sn_super_show_formatting_marks'
const CHANGE_EVENT = 'sn-super-formatting-marks-changed'

/** The class toggled on the editor root element when marks are shown. */
export const SHOW_FORMATTING_MARKS_CLASS = 'show-formatting-marks'

export const getFormattingMarksEnabled = (): boolean => {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true'
  } catch {
    // localStorage unavailable (e.g. private mode) -> fail to the default (off).
    return false
  }
}

export const setFormattingMarksEnabled = (enabled: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // No-op; the toggle simply won't persist across reloads.
  }
  // Notify same-tab listeners (the native `storage` event only fires in OTHER
  // tabs). React subscribers below listen to this to re-render live.
  try {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
  } catch {
    // Ignore (non-DOM environments).
  }
}

export const toggleFormattingMarksEnabled = (): boolean => {
  const next = !getFormattingMarksEnabled()
  setFormattingMarksEnabled(next)
  return next
}

/**
 * Subscribe to changes to the toggle (both same-tab via CustomEvent and
 * cross-tab via the storage event). Returns an unsubscribe function.
 */
export const subscribeFormattingMarks = (callback: () => void): (() => void) => {
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
