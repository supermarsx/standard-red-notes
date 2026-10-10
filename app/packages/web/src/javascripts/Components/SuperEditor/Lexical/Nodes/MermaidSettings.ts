/**
 * Standard Red Notes — the ONE source of truth for a Mermaid diagram block's
 * configuration.
 *
 * Every mermaid setting is read and written through this module. Since t119 it
 * has exactly ONE surface:
 *
 *   - the editor toolbar's dedicated "Mermaid" contextual section (ToolbarPlugin),
 *     which appears while a diagram is selected and mounts MermaidSettingsPanel
 *     in its popover, driving the node's own setters.
 *
 * The chart container used to mount that same panel as well. The user asked for
 * the configuration not to be offered twice, so the container now carries only
 * its own header (identity, Templates, Reload) and the corner drag handle. The
 * panel's other arrangement is still built and still tested, so restoring that
 * surface — or a chosen subset of it — is a matter of mounting it again.
 *
 * Nothing is duplicated per surface either way: the normalizers, the default
 * constants and the resolution functions below are shared, so if a control needs
 * a rule, the rule lives here.
 *
 * Every value is a SYNCED value: another client, an older build, or a hand-edited
 * note may have written it. So each normalizer takes `unknown`, never throws, and
 * returns `undefined` for "not configured — use the default" rather than letting
 * an unvalidated value reach a style attribute or mermaid's own config.
 */

/** Mermaid's own built-in themes, as accepted by `mermaid.initialize`. */
export const MERMAID_BUILTIN_THEMES = ['default', 'dark', 'forest', 'neutral', 'base'] as const
export type MermaidBuiltinTheme = (typeof MERMAID_BUILTIN_THEMES)[number]

/**
 * What a diagram's theme setting may say. `app` — the default for a newly
 * inserted diagram — follows the application's own light/dark theme, because a
 * light-themed diagram inside a dark editor reads as broken.
 *
 * A diagram that already STORES one of the built-in names keeps it: an existing
 * note must not change appearance on load just because the default moved.
 */
export const MERMAID_THEME_MODES = ['app', ...MERMAID_BUILTIN_THEMES] as const
export type MermaidThemeMode = (typeof MERMAID_THEME_MODES)[number]
export const DEFAULT_MERMAID_THEME_MODE: MermaidThemeMode = 'app'

/**
 * How the rendered diagram is fitted into its box.
 *
 *  - `fitWidth`  — scale so the diagram spans the box's full WIDTH (what the
 *                  container actually offers), and let the box be as tall as that
 *                  needs, up to the configured maximum height. Upscales a small
 *                  diagram up to `MAX_FIT_UPSCALE`, which is why it is a
 *                  deliberate choice rather than the default.
 *  - `fitBoth`   — scale so the whole diagram is visible inside the box in both
 *                  axes, never enlarging it past its natural size
 *                  (`AUTO_FIT_MAX_UPSCALE`). Narrower than the box whenever the
 *                  diagram is taller than it is wide. The default.
 *  - `actual`    — no scaling at all (mermaid's own intrinsic size), centred.
 *
 * Standard Red Notes — bug fix: `768b9a14` made `fitWidth` the default, and a
 * four-box flowchart then rendered 650px wide and 897px tall inside a 668px note
 * column (measured; see `AUTO_FIT_MAX_UPSCALE`). An un-configured diagram gets
 * `fitBoth` again, so "fit the container" means fit INTO it.
 */
export const MERMAID_FIT_MODES = ['fitWidth', 'fitBoth', 'actual'] as const
export type MermaidFitMode = (typeof MERMAID_FIT_MODES)[number]
export const DEFAULT_MERMAID_FIT_MODE: MermaidFitMode = 'fitBoth'

/** Where a block narrower than the note column sits within it. */
export const MERMAID_ALIGNMENTS = ['left', 'center', 'right'] as const
export type MermaidAlignment = (typeof MERMAID_ALIGNMENTS)[number]
/** `left` is what an un-configured block already rendered as (a plain block). */
export const DEFAULT_MERMAID_ALIGNMENT: MermaidAlignment = 'left'

