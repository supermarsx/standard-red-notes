import { applyEditorFont } from '@/Utils/editorFont'

/**
 * Applies the editor font CSS variable.
 *
 * @param monospaceFont Whether the monospace toggle is enabled (used as the
 *   theme fallback when no custom editor font is configured).
 * @param customFontFamily The value of the synced `PrefKey.EditorFontFamily`
 *   preference. When set, it takes precedence over the monospace fallback.
 */
export const reloadFont = (monospaceFont?: boolean, customFontFamily?: string) => {
  applyEditorFont(customFontFamily, monospaceFont)
}
