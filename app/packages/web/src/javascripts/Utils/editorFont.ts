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
 *   - 'google:<Family Name>'   -> LEGACY. Kept readable forever (see below).
 *   - any other string         -> a literal CSS font-family stack or an
 *                                 installed local/system font name
 *
 * Fonts are served from our OWN origin. Importing `fontCatalog` below pulls in
 * `editorFonts.css` — 120 self-hosted latin-subset woff2 faces across 42
 * families, emitted to `assets/fonts/` by webpack's `asset/resource` rule — so
 * `font-src 'self'` and `style-src 'self'` are both satisfied and NO client
 * ever contacts fonts.googleapis.com or fonts.gstatic.com.
 *
 * That import is deliberately HERE rather than only in the Super toolbar: this
 * module is reached from ApplicationView (the synchronous entry graph), so the
 * @font-face declarations land in the main `app.css`. Previously the catalog's
 * only importer was `ToolbarPlugin.tsx`, which put all 120 faces in a lazy
 * chunk — so a bundled family was undeclared in a plaintext note, or in a Super
 * note until the toolbar chunk happened to load. Declaring a face costs no
 * bytes: a browser fetches the woff2 only once a rule actually matches it.
 *
 * LEGACY `google:` VALUES. The old implementation injected a
 * `<link rel=stylesheet href=fonts.googleapis.com>`, which the app's CSP has
 * always refused (`style-src 'self' 'unsafe-inline'`), and emitted a bare
 * family with no fallback, so the editor silently landed on a browser default.
 * A stored `google:<Family>` is now MAPPED at read time onto the bundled face
 * of the same name — nothing is rewritten in the synced preference, so the
 * value keeps working on older clients and no migration can corrupt it. The UI
 * no longer *writes* the prefix; it stores a real CSS stack.
 */

import { FONT_CATALOG, type FontCategory, type FontDefinition } from '@/Components/SuperEditor/fonts/fontCatalog'

export const EDITOR_FONT_CSS_VAR = '--sn-stylekit-editor-font-family'

export const GOOGLE_FONT_PREFIX = 'google:'

/**
 * Id of the stylesheet `<link>` the pre-bundled-fonts implementation injected.
 * Nothing creates it any more; `loadEditorFontFaces` still removes it so a
 * hot-reloaded session cannot leave a refused Google request behind.
 */
const LEGACY_GOOGLE_FONT_LINK_ID = 'sn-editor-google-font'

/** The generic CSS family each catalog category degrades to. */
const CATEGORY_FALLBACK: Record<FontCategory, string> = {
  System: 'sans-serif',
  'Sans-serif': 'sans-serif',
  Serif: 'serif',
  Monospace: 'monospace',
  Handwriting: 'cursive',
}

/** The self-hosted families, i.e. those with woff2 faces in ./fonts/files. */
export const BundledEditorFonts: FontDefinition[] = FONT_CATALOG.filter((font) => font.bundled)

/** Lower-cased family name -> bundled catalog entry. */
const BUNDLED_BY_NAME = new Map(BundledEditorFonts.map((font) => [font.name.toLowerCase(), font]))

/**
 * CSS-wide and generic family keywords. These are already valid on their own —
 * quoting them or appending a fallback would change their meaning.
 */
const CSS_GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'revert',
  'revert-layer',
  'unset',
])

/**
 * Looks a family name up in the bundled catalog, case- and whitespace-
 * insensitively. Returns undefined for a family we do not ship.
 */
export const findBundledEditorFont = (familyName: string | undefined): FontDefinition | undefined => {
  if (!familyName) {
    return undefined
  }
  return BUNDLED_BY_NAME.get(familyName.trim().toLowerCase())
}

/**
 * The first family named by a stored preference value, unquoted — the one the
 * browser will actually try first. Handles a legacy `google:Inter`, a bare
 * `Inter`, and a full stack such as `'Inter', sans-serif`. Returns '' for an
 * empty value or a `var()` reference (which names no family we could preload).
 */
export const getPrimaryFontFamily = (value: string | undefined): string => {
  const raw = isGoogleFontValue(value ?? '') ? getGoogleFontName(value ?? '') : (value ?? '').trim()
  if (!raw || raw.includes('var(')) {
    return ''
  }
  return (raw.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '')
}

/**
 * Wraps a single family name in a quoted-family + generic-fallback stack, so an
 * unavailable face degrades to a sane generic instead of the browser default.
 */
const withFallback = (familyName: string, generic = 'sans-serif'): string => `'${familyName}', ${generic}`

/**
 * The CSS stack for a bundled catalog entry. The catalog's own `css` already
 * carries a generic (`'Inter', sans-serif`); this re-derives one from the
 * category if an entry is ever added without one, so no code path can emit a
 * bare family.
 */
const bundledFontStack = (font: FontDefinition): string => {
  if (font.css && font.css.includes(',')) {
    return font.css
  }
  return withFallback(font.name, CATEGORY_FALLBACK[font.category])
}

