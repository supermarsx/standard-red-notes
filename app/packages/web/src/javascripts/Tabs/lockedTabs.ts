import type { LocalPrefKey, LocalPrefValue, PreferenceServiceInterface } from '@standardnotes/snjs'

/**
 * Standard Red Notes: LOCKED editor tabs.
 *
 * Opening a note normally TAKES OVER the tab the user is looking at — that is
 * what makes the notes list feel like a list rather than a tab farm. Locking a
 * tab exempts it from that: the note in a locked tab stays put, and a newly
 * opened note has to land somewhere else.
 *
 * ## Where the locked state is stored, and why there
 * In the DEVICE-LOCAL preference store (`LocalPrefKey` /
 * `preferences.getLocalValue` / `setLocalValue`), not the synced per-account
 * `PrefKey` store. A lock is a statement about THIS window's layout — "do not
 * reuse this slot on this screen" — in exactly the sense that
 * `LocalPrefKey.AssistantPaneOpen` and the pane-collapse keys are, and the thing
 * it qualifies (the set of open tabs) is itself device-local: it is not synced,
 * so a synced lock would routinely name notes that are not open on the other
 * device, where it could only ever be inert. The rest of this tab system already
 * made the same call for the same reason (the tile layout, the "+" button
 * behavior, per-tab custom names). Local preferences are still encrypted and
 * still survive a full reload, which is the requirement.
 *
 * ## Why the key is a pinned string literal
 * Web consumes `LocalPrefKey`'s runtime value AND its type from the generated
 * `@standardnotes/snjs` bundle (`"types": "dist/@types"`), where a newly added
 * member is absent until that shared artifact is rebuilt. Writing
 * `LocalPrefKey.LockedEditorTabs` would therefore not even typecheck today, and
 * reading through a missing member would silently resolve `undefined` and make
 * the setting permanently unreadable. A string enum is its own string at
 * runtime, and `getLocalValue`/`setLocalValue` are plain record lookups keyed by
 * that string (`PreferencesService.localPreferences[key]`), so the literal below
 * behaves exactly as the enum member will. Replace it with
 * `LocalPrefKey.LockedEditorTabs` once the member exists in a rebuilt snjs.
 * Precedent: `TODO_FILTERS_PREF_KEY` in `Components/TodoAggregate/todoFilters.ts`.
 */
export const LOCKED_EDITOR_TABS_PREF_KEY = 'lockedEditorTabs' as unknown as LocalPrefKey

/**
 * Upper bound on how many uuids are kept. Locks are per-open-tab and tabs are
 * few, but a stored list must not be able to grow without limit across years of
 * locking and closing tabs, because nothing prunes entries for notes that are no
 * longer open (deliberately: closing and reopening a tab keeps its lock). The
 * OLDEST entries are dropped first.
 */
export const MAX_LOCKED_TAB_UUIDS = 200

/**
 * The slice of the preference service this module needs, with both members
 * OPTIONAL.
 *
 * Optional is not defensiveness for its own sake: the real service only
 * populates its local preferences at the `StorageDecrypted_09` launch stage, so
 * a read can legitimately precede the store existing, and several existing specs
 * construct `ItemGroupController` with `{} as PreferenceServiceInterface`. A
 * store that cannot be read means "no tab is locked", which is the pre-feature
 * behavior rather than a new failure mode.
 */
export type LockedTabsPreferences = Partial<Pick<PreferenceServiceInterface, 'getLocalValue' | 'setLocalValue'>>

/**
 * Coerces a persisted value into the uuid list. Runs against a device-local
 * preference that an older or newer build may have written, so anything that is
 * not an array of non-empty strings is discarded rather than trusted. Duplicates
 * are collapsed and the list is capped (see {@link MAX_LOCKED_TAB_UUIDS}).
 */
export const normalizeLockedTabUuids = (value: unknown): string[] => {
  if (!Array.isArray(value)) {
    return []
  }

  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const trimmed = entry.trim()
    if (trimmed.length > 0) {
      seen.add(trimmed)
    }
  }

  const uuids = [...seen]
  return uuids.length > MAX_LOCKED_TAB_UUIDS ? uuids.slice(uuids.length - MAX_LOCKED_TAB_UUIDS) : uuids
}

/** Reads the locked-tab uuids out of device-local preferences. */
export const readLockedTabUuids = (preferences: LockedTabsPreferences | undefined): Set<string> => {
  let stored: unknown
  try {
    stored = preferences?.getLocalValue?.(LOCKED_EDITOR_TABS_PREF_KEY, undefined)
  } catch {
    /* an unreadable store means nothing is locked */
    return new Set()
  }
  return new Set(normalizeLockedTabUuids(stored))
}

/** Persists the locked-tab uuids to device-local preferences. */
export const writeLockedTabUuids = (
  preferences: LockedTabsPreferences | undefined,
  uuids: Iterable<string>,
): string[] => {
  const normalized = normalizeLockedTabUuids([...uuids])
  try {
    preferences?.setLocalValue?.(LOCKED_EDITOR_TABS_PREF_KEY, normalized as LocalPrefValue[LocalPrefKey])
  } catch {
    /* ignore write failures — the in-memory decision below still holds for this session */
  }
  return normalized
}

/**
 * THE TAKEOVER RULE, as a pure function of the tab strip.
 *
 * Given each open tab's item uuid in left-to-right strip order, the index of the
 * active tab, and the locked set, returns the index of the tab a newly opened
 * item should REPLACE — or `undefined` when it must be given a tab of its own.
 *
 * In words:
 *  1. The active tab is the takeover target, exactly as before this feature.
 *  2. If the active tab is LOCKED, the nearest unlocked tab is used instead,
 *     searching rightwards from the active tab and wrapping around to the left.
 *     Nearest-unlocked rather than always-a-new-tab because once a single tab is
 *     locked, always-new would spawn a tab per click while clicking down the
 *     notes list — the lock would quietly become "stop reusing tabs at all".
 *  3. If EVERY open tab is locked, a new tab is created (`undefined`). The open
 *     is never refused: the user asked to see a note, and a lock is a statement
 *     about which slot may be reused, not permission to discard the request.
 *
 * A tab with no item uuid (a brand-new template note that has never been saved)
 * can never be locked, so it is always an eligible target.
 */
export const takeoverTabIndex = (
  tabUuids: readonly (string | undefined)[],
  activeIndex: number,
  lockedUuids: ReadonlySet<string>,
): number | undefined => {
  if (activeIndex < 0 || activeIndex >= tabUuids.length) {
    return undefined
  }

  const isLocked = (uuid: string | undefined): boolean => uuid !== undefined && lockedUuids.has(uuid)

  if (!isLocked(tabUuids[activeIndex])) {
    return activeIndex
  }

  for (let step = 1; step < tabUuids.length; step++) {
    const index = (activeIndex + step) % tabUuids.length
    if (!isLocked(tabUuids[index])) {
      return index
    }
  }

  return undefined
}
