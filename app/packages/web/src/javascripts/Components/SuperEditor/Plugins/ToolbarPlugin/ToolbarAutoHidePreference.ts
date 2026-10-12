/**
 * Standard Red Notes — the ONE place that answers "should the docked Super
 * toolbar be collapsed to its row of tabs?".
 *
 * The setting is a synced boolean that defaults to OFF. The toolbar, the collapse
 * button on it and the Preferences switch all read it through this module, so they cannot end up on
 * different keys or disagree about what an unset value means.
 *
 *
 * WHY THE KEY IS A PINNED LITERAL AND NOT `PrefKey.SuperToolbarAutoHide`
 *
 * Same reason as `noteCoversPreference.ts` and `todoFilters.ts`, which document
 * it at length: web takes `PrefKey`'s RUNTIME value from the generated `snjs`
 * bundle, and a newly added member is `undefined` there until that shared
 * artifact has been rebuilt. `getPreference(undefined)` does not fail — it
 * returns the default forever, which looks exactly like "the switch does
 * nothing". A string enum member IS its own string at runtime, so the literal
 * below is exactly `PrefKey.SuperToolbarAutoHide` while depending on nothing
 * generated.
 *
 * The cast goes through `unknown` because the generated typings lag in the same
 * way. `ToolbarAutoHidePreference.spec.ts` reads the enum's SOURCE in
 * `@standardnotes/models` and fails if the two strings ever stop matching, and
 * `PrefDefaults.spec.ts` pins the same literal on the models side. Swap the
 * constant for the plain enum member once models and snjs have been rebuilt in
 * a normal build cycle.
 *
 *
 * WHY ONLY AN EXPLICIT `true` TURNS IT ON
 *
 * A default-OFF boolean is the treacherous case for the stale bundle: every
 * wrong answer (`undefined` from a missing default, a missing key, a value some
 * other client wrote) is falsy, so "off by default works" would pass with the
 * setting completely unwired. Comparing with `=== true` makes that the DESIGN
 * rather than an accident — off is the safe direction, since it is the toolbar
 * everyone already has — and it means the ON path is the only one that can
 * prove the wiring, which is what the specs and the browser run exercise.
 */
import type { PrefKey } from '@standardnotes/snjs'

/** The synced `UserPrefs` key, as the string that is actually written. */
export const SUPER_TOOLBAR_AUTO_HIDE_PREF_KEY = 'superToolbarAutoHide' as unknown as PrefKey

/** OFF. Mirrors `PrefDefaults[PrefKey.SuperToolbarAutoHide]`. */
export const DEFAULT_SUPER_TOOLBAR_AUTO_HIDE = false

/** Coerce a synced, untrusted value. Only an explicit `true` enables. */
export function normalizeSuperToolbarAutoHide(raw: unknown): boolean {
  return raw === true
}

/**
 * Whether auto-hide actually applies to a given toolbar right now.
 *
 * The setting alone is not enough. Auto-hide is a behaviour of the DOCKED
 * desktop ribbon only:
 *
 *  - on mobile the toolbar already shows only while the editor is focused;
 *  - the floating selection toolbar already shows only while text is selected;
 *  - a locked or read-only note shows no toolbar at all, so there is nothing
 *    of it to collapse.
 *
 * Kept as a pure function so the gating is tested over every combination of its
 * inputs instead of being inferred from a mounted 5000-line component.
 */
export function isSuperToolbarAutoHideActive(state: {
  /** The raw stored preference value. */
  storedPreference: unknown
  isMobile: boolean
  /** The ribbon is docked at the top of the note rather than floating. */
  isToolbarFixedToTop: boolean
  isEditable: boolean
}): boolean {
  return (
    normalizeSuperToolbarAutoHide(state.storedPreference) &&
    !state.isMobile &&
    state.isToolbarFixedToTop &&
    state.isEditable
  )
}