/** Built-in font stacks offered as quick presets in the UI. */
export const BuiltInEditorFonts = {
  Default: '',
  Sans: 'var(--sn-stylekit-sans-serif-font)',
  Serif: 'Georgia, Cambria, "Times New Roman", Times, serif',
  Monospace: 'var(--sn-stylekit-monospace-font)',
} as const

export type EditorFontSelectionKind = 'builtin' | 'local' | 'google'

export const isGoogleFontValue = (value: string): boolean => value.startsWith(GOOGLE_FONT_PREFIX)

export const getGoogleFontName = (value: string): string => {
  return isGoogleFontValue(value) ? value.slice(GOOGLE_FONT_PREFIX.length).trim() : ''
}

export const makeGoogleFontValue = (familyName: string): string => `${GOOGLE_FONT_PREFIX}${familyName.trim()}`

/**
 * Resolves a stored preference value into a CSS font-family string that can be
 * assigned to the editor font CSS variable. Returns null for "no override"
 * (empty / default), in which case the caller should fall back to the theme
 * default (sans-serif or monospace).
 *
 * Every single-family result carries a generic fallback, so a family we do not
 * ship (a `google:` value outside the catalog, or a local font absent from this
 * device) degrades to serif/sans-serif/monospace rather than to whatever the
 * browser picks for an unknown name.
 */
export const resolveEditorFontFamily = (value: string | undefined): string | null => {
  if (!value) {
    return null
  }

  if (isGoogleFontValue(value)) {
    const name = getGoogleFontName(value)
    if (!name) {
      return null
    }
    // Legacy value: map onto the bundled face of the same name when we ship it.
    const bundled = findBundledEditorFont(name)
    return bundled ? bundledFontStack(bundled) : withFallback(name)
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  // A var() reference or a value that is already a stack is used verbatim; so
  // are the CSS generic/CSS-wide keywords, which are complete on their own.
  if (trimmed.includes('var(') || trimmed.includes(',') || CSS_GENERIC_FAMILIES.has(trimmed.toLowerCase())) {
    return trimmed
  }

  // A single family name: prefer the bundled catalog's own stack, else quote it
  // and append a generic so it cannot silently fall through to the default.
  const bundled = findBundledEditorFont(trimmed)
  if (bundled) {
    return bundledFontStack(bundled)
  }

  return withFallback(trimmed.replace(/^['"]|['"]$/g, ''))
}

/**
 * Asks the browser to load the faces for the chosen editor font from our own
 * origin, and clears any stylesheet link left by the legacy Google path.
 *
 * `document.fonts.load()` is what drives the CSS Font Loading API, so the
 * `loading` / `loadingdone` events still fire exactly as they did when a
 * remote stylesheet was injected. `useFontFacesLoadedToken` in
 * MermaidAppTheme.ts listens for `loadingdone` to re-render a diagram whose
 * labels were measured in the fallback before the real face arrived — a local
 * face is still fetched asynchronously, so that signal stays both necessary
 * and load-bearing here.
 *
 * Note we deliberately do NOT use `document.fonts.check()`: it answers "would
 * this text render?", which is true for any family once a fallback can serve
 * it, so it reports success for a face that never loaded.
 */
export const loadEditorFontFaces = (preferenceValue: string | undefined): void => {
  if (typeof document === 'undefined') {
    return
  }

  document.getElementById(LEGACY_GOOGLE_FONT_LINK_ID)?.remove()

  const fonts = document.fonts
  if (!fonts || typeof fonts.load !== 'function') {
    return
  }

  const bundled = findBundledEditorFont(getPrimaryFontFamily(preferenceValue))
  if (!bundled) {
    // Not a family we ship: nothing to fetch. A local/system font is already
    // installed, and an unknown family now resolves to a generic fallback.
    return
  }

  for (const weight of bundled.weights) {
    try {
      // Rejects only on an unparsable font shorthand; resolves with [] when the
      // family is undeclared. Either way a failure must not surface as noise.
      void fonts.load(`${weight.value} 1em '${bundled.name}'`).catch(() => undefined)
    } catch {
      // Ignore: a font we cannot request is handled by the fallback stack.
    }
  }
}

/**
 * Applies the chosen editor font preference. Kicks off the load of the bundled
 * faces if needed and sets the editor font CSS variable. When the preference is
 * empty the variable is reset so the theme default (sans-serif / monospace)
 * applies.
 *
 * `monospaceFallback` mirrors the existing monospace toggle: when no custom
 * font is set, the variable is pointed at the monospace or sans-serif stack.
 */
export const applyEditorFont = (preferenceValue: string | undefined, monospaceFallback?: boolean): void => {
  if (typeof document === 'undefined') {
    return
  }

  const root = (document.querySelector(':root') as HTMLElement | null) ?? document.documentElement

  loadEditorFontFaces(preferenceValue)

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
  typeof window !== 'undefined' &&
  typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === 'function'

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