/**
 * Whether the preview box paints a surface behind the diagram.
 *
 *  - `auto`        — paint NOTHING while the diagram's theme agrees with the
 *                    application's, and paint the diagram's own theme surface
 *                    when it does not. The default, and the only value that is
 *                    right in both cases without the user having to notice.
 *  - `transparent` — never paint. A deliberate override: a diagram pinned to a
 *                    disagreeing theme stays unreadable, which is the user's
 *                    call to make.
 *  - `themed`      — always paint the surface the diagram belongs on (see
 *                    `resolveMermaidSurfaceColor` — for a pinned diagram that is
 *                    its mermaid theme's surface, not the app's).
 *
 * Why `auto` had to exist rather than `themed` becoming the default: a diagram
 * that already agrees with the app does not want a box painted round it — that
 * is a visible rectangle in the middle of a note, on every diagram, forever.
 * The paint is only ever a REPAIR for the disagreeing case, so the setting that
 * says "repair it when it needs repairing" is the one that can be a default.
 *
 * `auto` is listed first because it is the default; `normalizeMermaidBackground`
 * accepts any of the three, so a stored `transparent` or `themed` is kept.
 */
export const MERMAID_BACKGROUNDS = ['auto', 'transparent', 'themed'] as const
export type MermaidBackground = (typeof MERMAID_BACKGROUNDS)[number]
export const DEFAULT_MERMAID_BACKGROUND: MermaidBackground = 'auto'

/** Wheel-zoom / drag-pan / pinch, and the zoom control cluster that drives them. */
export const DEFAULT_MERMAID_ZOOM_PAN = true

/**
 * Split-pane view modes for the block's interactive editor — i.e. whether the
 * mermaid SOURCE is shown beside the rendered diagram. `graphical` shows the
 * form-based flowchart builder instead of the raw code textarea.
 *
 * Lives here, with the other settings, so the toolbar's Mermaid section drives it
 * from the same list as everything else — it is a setting on the node, not a
 * piece of local component state.
 */
export const MERMAID_VIEW_MODES = ['split', 'code', 'preview', 'graphical'] as const
export type MermaidViewMode = (typeof MERMAID_VIEW_MODES)[number]
export const DEFAULT_MERMAID_VIEW_MODE: MermaidViewMode = 'split'

export function normalizeMermaidViewMode(raw: unknown): MermaidViewMode | undefined {
  return typeof raw === 'string' && (MERMAID_VIEW_MODES as readonly string[]).includes(raw)
    ? (raw as MermaidViewMode)
    : undefined
}

/** The sentinel a stored maximum height uses to mean "do not cap the height". */
export const MERMAID_MAX_HEIGHT_NONE = 'none'
export type MermaidMaxHeight = number | typeof MERMAID_MAX_HEIGHT_NONE

/** Bounds for an explicit maximum height, in CSS pixels. */
export const MIN_MERMAID_MAX_HEIGHT_PX = 80
export const MAX_MERMAID_MAX_HEIGHT_PX = 4000

/**
 * The share of the window's height an UN-configured diagram may grow to.
 *
 * Why a window fraction rather than a fixed number or no limit at all:
 *
 * The thing a diagram is being fitted to is its parent container, and that
 * container's WIDTH is definite (the note's content column) while its HEIGHT is
 * not — a note scrolls, so the parent box has no height to fit to. The only
 * honest stand-in for "how tall may this get before it stops being an inline
 * preview" is therefore the visible viewport. At this fraction a diagram may use
 * every pixel of its parent's width whenever doing so still leaves it visible in
 * one screenful, and can never grow so tall that it buries the rest of the note.
 *
 * "No limit" is available as an explicit choice (MERMAID_MAX_HEIGHT_NONE) and is
 * what makes `fitWidth` span the parent's width at ANY aspect ratio — but it is
 * not the default, because a long gantt or sequence diagram fitted to width can
 * legitimately resolve to several thousand pixels of editor.
 */
export const DEFAULT_MERMAID_MAX_HEIGHT_FRACTION = 0.9

/** Fallback window height for a headless/degenerate environment. */
export const FALLBACK_WINDOW_HEIGHT_PX = 800

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * The default maximum height for a diagram that has not configured one: a share
 * of the window's height, clamped into the same bounds an explicit value gets.
 */
export function defaultMermaidMaxHeightPx(windowHeight: unknown): number {
  const height =
    typeof windowHeight === 'number' && Number.isFinite(windowHeight) && windowHeight > 0
      ? windowHeight
      : FALLBACK_WINDOW_HEIGHT_PX
  return clamp(
    Math.round(height * DEFAULT_MERMAID_MAX_HEIGHT_FRACTION),
    MIN_MERMAID_MAX_HEIGHT_PX,
    MAX_MERMAID_MAX_HEIGHT_PX,
  )
}

/**
 * Parse a stored maximum height. Accepts a finite number (clamped into bounds),
 * the `none` sentinel, or a numeric string (what a text field hands over).
 * Anything else is `undefined` — "not configured", i.e. follow the window.
 */
