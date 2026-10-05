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
 *                  needs, up to the configured maximum height. The default.
 *  - `fitBoth`   — scale so the whole diagram is visible inside the box in both
 *                  axes. Narrower than the box whenever the diagram is taller
 *                  than it is wide.
 *  - `actual`    — no scaling at all (mermaid's own intrinsic size), centred.
 */
export const MERMAID_FIT_MODES = ['fitWidth', 'fitBoth', 'actual'] as const
export type MermaidFitMode = (typeof MERMAID_FIT_MODES)[number]
export const DEFAULT_MERMAID_FIT_MODE: MermaidFitMode = 'fitWidth'

/** Where a block narrower than the note column sits within it. */
export const MERMAID_ALIGNMENTS = ['left', 'center', 'right'] as const
export type MermaidAlignment = (typeof MERMAID_ALIGNMENTS)[number]
/** `left` is what an un-configured block already rendered as (a plain block). */
export const DEFAULT_MERMAID_ALIGNMENT: MermaidAlignment = 'left'

/**
 * Whether the preview box paints a background. `transparent` is what every
 * existing diagram already rendered as; `themed` paints the editor's own surface
 * colour behind the diagram, which is what makes a light mermaid theme legible
 * inside a dark app theme (and vice versa).
 */
export const MERMAID_BACKGROUNDS = ['transparent', 'themed'] as const
export type MermaidBackground = (typeof MERMAID_BACKGROUNDS)[number]
export const DEFAULT_MERMAID_BACKGROUND: MermaidBackground = 'transparent'

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

/** The mermaid theme name to hand `mermaid.initialize` for a stored mode. */
export function resolveMermaidTheme(mode: unknown, appIsDark: boolean): MermaidBuiltinTheme {
  const normalized = normalizeMermaidThemeMode(mode) ?? DEFAULT_MERMAID_THEME_MODE
  if (normalized === 'app') {
    return appIsDark ? 'dark' : 'default'
  }
  return normalized
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

/** Human-readable labels, shared by every control so they cannot drift. */
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
  transparent: 'Transparent',
  themed: 'Themed',
}
