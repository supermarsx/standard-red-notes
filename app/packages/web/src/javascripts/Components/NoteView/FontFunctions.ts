import { applyEditorFont, applyEditorLigatures } from '@/Utils/editorFont'

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
