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

  // --- Added Sans-serif ----------------------------------------------
  { name: 'Roboto', css: "'Roboto', sans-serif", category: 'Sans-serif', weights: w(400, 500, 700), bundled: true },
  { name: 'Open Sans', css: "'Open Sans', sans-serif", category: 'Sans-serif', weights: w(400, 600, 700), bundled: true },
  { name: 'Lato', css: "'Lato', sans-serif", category: 'Sans-serif', weights: w(400, 700), bundled: true },
  { name: 'Montserrat', css: "'Montserrat', sans-serif", category: 'Sans-serif', weights: w(400, 500, 700), bundled: true },
  { name: 'Poppins', css: "'Poppins', sans-serif", category: 'Sans-serif', weights: w(400, 500, 600), bundled: true },
  { name: 'Nunito', css: "'Nunito', sans-serif", category: 'Sans-serif', weights: w(400, 600, 700), bundled: true },
  { name: 'Work Sans', css: "'Work Sans', sans-serif", category: 'Sans-serif', weights: w(400, 500, 700), bundled: true },
  { name: 'Source Sans 3', css: "'Source Sans 3', sans-serif", category: 'Sans-serif', weights: w(400, 600, 700), bundled: true },
  { name: 'Raleway', css: "'Raleway', sans-serif", category: 'Sans-serif', weights: w(400, 500, 700), bundled: true },
  { name: 'DM Sans', css: "'DM Sans', sans-serif", category: 'Sans-serif', weights: w(400, 500, 700), bundled: true },

  // --- Added Serif ---------------------------------------------------
  { name: 'Merriweather', css: "'Merriweather', serif", category: 'Serif', weights: w(400, 700), bundled: true },
  { name: 'Playfair Display', css: "'Playfair Display', serif", category: 'Serif', weights: w(400, 500, 700), bundled: true },
  { name: 'Lora', css: "'Lora', serif", category: 'Serif', weights: w(400, 500, 700), bundled: true },
  { name: 'PT Serif', css: "'PT Serif', serif", category: 'Serif', weights: w(400, 700), bundled: true },
  { name: 'Source Serif 4', css: "'Source Serif 4', serif", category: 'Serif', weights: w(400, 600, 700), bundled: true },
  { name: 'Bitter', css: "'Bitter', serif", category: 'Serif', weights: w(400, 500, 700), bundled: true },
  { name: 'Crimson Text', css: "'Crimson Text', serif", category: 'Serif', weights: w(400, 600, 700), bundled: true },
  { name: 'Libre Baskerville', css: "'Libre Baskerville', serif", category: 'Serif', weights: w(400, 700), bundled: true },
  { name: 'EB Garamond', css: "'EB Garamond', serif", category: 'Serif', weights: w(400, 500, 600), bundled: true },
  { name: 'Cormorant Garamond', css: "'Cormorant Garamond', serif", category: 'Serif', weights: w(400, 500, 700), bundled: true },

  // --- Added Monospace -----------------------------------------------
  { name: 'Roboto Mono', css: "'Roboto Mono', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'Fira Code', css: "'Fira Code', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'IBM Plex Mono', css: "'IBM Plex Mono', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'Space Mono', css: "'Space Mono', monospace", category: 'Monospace', weights: w(400, 700), bundled: true },
  { name: 'Ubuntu Mono', css: "'Ubuntu Mono', monospace", category: 'Monospace', weights: w(400, 700), bundled: true },
  { name: 'Anonymous Pro', css: "'Anonymous Pro', monospace", category: 'Monospace', weights: w(400, 700), bundled: true },
  { name: 'Cousine', css: "'Cousine', monospace", category: 'Monospace', weights: w(400, 700), bundled: true },
  { name: 'Overpass Mono', css: "'Overpass Mono', monospace", category: 'Monospace', weights: w(400, 600, 700), bundled: true },
  { name: 'Red Hat Mono', css: "'Red Hat Mono', monospace", category: 'Monospace', weights: w(400, 500, 700), bundled: true },
  { name: 'DM Mono', css: "'DM Mono', monospace", category: 'Monospace', weights: w(400, 500), bundled: true },

  // --- Added Handwriting ---------------------------------------------
  { name: 'Dancing Script', css: "'Dancing Script', cursive", category: 'Handwriting', weights: w(400, 700), bundled: true },
  { name: 'Kalam', css: "'Kalam', cursive", category: 'Handwriting', weights: w(400, 700), bundled: true },
  { name: 'Shadows Into Light', css: "'Shadows Into Light', cursive", category: 'Handwriting', weights: w(400), bundled: true },
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