export function normalizeMermaidMaxHeight(raw: unknown): MermaidMaxHeight | undefined {
  if (raw === MERMAID_MAX_HEIGHT_NONE) {
    return MERMAID_MAX_HEIGHT_NONE
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? clamp(Math.round(raw), MIN_MERMAID_MAX_HEIGHT_PX, MAX_MERMAID_MAX_HEIGHT_PX)
      : undefined
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase().replace(/px$/, '')
    if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      return undefined
    }
    const parsed = Number(trimmed)
    return Number.isFinite(parsed)
      ? clamp(Math.round(parsed), MIN_MERMAID_MAX_HEIGHT_PX, MAX_MERMAID_MAX_HEIGHT_PX)
      : undefined
  }
  return undefined
}

/**
 * The maximum height to actually apply, in pixels, or `null` for "no cap".
 * This — not a hardcoded constant — is what bounds the preview box.
 */
export function resolveMermaidMaxHeightPx(stored: unknown, windowHeight: unknown): number | null {
  const normalized = normalizeMermaidMaxHeight(stored)
  if (normalized === MERMAID_MAX_HEIGHT_NONE) {
    return null
  }
  if (typeof normalized === 'number') {
    return normalized
  }
  return defaultMermaidMaxHeightPx(windowHeight)
}

export function normalizeMermaidFitMode(raw: unknown): MermaidFitMode | undefined {
  return typeof raw === 'string' && (MERMAID_FIT_MODES as readonly string[]).includes(raw)
    ? (raw as MermaidFitMode)
    : undefined
}

export function normalizeMermaidAlignment(raw: unknown): MermaidAlignment | undefined {
  return typeof raw === 'string' && (MERMAID_ALIGNMENTS as readonly string[]).includes(raw)
    ? (raw as MermaidAlignment)
    : undefined
}

export function normalizeMermaidThemeMode(raw: unknown): MermaidThemeMode | undefined {
  return typeof raw === 'string' && (MERMAID_THEME_MODES as readonly string[]).includes(raw)
    ? (raw as MermaidThemeMode)
    : undefined
}

export function normalizeMermaidBackground(raw: unknown): MermaidBackground | undefined {
  return typeof raw === 'string' && (MERMAID_BACKGROUNDS as readonly string[]).includes(raw)
    ? (raw as MermaidBackground)
    : undefined
}

export function normalizeMermaidZoomPan(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined
}

/**
 * Perceived luminance via the YIQ formula, the same test
 * `Preferences/.../CustomTheme.ts` already uses to decide whether a theme is a
 * dark one. Accepts the two spellings `getComputedStyle` can hand back for a
 * custom property — a hex literal or an `rgb()` triple — and returns null for
 * anything it cannot read, so the caller can fall back rather than guess.
 */
export function parseCssColorLuminance(value: unknown): number | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text)
  if (hex) {
    const digits = hex[1]
    const expanded =
      digits.length === 3
        ? digits
            .split('')
            .map((character) => character + character)
            .join('')
        : digits
    const r = parseInt(expanded.slice(0, 2), 16)
    const g = parseInt(expanded.slice(2, 4), 16)
    const b = parseInt(expanded.slice(4, 6), 16)
    return (r * 299 + g * 587 + b * 114) / 1000
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(text)
  if (rgb) {
    const r = Number(rgb[1])
    const g = Number(rgb[2])
    const b = Number(rgb[3])
    if ([r, g, b].every((channel) => Number.isFinite(channel))) {
      return (r * 299 + g * 587 + b * 114) / 1000
    }
  }
  return null
}

/** Luminance at or below this counts as a dark surface (as `isDarkColor` does). */
export const DARK_SURFACE_LUMINANCE_THRESHOLD = 128

/**
 * Is the application showing a dark theme? Pure, so the decision is testable
 * without a browser.
 *
 * Precedence: the explicit `--sn-stylekit-theme-type` a theme may declare, then
 * the luminance of `--sn-stylekit-background-color` (which EVERY theme sets, so
 * this is the branch that actually carries the built-in dark themes), then the
 * OS preference.
 */
export function mermaidAppThemeIsDark(input: {
  themeType?: unknown
  backgroundColor?: unknown
  prefersDark?: boolean
}): boolean {
  const declared = typeof input.themeType === 'string' ? input.themeType.trim().toLowerCase() : ''
  if (declared === 'dark') {
    return true
  }
  if (declared === 'light') {
    return false
  }
  const luminance = parseCssColorLuminance(input.backgroundColor)
  if (luminance !== null) {
    return luminance <= DARK_SURFACE_LUMINANCE_THRESHOLD
  }
  return input.prefersDark === true
}

