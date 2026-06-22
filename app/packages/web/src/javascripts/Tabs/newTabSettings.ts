/**
 * Standard Red Notes: configurable behavior for the editor tab-bar "+" (New tab)
 * button. By default the "+" creates a brand new note (exactly the historical
 * behavior); users can instead opt to have it open an EMPTY tab (a placeholder
 * from which they can then create a note or pick one from the list).
 *
 * Like the editor tile-layout preference, this is a device-local UI choice that
 * does not need to sync, so it is persisted in localStorage rather than a synced
 * PrefKey. The storage helper mirrors `loadPersistedTileLayout` /
 * `persistTileLayout` in `NoteGroupView.tsx`.
 */
export type NewTabBehavior = 'new-note' | 'empty'

export const NEW_TAB_BEHAVIOR_STORAGE_KEY = 'srn_new_tab_behavior'

const VALID_NEW_TAB_BEHAVIORS = new Set<string>(['new-note', 'empty'])

export const DEFAULT_NEW_TAB_BEHAVIOR: NewTabBehavior = 'new-note'

export const loadNewTabBehavior = (): NewTabBehavior => {
  try {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(NEW_TAB_BEHAVIOR_STORAGE_KEY) : null
    if (stored && VALID_NEW_TAB_BEHAVIORS.has(stored)) {
      return stored as NewTabBehavior
    }
  } catch {
    /* storage may be unavailable (private mode, etc.) — fall back to the default */
  }
  return DEFAULT_NEW_TAB_BEHAVIOR
}

export const saveNewTabBehavior = (behavior: NewTabBehavior): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(NEW_TAB_BEHAVIOR_STORAGE_KEY, behavior)
    }
  } catch {
    /* ignore storage write failures */
  }
}
