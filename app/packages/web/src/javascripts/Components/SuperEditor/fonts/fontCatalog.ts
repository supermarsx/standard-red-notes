/**
 * Standard Red Notes: the editor font catalog. One source of truth for the
 * toolbar's (categorized, searchable) font-family picker and its per-font
 * font-weight dropdown. Importing this module also pulls in the self-hosted
 * @font-face declarations so the bundled web fonts are available offline.
 */
import './editorFonts.css'

export type FontCategory = 'System' | 'Sans-serif' | 'Serif' | 'Monospace' | 'Handwriting'

export type FontWeightOption = { label: string; value: number }

export type FontDefinition = {
  /** Display name shown in the picker. */
  name: string
  /** The CSS `font-family` value applied to the selection (null = clear/inherit). */
  css: string | null
  category: FontCategory
  /** Weights this font actually ships, named by their standard CSS weight. */
  weights: FontWeightOption[]
  /** True for the self-hosted bundled web fonts (vs. generic/system families). */
  bundled?: boolean
}

/** Standard CSS weight names, used to attribute each font's weights. */
export const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
}

const w = (...values: number[]): FontWeightOption[] =>
  values.map((value) => ({ label: WEIGHT_NAMES[value] ?? String(value), value }))

/** Weights every system/generic family can be assumed to support. */
const SYSTEM_WEIGHTS = w(400, 700)

/** The "no explicit family" option — clears the font-family style. */
export const DEFAULT_FONT: FontDefinition = {
  name: 'Default',
  css: null,
  category: 'System',
  weights: SYSTEM_WEIGHTS,
}

export const FONT_CATALOG: FontDefinition[] = [
  DEFAULT_FONT,

  // --- System / generic (no download needed) -------------------------------
  { name: 'Sans-serif', css: 'sans-serif', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Serif', css: 'serif', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Monospace', css: 'monospace', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Arial', css: 'Arial, sans-serif', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Georgia', css: 'Georgia, serif', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Times New Roman', css: '"Times New Roman", serif', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Courier New', css: '"Courier New", monospace', category: 'System', weights: SYSTEM_WEIGHTS },
  { name: 'Trebuchet MS', css: '"Trebuchet MS", sans-serif', category: 'System', weights: SYSTEM_WEIGHTS },

  // --- Bundled sans-serif --------------------------------------------------
  { name: 'Inter', css: "'Inter', sans-serif", category: 'Sans-serif', weights: w(400, 500, 600, 700), bundled: true },
  { name: 'Manrope', css: "'Manrope', sans-serif", category: 'Sans-serif', weights: w(300, 400, 500, 700), bundled: true },
  { name: 'Fira Sans', css: "'Fira Sans', sans-serif", category: 'Sans-serif', weights: w(300, 400, 500, 700), bundled: true },

  // --- Bundled serif -------------------------------------------------------
  { name: 'IBM Plex Serif', css: "'IBM Plex Serif', serif", category: 'Serif', weights: w(400, 500, 600, 700), bundled: true },
  { name: 'Rokkitt', css: "'Rokkitt', serif", category: 'Serif', weights: w(300, 400, 500, 700), bundled: true },
  { name: 'Coustard', css: "'Coustard', serif", category: 'Serif', weights: w(400, 900), bundled: true },

  // --- Bundled monospace ---------------------------------------------------
  { name: 'JetBrains Mono', css: "'JetBrains Mono', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'Inconsolata', css: "'Inconsolata', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'Source Code Pro', css: "'Source Code Pro', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },

  // --- Bundled handwriting -------------------------------------------------
  { name: 'Caveat', css: "'Caveat', cursive", category: 'Handwriting', weights: w(400, 700), bundled: true },
  { name: 'Patrick Hand', css: "'Patrick Hand', cursive", category: 'Handwriting', weights: w(400), bundled: true },
]

/** Category display order for the grouped picker. */
export const FONT_CATEGORY_ORDER: FontCategory[] = ['System', 'Sans-serif', 'Serif', 'Monospace', 'Handwriting']

/** Find the catalog entry whose css value matches the current selection (or Default). */
export function findFontByCss(css: string): FontDefinition {
  if (!css) {
    return DEFAULT_FONT
  }
  return FONT_CATALOG.find((font) => font.css === css) ?? DEFAULT_FONT
}

/** Filter the catalog by a free-text query against the font name (case-insensitive). */
export function filterFonts(query: string): FontDefinition[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return FONT_CATALOG
  }
  return FONT_CATALOG.filter((font) => font.name.toLowerCase().includes(q))
}

/** Group a (possibly filtered) font list into category order, dropping empty categories. */
export function groupFontsByCategory(fonts: FontDefinition[]): { category: FontCategory; fonts: FontDefinition[] }[] {
  return FONT_CATEGORY_ORDER.map((category) => ({
    category,
    fonts: fonts.filter((font) => font.category === category),
  })).filter((group) => group.fonts.length > 0)
}