/**
 * The mermaid theme name to hand `mermaid.initialize` for a stored mode.
 *
 * This is the COARSE answer, and it is now only the fallback: see
 * `resolveMermaidRenderTheme`, which uses the application's own palette when it
 * can be read. It stays because an environment with no layout engine (jsdom, or
 * first paint before any stylesheet has applied) has no palette to read, and
 * mermaid's own light/dark pair is the honest answer there.
 */
export function resolveMermaidTheme(mode: unknown, appIsDark: boolean): MermaidBuiltinTheme {
  const normalized = normalizeMermaidThemeMode(mode) ?? DEFAULT_MERMAID_THEME_MODE
  if (normalized === 'app') {
    return appIsDark ? 'dark' : 'default'
  }
  return normalized
}

/**
 * The background colour each of mermaid's built-in themes actually renders
 * against, read out of mermaid 11.16.1 itself rather than guessed — the library
 * reports `white` for `default`/`forest`, which is `#ffffff`.
 *
 * Needed because a diagram PINNED to one of these themes does not follow the
 * application's surface, so "paint the surface behind it" has to mean that
 * theme's surface, not the app's, or the pin is exactly what breaks it.
 */
export const MERMAID_BUILTIN_THEME_BACKGROUNDS: Record<MermaidBuiltinTheme, string> = {
  default: '#ffffff',
  dark: '#333333',
  forest: '#ffffff',
  neutral: '#ffffff',
  base: '#f4f4f4',
}

/** Which of mermaid's built-in themes is a dark one. Only `dark` is. */
export const MERMAID_BUILTIN_THEME_IS_DARK: Record<MermaidBuiltinTheme, boolean> = {
  default: false,
  dark: true,
  forest: false,
  neutral: false,
  base: false,
}

/**
 * The application's own palette, as read from the `--sn-stylekit-*` custom
 * properties on `document.documentElement` — which is where ThemeManager both
 * writes a theme (by attaching its stylesheet) and reads the result back from
 * (`ThemeManager.getBackgroundColor`). Every field is a colour the live cascade
 * resolved, so a third-party or custom theme is covered for free.
 */
export type MermaidAppTokens = {
  /** The surface a diagram sits on. */
  background: string
  /** Body text. */
  foreground: string
  /** One step up from the surface — what a raised box uses. */
  contrastBackground: string
  secondaryBackground: string
  secondaryContrastBackground: string
  border: string
  /** A mid-tone that reads on both polarities; used for edges and grid lines. */
  passive: string
}

/**
 * The application's theme as the diagram needs it: which polarity, and the
 * palette itself when it could be read at all (`null` in jsdom, or before any
 * stylesheet has applied).
 */
export type MermaidAppTheme = {
  isDark: boolean
  tokens: MermaidAppTokens | null
}

/** Is this string something a browser would actually paint? */
export function isUsableCssColor(value: unknown): boolean {
  return parseCssColorLuminance(value) !== null
}

/** Dark, light, or "not a colour I can read". */
export function isDarkMermaidSurface(value: unknown): boolean | null {
  const luminance = parseCssColorLuminance(value)
  return luminance === null ? null : luminance <= DARK_SURFACE_LUMINANCE_THRESHOLD
}

/**
 * The custom properties the palette is read from. Named here so a spec and the
 * reader cannot drift apart.
 */
export const MERMAID_APP_TOKEN_PROPERTIES = {
  themeType: '--sn-stylekit-theme-type',
  background: '--sn-stylekit-background-color',
  foreground: '--sn-stylekit-foreground-color',
  contrastBackground: '--sn-stylekit-contrast-background-color',
  secondaryBackground: '--sn-stylekit-secondary-background-color',
  secondaryContrastBackground: '--sn-stylekit-secondary-contrast-background-color',
  border: '--sn-stylekit-border-color',
  passive: '--sn-stylekit-passive-color-1',
} as const

/**
 * Assemble the application's palette from a property reader. Pure — the reader
 * is `getComputedStyle(document.documentElement).getPropertyValue` in the app
 * and a plain record in a spec.
 *
 * Returns `null` rather than a half-palette whenever the result could not be
 * trusted, and the caller then falls back to mermaid's own coarse light/dark
 * pair — the behaviour that shipped before — so this can never be worse.
 *
 * The POLARITY GUARD is the load-bearing part. A theme stylesheet only
 * overrides the properties it declares, and the base `:root` (this product's
 * dark burgundy palette) stays underneath it, so a theme that declares no
 * `--sn-stylekit-secondary-contrast-background-color` leaves a DARK value
 * readable under a LIGHT theme — Proton is exactly that case, and Midnight,
 * Futura and Proton all leave `--sn-stylekit-passive-color-1` inherited. A
 * surface token whose own darkness disagrees with the theme's is therefore an
 * inherited leftover, not this theme's colour, and is skipped; text is required
 * to be the opposite polarity of the surface for the same reason.
 */
