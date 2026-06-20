/*
 * Standard Red Notes — Custom Themes (web-only)
 *
 * Pure model + logic for user-created custom themes. Users pick an accent color
 * (the headline feature) plus a few key colors; we generate a map of
 * `--sn-stylekit-*` CSS custom properties that get injected as a `:root`
 * override layered on top of the active base light/dark theme.
 *
 * Everything here is DOM-free and side-effect-free so it can be unit tested.
 * Storage is localStorage (see CustomThemeStorage), avoiding any edit to the
 * published `@standardnotes/models` PrefKey enum.
 */

export const CUSTOM_THEME_ID_PREFIX = 'custom-theme:'

/** The user-chosen colors that define a custom theme. All are hex strings. */
export type CustomThemeColors = {
  /** Headline feature: the accent / info / highlight color. */
  accent: string
  /** App background color. */
  background: string
  /** Primary text / foreground color. */
  foreground: string
  /** Contrast surface (panels, hovered rows, secondary backgrounds). */
  contrast: string
}

/** A saved custom theme. `id` is stable; `name` is user-editable. */
export type CustomTheme = {
  id: string
  name: string
  colors: CustomThemeColors
}

export const DefaultCustomThemeColors: CustomThemeColors = {
  accent: '#086dd6',
  background: '#ffffff',
  foreground: '#19191c',
  contrast: '#f4f5f7',
}

const HEX_REGEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/

export function isValidHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_REGEX.test(value.trim())
}

/** Expands `#abc` to `#aabbcc`; passes 6-digit through; lowercases. */
export function normalizeHexColor(value: string, fallback: string): string {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!HEX_REGEX.test(trimmed)) {
    return fallback
  }
  let hex = trimmed.slice(1)
  if (hex.length === 3) {
    hex = hex
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return `#${hex.toLowerCase()}`
}

/** Coerces an unknown colors object into a valid CustomThemeColors. */
export function normalizeCustomThemeColors(input: Partial<CustomThemeColors> | undefined): CustomThemeColors {
  const source = input ?? {}
  return {
    accent: normalizeHexColor(source.accent as string, DefaultCustomThemeColors.accent),
    background: normalizeHexColor(source.background as string, DefaultCustomThemeColors.background),
    foreground: normalizeHexColor(source.foreground as string, DefaultCustomThemeColors.foreground),
    contrast: normalizeHexColor(source.contrast as string, DefaultCustomThemeColors.contrast),
  }
}

let idCounter = 0
export function generateCustomThemeId(): string {
  idCounter += 1
  return `${CUSTOM_THEME_ID_PREFIX}${Date.now().toString(36)}-${idCounter.toString(36)}`
}

export function isCustomThemeId(value: string | undefined | null): value is string {
  return typeof value === 'string' && value.startsWith(CUSTOM_THEME_ID_PREFIX)
}

/** Coerces an unknown object into a valid CustomTheme, or null if unusable. */
export function normalizeCustomTheme(input: unknown): CustomTheme | null {
  if (typeof input !== 'object' || input === null) {
    return null
  }
  const candidate = input as Partial<CustomTheme>
  const id = typeof candidate.id === 'string' && candidate.id.length > 0 ? candidate.id : generateCustomThemeId()
  const name =
    typeof candidate.name === 'string' && candidate.name.trim().length > 0 ? candidate.name.trim() : 'Custom Theme'
  return {
    id,
    name,
    colors: normalizeCustomThemeColors(candidate.colors),
  }
}

export function normalizeCustomThemeList(input: unknown): CustomTheme[] {
  if (!Array.isArray(input)) {
    return []
  }
  const themes: CustomTheme[] = []
  for (const entry of input) {
    const theme = normalizeCustomTheme(entry)
    if (theme) {
      themes.push(theme)
    }
  }
  return themes
}

// ---------------------------------------------------------------------------
// Color helpers (lightweight, hex-only) used to derive supporting tokens so a
// single accent + 3 base colors produce a coherent full stylekit override.
// ---------------------------------------------------------------------------

type Rgb = { r: number; g: number; b: number }

function hexToRgb(hex: string): Rgb {
  const normalized = normalizeHexColor(hex, '#000000').slice(1)
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  }
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)))
}

function rgbToHex({ r, g, b }: Rgb): string {
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, '0')
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

/** Mixes `amount` (0..1) of `b` into `a`. */
export function mixColors(a: string, b: string, amount: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const t = Math.max(0, Math.min(1, amount))
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  })
}

export function darken(hex: string, amount: number): string {
  return mixColors(hex, '#000000', amount)
}

export function lighten(hex: string, amount: number): string {
  return mixColors(hex, '#ffffff', amount)
}

/** Perceived luminance via the YIQ formula (same approach as Theme/Color). */
export function isDarkColor(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex)
  return (r * 299 + g * 587 + b * 114) / 1000 <= 128
}

/** Picks black or white text for best contrast against a background. */
export function contrastTextColor(background: string): string {
  return isDarkColor(background) ? '#ffffff' : '#000000'
}

/** True when foreground/background contrast is too low to be comfortably read. */
export function hasReadableContrast(foreground: string, background: string): boolean {
  const fg = hexToRgb(foreground)
  const bg = hexToRgb(background)
  const lum = (c: Rgb) => {
    const channel = (v: number) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
    }
    return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  }
  const l1 = lum(fg)
  const l2 = lum(bg)
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  // WCAG AA for normal text is 4.5; we warn below that.
  return ratio >= 4.5
}

