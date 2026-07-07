import { applyEditorFont, applyEditorLigatures } from '@/Utils/editorFont'
import { applyTypographyProfile, resolveActiveTypographyProfile } from '@/Utils/typographyProfiles'
import type { TypographyProfile } from '@standardnotes/models'

/**
 * Applies the editor font CSS variable.
 *
 * @param monospaceFont Whether the monospace toggle is enabled (used as the
 *   theme fallback when no custom editor font is configured).
 * @param customFontFamily The value of the synced `PrefKey.EditorFontFamily`
 *   preference. When set, it takes precedence over the monospace fallback.
 * @param ligaturesEnabled Whether the "Font ligatures" toggle is enabled. When
 *   set, OpenType ligature CSS is enabled on the editor roots (results depend on
 *   whether the active font contains ligatures).
 */
export const reloadFont = (monospaceFont?: boolean, customFontFamily?: string, ligaturesEnabled?: boolean) => {
  applyEditorFont(customFontFamily, monospaceFont)
  applyEditorLigatures(ligaturesEnabled)
}

/**
 * Standard Red Notes: (re)applies the active typography profile. Mirrors
 * `reloadFont` — driven from the synced `PrefKey.TypographyProfiles` /
 * `PrefKey.ActiveTypographyProfileId` prefs. Resolves the active profile and
 * injects/updates the single scoped `<style>` on document.head, so the editor,
 * read-only viewer and previews all pick it up. Safe to call repeatedly.
 */
export const reloadTypographyProfile = (
  profiles: TypographyProfile[] | undefined,
  activeProfileId: string | undefined,
) => {
  applyTypographyProfile(resolveActiveTypographyProfile(profiles, activeProfileId))
}