export function buildMermaidAppTokens(read: (property: string) => unknown, isDark: boolean): MermaidAppTokens | null {
  const value = (property: string): string => {
    const raw = read(property)
    return typeof raw === 'string' ? raw.trim() : ''
  }
  /** The first candidate that is a colour AND sits on the theme's own side. */
  const surface = (...properties: readonly string[]): string | null => {
    for (const property of properties) {
      const candidate = value(property)
      if (isDarkMermaidSurface(candidate) === isDark) {
        return candidate
      }
    }
    return null
  }
  /** A line colour legitimately sits on either side, so only usability matters. */
  const line = (...properties: readonly string[]): string | null => {
    for (const property of properties) {
      const candidate = value(property)
      if (isUsableCssColor(candidate)) {
        return candidate
      }
    }
    return null
  }

  const properties = MERMAID_APP_TOKEN_PROPERTIES
  const background = surface(properties.background)
  const foreground = value(properties.foreground)
  const contrastBackground = surface(
    properties.contrastBackground,
    properties.secondaryBackground,
    properties.secondaryContrastBackground,
  )
  if (background === null || contrastBackground === null) {
    return null
  }
  if (isDarkMermaidSurface(foreground) !== !isDark) {
    return null
  }

  return {
    background,
    foreground,
    contrastBackground,
    secondaryBackground: surface(properties.secondaryBackground, properties.contrastBackground) ?? contrastBackground,
    secondaryContrastBackground:
      surface(properties.secondaryContrastBackground, properties.contrastBackground) ?? contrastBackground,
    border: line(properties.border, properties.passive) ?? foreground,
    passive: line(properties.passive, properties.border) ?? foreground,
  }
}

/**
 * Mermaid `themeVariables` derived from the application's own design tokens.
 *
 * Why this exists rather than `theme: 'dark' | 'default'` alone: mermaid's
 * `dark` theme hardcodes its palette and ignores overrides (measured —
 * `mainBkg` stays `#1f2020`, `textColor` stays `#ccc`, and a gantt chart's
 * section bands stay a yellow `hsl(52.9, 28.8%, 58.4%)` and a near-white
 * `#EAE8D9`). Against this product's `#16090f` surface those node boxes have a
 * contrast ratio of 1.19 — they are all but invisible. Mermaid's `base` theme is
 * the one built to DERIVE a palette from what it is given, so `app` mode renders
 * as `base` plus these.
 *
 * The four keys after the core set are mermaid's own residual hardcodes that
 * `base` does NOT derive from `primaryColor`/`background`: without them a dark
 * diagram still gets a `white` alternating gantt band, a `lightgrey` done-task
 * bar under light text, a `lightgrey` grid and a black edge-label box.
 */
export function mermaidAppThemeVariables(tokens: MermaidAppTokens, isDark: boolean): Record<string, string | boolean> {
  return {
    darkMode: isDark,
    background: tokens.background,
    primaryColor: tokens.contrastBackground,
    // The node OUTLINE, and deliberately the mid-tone rather than
    // `--sn-stylekit-border-color`. A node fill is one step off the surface (the
    // app's own convention for a raised box), so the outline is what separates
    // a box from the page, and the border token is tuned for large panels:
    // measured against each theme's own surface it is 1.31 under
    // standard-notes-blue and 1.15 under Midnight — an outline that is not
    // there. The mid-tone measures 6.98 against this product's dark surface and
    // 4.56 against white.
    primaryBorderColor: tokens.passive,
    primaryTextColor: tokens.foreground,
    secondaryColor: tokens.secondaryContrastBackground,
    tertiaryColor: tokens.secondaryBackground,
    textColor: tokens.foreground,
    titleColor: tokens.foreground,
    lineColor: tokens.passive,
    altSectionBkgColor: tokens.secondaryBackground,
    doneTaskBkgColor: tokens.secondaryContrastBackground,
    doneTaskBorderColor: tokens.passive,
    // A grid is SUPPOSED to recede, so this one keeps the subtle border token.
    gridColor: tokens.border,
    edgeLabelBackground: tokens.background,
  }
}

/** What actually reaches `mermaid.initialize` for a diagram. */
export type MermaidRenderTheme = {
  theme: MermaidBuiltinTheme
  /** Absent for a pinned built-in theme, and when no palette could be read. */
  themeVariables?: Record<string, string | boolean>
}