/**
 * Generates the `--sn-stylekit-*` (and a few supporting) CSS custom properties
 * for a set of chosen colors. The returned map is what we inject into a
 * `:root { ... }` override layered over the active base theme.
 */
export function generateCustomThemeVariables(rawColors: CustomThemeColors): Record<string, string> {
  const colors = normalizeCustomThemeColors(rawColors)
  const { accent, background, foreground, contrast } = colors

  const dark = isDarkColor(background)
  const accentContrast = contrastTextColor(accent)
  const accentDarkened = darken(accent, 0.15)
  // Borders: nudge toward foreground a bit from the background.
  const borderColor = mixColors(background, foreground, dark ? 0.18 : 0.12)
  const contrastBorder = mixColors(contrast, foreground, dark ? 0.2 : 0.14)
  const secondaryBackground = mixColors(background, contrast, 0.7)
  const paragraphText = mixColors(foreground, background, 0.12)
  const placeholder = mixColors(foreground, background, 0.45)
  const scrollbarThumb = mixColors(background, foreground, 0.3)
  const shadow = dark ? darken(background, 0.3) : darken(background, 0.12)

  return {
    // Accent / info — the headline feature.
    '--sn-stylekit-info-color': accent,
    '--sn-stylekit-info-color-darkened': accentDarkened,
    '--sn-stylekit-info-contrast-color': accentContrast,
    '--sn-stylekit-info-backdrop-color': mixColors(background, accent, 0.08),
    '--sn-stylekit-scrollbar-thumb-color': scrollbarThumb,

    // Legacy aliases some themes/components read.
    '--highlight-color': accent,
    '--sn-component-foreground-highlight-color': accent,
    '--accent-color': accent,

    // Backgrounds / foregrounds.
    '--sn-stylekit-background-color': background,
    '--sn-stylekit-foreground-color': foreground,
    '--sn-stylekit-editor-background-color': background,
    '--sn-stylekit-editor-foreground-color': foreground,
    '--sn-stylekit-paragraph-text-color': paragraphText,
    '--foreground-color': foreground,
    '--background-color': background,

    // Borders.
    '--sn-stylekit-border-color': borderColor,
    '--border-color': borderColor,
    '--sn-stylekit-input-border-color': borderColor,
    '--sn-stylekit-input-placeholder-color': placeholder,

    // Contrast surfaces.
    '--sn-stylekit-contrast-background-color': contrast,
    '--sn-stylekit-contrast-foreground-color': foreground,
    '--sn-stylekit-contrast-border-color': contrastBorder,

    // Secondary surfaces.
    '--sn-stylekit-secondary-background-color': secondaryBackground,
    '--sn-stylekit-secondary-foreground-color': foreground,
    '--sn-stylekit-secondary-border-color': borderColor,
    '--sn-stylekit-secondary-contrast-background-color': contrast,
    '--sn-stylekit-secondary-contrast-foreground-color': foreground,
    '--sn-stylekit-secondary-contrast-border-color': contrastBorder,

    '--sn-stylekit-shadow-color': shadow,

    // Theme type so component CSS that branches on light/dark behaves.
    '--sn-stylekit-theme-type': dark ? 'dark' : 'light',
  }
}

/** Builds the CSS text for the injected `:root` override style element. */
export function buildCustomThemeCss(colors: CustomThemeColors): string {
  const variables = generateCustomThemeVariables(colors)
  const declarations = Object.entries(variables)
    .map(([property, value]) => `  ${property}: ${value};`)
    .join('\n')
  return `:root {\n${declarations}\n}`
}

// ---------------------------------------------------------------------------
// State shape + reducer for create / rename / edit / delete / select.
// ---------------------------------------------------------------------------

export type CustomThemesState = {
  themes: CustomTheme[]
  /** id of the selected custom theme, or null when a built-in theme is active. */
  selectedId: string | null
}

export type CustomThemesAction =
  | { type: 'add'; name: string; colors: CustomThemeColors; select?: boolean }
  | { type: 'update'; id: string; name?: string; colors?: CustomThemeColors }
  | { type: 'delete'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'replace'; state: CustomThemesState }

export function customThemesReducer(state: CustomThemesState, action: CustomThemesAction): CustomThemesState {
  switch (action.type) {
    case 'add': {
      const theme: CustomTheme = {
        id: generateCustomThemeId(),
        name: action.name.trim() || 'Custom Theme',
        colors: normalizeCustomThemeColors(action.colors),
      }
      return {
        themes: [...state.themes, theme],
        selectedId: action.select ? theme.id : state.selectedId,
      }
    }
    case 'update': {
      return {
        ...state,
        themes: state.themes.map((theme) => {
          if (theme.id !== action.id) {
            return theme
          }
          return {
            ...theme,
            name: action.name !== undefined ? action.name.trim() || theme.name : theme.name,
            colors: action.colors ? normalizeCustomThemeColors(action.colors) : theme.colors,
          }
        }),
      }
    }
    case 'delete': {
      return {
        themes: state.themes.filter((theme) => theme.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
      }
    }
    case 'select': {
      if (action.id !== null && !state.themes.some((theme) => theme.id === action.id)) {
        return state
      }
      return { ...state, selectedId: action.id }
    }
    case 'replace': {
      return action.state
    }
    default:
      return state
  }
}
