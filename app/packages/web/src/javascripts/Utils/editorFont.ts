/**
 * Utilities for the "custom editor font" feature.
 *
 * The editor font is applied via the CSS custom property
 * `--sn-stylekit-editor-font-family` (consumed by the `.font-editor` class and
 * by the Super editor wrapper). The chosen font is persisted in the synced
 * preference `PrefKey.EditorFontFamily`.
 *
 * The preference value is a plain string:
 *   - ''                       -> theme/system default (no override)
 *   - 'google:<Family Name>'   -> a Google Font, loaded dynamically from
 *                                 fonts.googleapis.com
 *   - any other string         -> a literal CSS font-family stack or an
 *                                 installed local/system font name
 */

export const EDITOR_FONT_CSS_VAR = '--sn-stylekit-editor-font-family'

export const GOOGLE_FONT_PREFIX = 'google:'

const GOOGLE_FONT_LINK_ID = 'sn-editor-google-font'

/** Built-in font stacks offered as quick presets in the UI. */
export const BuiltInEditorFonts = {
  Default: '',
  Sans: 'var(--sn-stylekit-sans-serif-font)',
  Serif:
    'Georgia, Cambria, "Times New Roman", Times, serif',
  Monospace: 'var(--sn-stylekit-monospace-font)',
} as const

export type EditorFontSelectionKind = 'builtin' | 'local' | 'google'

export const isGoogleFontValue = (value: string): boolean => value.startsWith(GOOGLE_FONT_PREFIX)

export const getGoogleFontName = (value: string): string =>
  isGoogleFontValue(value) ? value.slice(GOOGLE_FONT_PREFIX.length).trim() : ''

export const makeGoogleFontValue = (familyName: string): string =>
  `${GOOGLE_FONT_PREFIX}${familyName.trim()}`

/**
 * Resolves a stored preference value into a CSS font-family string that can be
 * assigned to the editor font CSS variable. Returns null for "no override"
 * (empty / default), in which case the caller should fall back to the theme
 * default (sans-serif or monospace).
 */
export const resolveEditorFontFamily = (value: string | undefined): string | null => {
  if (!value) {
    return null
  }
  if (isGoogleFontValue(value)) {
    const name = getGoogleFontName(value)
    return name ? `'${name}'` : null
  }
  return value
}

/**
 * Injects (or replaces) the single Google Font <link> stylesheet for the given
 * family name. Passing an empty/undefined name removes any existing link.
 */
export const loadGoogleFont = (familyName: string | undefined): void => {
  if (typeof document === 'undefined') {
    return
  }

  const existing = document.getElementById(GOOGLE_FONT_LINK_ID) as HTMLLinkElement | null

  const trimmed = (familyName ?? '').trim()
  if (!trimmed) {
    existing?.remove()
    return
  }

  const encoded = encodeURIComponent(trimmed).replace(/%20/g, '+')
  const href = `https://fonts.googleapis.com/css2?family=${encoded}:wght@400;700&display=swap`

  if (existing) {
    if (existing.href !== href) {
      existing.href = href
    }
    return
  }

  const link = document.createElement('link')
  link.id = GOOGLE_FONT_LINK_ID
  link.rel = 'stylesheet'
  link.href = href
  document.head.appendChild(link)
}

/**
 * Applies the chosen editor font preference. Loads the Google Font stylesheet
 * if needed and sets the editor font CSS variable. When the preference is empty
 * the variable is reset so the theme default (sans-serif / monospace) applies.
 *
 * `monospaceFallback` mirrors the existing monospace toggle: when no custom
 * font is set, the variable is pointed at the monospace or sans-serif stack.
 */
export const applyEditorFont = (preferenceValue: string | undefined, monospaceFallback?: boolean): void => {
  if (typeof document === 'undefined') {
    return
  }

  const root = (document.querySelector(':root') as HTMLElement | null) ?? document.documentElement

  if (isGoogleFontValue(preferenceValue ?? '')) {
    loadGoogleFont(getGoogleFontName(preferenceValue ?? ''))
  } else {
    loadGoogleFont(undefined)
  }

  const resolved = resolveEditorFontFamily(preferenceValue)

  if (resolved) {
    root.style.setProperty(EDITOR_FONT_CSS_VAR, resolved)
    document.documentElement.classList.toggle('monospace-font', false)
    return
  }

  // No custom font: fall back to the theme default, honoring the monospace toggle.
  root.style.setProperty(
    EDITOR_FONT_CSS_VAR,
    monospaceFallback ? 'var(--sn-stylekit-monospace-font)' : 'var(--sn-stylekit-sans-serif-font)',
  )
  document.documentElement.classList.toggle('monospace-font', Boolean(monospaceFallback))
}

/**
 * The class toggled on `document.documentElement` when the "Font ligatures"
 * setting is enabled. Editor stylesheets scope their ligature CSS under this
 * class so the effect applies live across the plain, Super and code editors.
 *
 * NOTE: ligatures only render if the *active editor font actually contains
 * them*. This toggle merely enables the OpenType CSS; it does not bundle a
 * ligature font.
 */
export const LIGATURES_CLASS = 'srn-ligatures-on'

/**
 * Applies (or removes) the global ligatures class on the document root. Safe to
 * call repeatedly; toggling updates editor rendering live without a reload.
 */
export const applyEditorLigatures = (enabled: boolean | undefined): void => {
  if (typeof document === 'undefined') {
    return
  }
  document.documentElement.classList.toggle(LIGATURES_CLASS, Boolean(enabled))
}

export type LocalFontEntry = {
  family: string
  fullName: string
}

/** Feature-detect the Local Font Access API. */
export const isLocalFontAccessSupported = (): boolean =>
  typeof window !== 'undefined' && typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'

/**
 * Enumerates installed local fonts via the Local Font Access API. Returns a
 * de-duplicated, alphabetically sorted list of font families. Resolves to an
 * empty array if the API is unavailable or the user denies permission.
 */
export const queryLocalFonts = async (): Promise<LocalFontEntry[]> => {
  if (!isLocalFontAccessSupported()) {
    return []
  }

  try {
    const query = (window as unknown as { queryLocalFonts: () => Promise<Array<{ family: string; fullName: string }>> })
      .queryLocalFonts
    const fonts = await query()

    const seen = new Set<string>()
    const result: LocalFontEntry[] = []
    for (const font of fonts) {
      if (font.family && !seen.has(font.family)) {
        seen.add(font.family)
        result.push({ family: font.family, fullName: font.fullName || font.family })
      }
    }

    result.sort((a, b) => a.family.localeCompare(b.family))
    return result
  } catch (error) {
    console.error('Unable to query local fonts', error)
    return []
  }
}