/**
 * THE resolution every render surface goes through: a stored theme mode plus the
 * live application theme, in, and mermaid's own config out.
 *
 * `app` becomes mermaid's `base` theme carrying the application's palette, so
 * node fills, text, edges, clusters and a gantt chart's bands are all the
 * surface the user is actually looking at. A pinned built-in theme is handed
 * through untouched — a deliberate override stays an override.
 */
export function resolveMermaidRenderTheme(mode: unknown, appTheme: MermaidAppTheme): MermaidRenderTheme {
  const normalized = normalizeMermaidThemeMode(mode) ?? DEFAULT_MERMAID_THEME_MODE
  if (normalized !== 'app') {
    return { theme: normalized }
  }
  if (!appTheme.tokens) {
    return { theme: resolveMermaidTheme(normalized, appTheme.isDark) }
  }
  return { theme: 'base', themeVariables: mermaidAppThemeVariables(appTheme.tokens, appTheme.isDark) }
}

/**
 * Does the diagram's resolved theme disagree with the application's polarity?
 * This is the ONE combination a transparent background cannot survive — a light
 * diagram floating on a dark surface, or the reverse — and `app` mode is never
 * in it by construction.
 */
export function mermaidThemeDisagreesWithApp(mode: unknown, appTheme: MermaidAppTheme): boolean {
  const normalized = normalizeMermaidThemeMode(mode) ?? DEFAULT_MERMAID_THEME_MODE
  if (normalized === 'app') {
    return false
  }
  return MERMAID_BUILTIN_THEME_IS_DARK[normalized] !== appTheme.isDark
}

/**
 * The colour the preview box paints behind the diagram, or `undefined` for "paint
 * nothing".
 *
 * `themed` means "the surface this diagram belongs on", which is NOT
 * unconditionally the application's: for a diagram pinned to one of mermaid's
 * own themes it is that theme's background, because painting the app's dark
 * surface behind a diagram pinned to mermaid's light `default` theme is the very
 * thing that made it unreadable.
 *
 * `auto` paints that same surface, but only in the one case a transparent box
 * cannot survive — the diagram's theme disagreeing with the app's. The question
 * "does it disagree" has exactly one implementation,
 * `mermaidThemeDisagreesWithApp` above, and this is one of its callers rather
 * than a second copy of the rule. An `app`-mode diagram is never in
 * disagreement by construction, so `auto` paints nothing for it — which is why
 * `auto` can be the default without putting a visible box round every diagram
 * in the product.
 */
export function resolveMermaidSurfaceColor(
  background: MermaidBackground,
  mode: unknown,
  appTheme: MermaidAppTheme,
): string | undefined {
  if (background === 'transparent') {
    return undefined
  }
  if (background === 'auto' && !mermaidThemeDisagreesWithApp(mode, appTheme)) {
    return undefined
  }
  const normalized = normalizeMermaidThemeMode(mode) ?? DEFAULT_MERMAID_THEME_MODE
  if (normalized === 'app') {
    return appTheme.tokens?.background
  }
  return MERMAID_BUILTIN_THEME_BACKGROUNDS[normalized]
}

/** The app's own surface, as a CSS variable, for a caller that resolved none. */
export const APP_SURFACE_CSS_VAR = 'var(--sn-stylekit-background-color)'

/**
 * The `background` the preview box actually paints, given the setting and
 * whatever colour the caller resolved for it. ONE home for the paint decision,
 * so the box and `resolveMermaidSurfaceColor` cannot disagree about a value.
 *
 * The three cases differ precisely in what "no resolved colour" means:
 *
 *  - `transparent` — never paints, resolved colour or not.
 *  - `themed`      — always paints; with no caller opinion it falls back to the
 *                    app's own surface variable, which is what every caller got
 *                    before the pinned-diagram distinction existed.
 *  - `auto`        — paints EXACTLY what the caller resolved, and nothing when
 *                    the caller resolved nothing. The fallback must not apply
 *                    here: `undefined` from `resolveMermaidSurfaceColor` is the
 *                    deliberate "this diagram already agrees with the app, so
 *                    leave the box empty" answer, and painting the app surface
 *                    over it would put that rectangle back on every diagram.
 */
export function mermaidViewportBackgroundStyle(
  background: MermaidBackground,
  resolvedColor: string | undefined,
): string | undefined {
  if (background === 'transparent') {
    return undefined
  }
  if (background === 'themed') {
    return resolvedColor ?? APP_SURFACE_CSS_VAR
  }
  return resolvedColor
}

/**
 * The first serialized version whose `theme` field could say `app` at all.
 * It was `MERMAID_VERSION` when the mode was introduced and is now a FIXED
 * historical threshold — the current version has moved past it (see
 * FIRST_MERMAID_VERSION_WITH_FIT_BOTH_DEFAULT), and it must not follow, or a
 * deliberate `default` theme saved at version 4 would start being migrated away.
 */
