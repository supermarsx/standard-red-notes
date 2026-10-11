/**
 * Standard Red Notes — the ONE place that answers "should mermaid source be
 * syntax-highlighted?".
 *
 *
 * WHY THE KEY IS A PINNED LITERAL AND NOT `PrefKey.SuperMermaidSourceHighlighting`
 *
 * Same reason as `checklistBackfill.ts` and `todoFilters.ts`, which document it
 * at length: web consumes `PrefKey`'s RUNTIME value from
 * `@standardnotes/snjs/dist/snjs.js`, a webpack bundle that INLINES
 * `@standardnotes/models`. A brand-new enum member therefore reads `undefined`
 * in the browser until BOTH `models` and `snjs` have been rebuilt — and
 * `getPreference(undefined, …)` does not fail, it quietly returns the default
 * forever, which looks exactly like "the setting does nothing". A string enum
 * member IS its own string at runtime, so pinning the literal makes this module
 * independent of which build of models happens to be on disk.
 *
 * `MermaidSourceHighlightPreference.spec.ts` asserts that the literal and the
 * default below agree with `PrefKey` and `PrefDefaults`, so the pin can never
 * drift from the enum it mirrors. That spec is also the thing that fails if the
 * enum member is ever removed.
 *
 *
 * WHY THE DEFAULT IS APPLIED ON READ RATHER THAN TAKEN FROM `PrefDefaults`
 *
 * `PrefDefaults[PrefKey.SuperMermaidSourceHighlighting]` is subject to the exact
 * same staleness, and would read `undefined`. Worse, the value is SYNCED: a
 * device running an older or newer build may have written anything at all into
 * it. So `normalizeMermaidSourceHighlighting` takes `unknown`, and only an
 * explicit `false` turns highlighting off — a missing value, a value from a
 * client that has never heard of this key, and a corrupted value all read as ON,
 * which is the behaviour a user who never opted out expects.
 */
import { ApplicationEvent, PrefKey } from '@standardnotes/snjs'
import { useEffect, useState } from 'react'
import { useApplicationOrNull } from '@/Components/ApplicationProvider'

/** The synced `UserPrefs` key, as the string that is actually written. */
export const MERMAID_SOURCE_HIGHLIGHT_PREF_KEY =
  'superMermaidSourceHighlighting' as PrefKey.SuperMermaidSourceHighlighting

/**
 * ON. Highlighting is the feature the user asked for; a diagram source in one
 * undifferentiated colour is the state this work exists to end. Turning it off
 * is an escape hatch (a very long source, a personal preference, a theme whose
 * palette a user dislikes), not the starting point.
 */
export const DEFAULT_MERMAID_SOURCE_HIGHLIGHT = true

/** Coerce a synced, untrusted value. Only an explicit `false` disables. */
export function normalizeMermaidSourceHighlighting(raw: unknown): boolean {
  return typeof raw === 'boolean' ? raw : DEFAULT_MERMAID_SOURCE_HIGHLIGHT
}

/**
 * Whether to highlight, read LIVE: the hook re-reads on
 * `ApplicationEvent.PreferencesChanged`, which is what makes the Preferences
 * toggle take effect with no reload.
 *
 * `useApplicationOrNull`, not `useApplication`: a mermaid block also renders on
 * the PUBLIC share page, which has no `<ApplicationProvider>` by design
 * (`SharedSuperContent.tsx`), and `useApplication` throws there — a throw inside
 * a decorator node is caught by the viewer's boundary and replaced with "this
 * block could not be displayed". A reader of a shared note gets the default.
 */
export function useMermaidSourceHighlightingEnabled(): boolean {
  const application = useApplicationOrNull()
  const [enabled, setEnabled] = useState(() => readMermaidSourceHighlighting(application))

  useEffect(() => {
    if (!application) {
      return
    }
    return application.addEventObserver(async () => {
      setEnabled(readMermaidSourceHighlighting(application))
    }, ApplicationEvent.PreferencesChanged)
  }, [application])

  return enabled
}

/** The preference source this module needs, narrowed to one method. */
export type MermaidHighlightPreferenceSource = {
  getPreference: (key: PrefKey) => unknown
}

/**
 * The read, extracted so a spec can drive it with a stub instead of a
 * WebApplication. A `null` source — the share page — is the default.
 */
export function readMermaidSourceHighlighting(source: MermaidHighlightPreferenceSource | null | undefined): boolean {
  if (!source || typeof source.getPreference !== 'function') {
    return DEFAULT_MERMAID_SOURCE_HIGHLIGHT
  }
  return normalizeMermaidSourceHighlighting(source.getPreference(MERMAID_SOURCE_HIGHLIGHT_PREF_KEY))
}
