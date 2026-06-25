/**
 * Standard Red Notes: per-tab custom names. A note/file tab's label can be
 * renamed to an arbitrary string without touching the underlying note title; an
 * empty custom name falls back to the note's title (or "Untitled").
 *
 * Custom names are keyed by the note/file `item.uuid` (the stable identifier)
 * rather than the controller `runtimeId`, which is randomly regenerated each
 * session and so cannot survive a reload. Like the editor tile-layout and
 * new-tab-behavior preferences, this is a device-local UI choice that does not
 * need to sync, so the whole map is persisted in localStorage. The storage
 * helpers mirror `loadPersistedTileLayout` / `persistTileLayout` in
 * `NoteGroupView.tsx` and `loadNewTabBehavior` / `saveNewTabBehavior` in
 * `newTabSettings.ts`.
 */
export const TAB_CUSTOM_NAMES_STORAGE_KEY = 'srn_tab_custom_names'

/** Map of `item.uuid` -> custom tab label. */
export type TabCustomNames = Record<string, string>

const isStringRecord = (value: unknown): value is TabCustomNames => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === 'string')
}

export const loadTabCustomNames = (): TabCustomNames => {
  try {
    const stored =
      typeof localStorage !== 'undefined' ? localStorage.getItem(TAB_CUSTOM_NAMES_STORAGE_KEY) : null
    if (!stored) {
      return {}
    }
    const parsed: unknown = JSON.parse(stored)
    if (isStringRecord(parsed)) {
      return parsed
    }
  } catch {
    /* storage may be unavailable or hold malformed data — fall back to empty */
  }
  return {}
}

export const saveTabCustomNames = (names: TabCustomNames): void => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(TAB_CUSTOM_NAMES_STORAGE_KEY, JSON.stringify(names))
    }
  } catch {
    /* ignore storage write failures */
  }
}

/**
 * Returns a NEW map with the custom name for `uuid` set. An empty/whitespace-only
 * name reverts the tab to its note-title fallback by REMOVING the entry, so the
 * stored map never grows unbounded with blank overrides.
 */
export const setTabCustomName = (names: TabCustomNames, uuid: string, name: string): TabCustomNames => {
  const trimmed = name.trim()
  const next = { ...names }
  if (trimmed.length === 0) {
    delete next[uuid]
  } else {
    next[uuid] = trimmed
  }
  return next
}

/**
 * Resolves the label to show for a tab: the custom name if one is set and
 * non-empty, otherwise the provided fallback (the note title / "Untitled").
 */
export const resolveTabLabel = (
  names: TabCustomNames,
  uuid: string | undefined,
  fallbackTitle: string,
): string => {
  if (uuid) {
    const custom = names[uuid]
    if (custom && custom.trim().length > 0) {
      return custom
    }
  }
  return fallbackTitle
}