export const FIRST_MERMAID_VERSION_WITH_APP_THEME = 4

/**
 * The theme every version-2/3 build wrote when the user chose nothing.
 * `DEFAULT_MERMAID_THEME` was literally `'default'` then (see
 * `git show 768b9a14:…/MermaidNode.tsx`), and `exportJSON` wrote the field
 * unconditionally.
 */
export const LEGACY_DEFAULT_MERMAID_THEME: MermaidBuiltinTheme = 'default'

/**
 * Translate a stored `theme` field into a theme MODE, which is the one place
 * "an old note keeps its appearance" is traded against "the operator's existing
 * notes never adapt to anything".
 *
 * The problem being solved: a build before version 4 had no `app` mode, and its
 * default was mermaid's own light `default` theme, written into the note whether
 * or not the user ever opened the control. So EVERY diagram authored before this
 * is pinned light, and inside a dark app it is a light chart on a dark page — the
 * every-note breakage the operator reported. A stored value alone cannot tell
 * "the user chose light" from "no build ever asked them".
 *
 * The serialized VERSION can. Below 4 a preference for `app` was inexpressible,
 * so a stored `default` there means "never chose" and becomes `app`; at 4 and
 * above `app` was on offer, so a stored `default` IS a choice and is kept. Every
 * other stored name — `dark`, `forest`, `neutral`, `base` — was never a default,
 * so it is a deliberate choice at any version and is kept at any version.
 */
export function migrateMermaidThemeMode(storedTheme: unknown, storedVersion: unknown): unknown {
  const normalized = normalizeMermaidThemeMode(storedTheme)
  if (normalized !== LEGACY_DEFAULT_MERMAID_THEME) {
    return storedTheme
  }
  const version = typeof storedVersion === 'number' && Number.isFinite(storedVersion) ? storedVersion : 0
  return version >= FIRST_MERMAID_VERSION_WITH_APP_THEME ? storedTheme : DEFAULT_MERMAID_THEME_MODE
}

/**
 * The first serialized version whose `fitMode` field could mean a deliberate
 * choice of `fitWidth` rather than the default of the day. Equals
 * `MERMAID_VERSION` in MermaidNode.tsx, which is where the number is owned.
 */
export const FIRST_MERMAID_VERSION_WITH_FIT_BOTH_DEFAULT = 5

/**
 * The fit mode every version-4 build wrote when the user chose nothing.
 * `DEFAULT_MERMAID_FIT_MODE` was literally `'fitWidth'` then (see
 * `git show 768b9a14:…/MermaidSettings.ts`), and `exportJSON` writes the field
 * unconditionally — so the value is in the note whether or not the user ever
 * opened the control.
 */
export const LEGACY_DEFAULT_MERMAID_FIT_MODE: MermaidFitMode = 'fitWidth'

/**
 * Translate a stored `fitMode` into the mode to actually apply.
 *
 * Standard Red Notes — bug fix, the half of "the chart is rendered way too wide"
 * that a default cannot reach. `768b9a14` made `fitWidth` the default AND
 * `exportJSON` writes `fitMode` unconditionally, so every diagram created or
 * re-saved since then carries `fitWidth` in the note itself. Moving the default
 * back to `fitBoth` therefore fixes nothing the operator is actually looking at:
 * their existing diagrams would keep rendering at 247% because the note says to.
 *
 * This is the same trade `migrateMermaidThemeMode` makes, for the same reason: a
 * stored value alone cannot tell "the user chose to fill the width" from "that
 * was the default and nobody was ever asked". The serialized VERSION can. At
 * version 4 `fitWidth` was the un-chooseable default, so a stored `fitWidth`
 * there means "never chose" and resolves to the new default; from version 5 on
 * it is a deliberate choice and is kept exactly. `fitBoth` and `actual` were
 * never the version-4 default, so both are deliberate at any version.
 */
export function migrateMermaidFitMode(storedFitMode: unknown, storedVersion: unknown): unknown {
  if (normalizeMermaidFitMode(storedFitMode) !== LEGACY_DEFAULT_MERMAID_FIT_MODE) {
    return storedFitMode
  }
  const version = typeof storedVersion === 'number' && Number.isFinite(storedVersion) ? storedVersion : 0
  return version >= FIRST_MERMAID_VERSION_WITH_FIT_BOTH_DEFAULT ? storedFitMode : DEFAULT_MERMAID_FIT_MODE
}

/**
 * The full, resolved configuration of a diagram block. Both surfaces render from
 * this shape, so a control added to one is a control both can show.
 */
export type MermaidSettings = {
  fitMode: MermaidFitMode
  /** `undefined` = follow the window (see DEFAULT_MERMAID_MAX_HEIGHT_FRACTION). */
  maxHeight: MermaidMaxHeight | undefined
  alignment: MermaidAlignment
  themeMode: MermaidThemeMode
  background: MermaidBackground
  zoomPan: boolean
}

/** Every setting at its default — what a diagram with nothing stored resolves to. */
export const DEFAULT_MERMAID_SETTINGS: MermaidSettings = {
  fitMode: DEFAULT_MERMAID_FIT_MODE,
  maxHeight: undefined,
  alignment: DEFAULT_MERMAID_ALIGNMENT,
  themeMode: DEFAULT_MERMAID_THEME_MODE,
  background: DEFAULT_MERMAID_BACKGROUND,
  zoomPan: DEFAULT_MERMAID_ZOOM_PAN,
}

/**
 * Resolve a (possibly partial, possibly hostile) stored record into a complete
 * settings object. An absent or unparseable field becomes its default, so a
 * diagram saved by an older build keeps rendering.
 *
 * BACKWARD COMPATIBILITY lives in ONE place, and it is not here: versions 2 and 3
 * of a serialized diagram stored a bare mermaid theme NAME in `theme`, and version
 * 4 kept that field name and widened its accepted values, so the stored value
 * arrives as `themeMode` with no translation step at all. An existing diagram
 * therefore keeps the theme it was authored with — `MermaidNode.importJSON` hands
 * its `theme` straight in. A second `theme` key here would be an inert layer:
 * removing it would change nothing observable, which is the shape of a guard that
 * cannot be tested.
 */
export function resolveMermaidSettings(stored: {
  fitMode?: unknown
  maxHeight?: unknown
  alignment?: unknown
  themeMode?: unknown
  background?: unknown
  zoomPan?: unknown
}): MermaidSettings {
  return {
    fitMode: normalizeMermaidFitMode(stored.fitMode) ?? DEFAULT_MERMAID_FIT_MODE,
    maxHeight: normalizeMermaidMaxHeight(stored.maxHeight),
    alignment: normalizeMermaidAlignment(stored.alignment) ?? DEFAULT_MERMAID_ALIGNMENT,
    themeMode: normalizeMermaidThemeMode(stored.themeMode) ?? DEFAULT_MERMAID_THEME_MODE,
    background: normalizeMermaidBackground(stored.background) ?? DEFAULT_MERMAID_BACKGROUND,
    zoomPan: normalizeMermaidZoomPan(stored.zoomPan) ?? DEFAULT_MERMAID_ZOOM_PAN,
  }
}

/**
 * The block's own horizontal placement, as inline style. Only meaningful for a
 * block narrower than the column — a full-width block has no slack to move in,
 * which is why this returns the margins rather than a text alignment.
 */
export function mermaidAlignmentStyle(alignment: MermaidAlignment): {
  marginLeft: string | undefined
  marginRight: string | undefined
} {
  if (alignment === 'center') {
    return { marginLeft: 'auto', marginRight: 'auto' }
  }
  if (alignment === 'right') {
    return { marginLeft: 'auto', marginRight: '0' }
  }
  return { marginLeft: undefined, marginRight: undefined }
}

/**
 * Human-readable labels, shared by every control so they cannot drift.
 *
 * The view modes get one too, because `graphical` is a stored VALUE and
 * "Graphical" is not what the control is for. It is the BUILDER, and it sits on
 * the ribbon beside a Build cluster that writes into it; naming it after what it
 * does is the difference between a user finding the visual builder and not.
 */
export const MERMAID_VIEW_MODE_LABELS: Record<MermaidViewMode, string> = {
  split: 'Split',
  code: 'Code',
  preview: 'Preview',
  graphical: 'Builder',
}

export const MERMAID_FIT_MODE_LABELS: Record<MermaidFitMode, string> = {
  fitWidth: 'Fit width',
  fitBoth: 'Fit both',
  actual: 'Actual size',
}

export const MERMAID_ALIGNMENT_LABELS: Record<MermaidAlignment, string> = {
  left: 'Align left',
  center: 'Align centre',
  right: 'Align right',
}

export const MERMAID_THEME_MODE_LABELS: Record<MermaidThemeMode, string> = {
  app: 'App theme',
  default: 'Default',
  dark: 'Dark',
  forest: 'Forest',
  neutral: 'Neutral',
  base: 'Base',
}

export const MERMAID_BACKGROUND_LABELS: Record<MermaidBackground, string> = {
  auto: 'Auto',
  transparent: 'Transparent',
  themed: 'Themed',
}
