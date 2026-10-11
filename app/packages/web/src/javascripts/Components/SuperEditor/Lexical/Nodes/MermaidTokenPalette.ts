/**
 * Standard Red Notes — the mermaid source pane's token colours, DERIVED from
 * the application's own design tokens so they are legible on whatever surface
 * the user's theme paints.
 *
 *
 * WHY THE RAW TOKENS ARE NOT ENOUGH, with the measurement
 *
 * `Theme/mermaid-code.scss` maps each token class straight to a
 * `--sn-stylekit-*` property, and on this product's own dark base palette that
 * is excellent — every one of the eight clears WCAG AA for normal text with
 * room to spare (measured in headless Chrome against the real
 * `--sn-stylekit-background-color` of `#16090f`: lowest was the keyword at
 * 5.82:1, highest the number at 10.8:1).
 *
 * On a LIGHT theme the same mapping fails, and not marginally. Measured against
 * the bundled Titanium theme (the one asset that declares
 * `--sn-stylekit-theme-type: light`), background `rgb(238,239,241)`:
 *
 *     directive    #ebad00   1.74:1     operator   #f28c52   2.11:1
 *     number       #f6a200   1.81:1     string     #2b9612   3.33:1
 *     comment      #72767e   3.96:1
 *
 * Five of eight below AA, three of them below 2.2:1 — effectively invisible.
 * That is not a bug in the themes: `--sn-stylekit-warning-color` and the
 * accessory tints are the app's FILL colours, sized for a badge or an icon on a
 * light surface, and no amber that is still amber clears 4.5:1 on light grey.
 *
 * So the colours are derived rather than used raw: the theme's token supplies
 * the HUE and the SATURATION, and the lightness is moved — away from the
 * background, never toward it — until the pair clears AA. In a dark theme
 * nothing needs moving and nothing moves, so the measured dark palette above is
 * exactly what still ships; in a light theme the amber becomes a dark amber
 * instead of a pale one. One rule, both polarities, and the user's theme still
 * decides every hue.
 *
 *
 * WHY THIS IS NOT A SECOND PALETTE
 *
 * The derivation reads the live cascade, which is the same source of truth
 * `MermaidAppTheme.ts` already established for a diagram's own colours and the
 * same one `ThemeManager` reads back from: a theme is a stylesheet redefining
 * `--sn-stylekit-*` on `:root`, so a built-in theme, a third-party component
 * theme and a hand-written custom theme are all covered without naming any of
 * them. Nothing here hardcodes a colour. The scss mapping remains as the
 * declared default, which is what paints the pane before this has run, and in
 * any context with no layout engine to read.
 */
import { useEffect, useMemo, useState } from 'react'
import { subscribeToAppThemeSignals } from './MermaidAppTheme'
import type { MermaidTokenType } from './MermaidSyntax'

/** The token types that carry a colour. `text` inherits the pane's own. */
export type MermaidColouredTokenType = Exclude<MermaidTokenType, 'text'>

/**
 * Which design token supplies each class's hue, in order of preference.
 *
 * The six `accessory-tint` properties are the app's CATEGORICAL palette — its
 * tag colours — so every theme already maintains six mutually distinguishable
 * hues. The semantic properties (`info`, `success`, `warning`) are the ones
 * themes maintain for TEXT, used where a token should read as a link or a value
 * rather than a category. `passive-0` and `passive-1` are the app's two
 * de-emphasis greys, which is what a comment and a bracket should be.
 *
 * A second property is listed wherever the first is one a theme may legitimately
 * leave undeclared, so the chain degrades to another real token rather than to
 * nothing.
 */
export const MERMAID_TOKEN_PALETTE_SOURCES: Record<MermaidColouredTokenType, readonly string[]> = {
  comment: ['--sn-stylekit-passive-color-1', '--sn-stylekit-passive-color-0'],
  directive: ['--sn-stylekit-accessory-tint-color-3', '--sn-stylekit-warning-color'],
  keyword: ['--sn-stylekit-info-color', '--sn-stylekit-accessory-tint-color-1'],
  property: ['--sn-stylekit-accessory-tint-color-4', '--sn-stylekit-info-color'],
  string: ['--sn-stylekit-success-color', '--sn-stylekit-accessory-tint-color-5'],
  operator: ['--sn-stylekit-accessory-tint-color-6', '--sn-stylekit-danger-color'],
  punctuation: ['--sn-stylekit-passive-color-0', '--sn-stylekit-passive-color-1'],
  number: ['--sn-stylekit-warning-color', '--sn-stylekit-accessory-tint-color-3'],
}

/** The CSS custom property each class reads, matching `mermaid-code.scss`. */
export const MERMAID_TOKEN_PALETTE_PROPERTIES: Record<MermaidColouredTokenType, string> = {
  comment: '--srn-mermaid-token-comment',
  directive: '--srn-mermaid-token-directive',
  keyword: '--srn-mermaid-token-keyword',
  property: '--srn-mermaid-token-property',
  string: '--srn-mermaid-token-string',
  operator: '--srn-mermaid-token-operator',
  punctuation: '--srn-mermaid-token-punctuation',
  number: '--srn-mermaid-token-number',
}

/** The surface the tokens are judged against, and the text colour's source. */
export const MERMAID_PALETTE_BACKGROUND_PROPERTIES = [
  '--sn-stylekit-editor-background-color',
  '--sn-stylekit-background-color',
] as const

/**
 * WCAG 2.1 AA for normal-size text. The pane's text is 0.875rem, which is not
 * "large" by any definition, so 4.5 is the applicable figure and not 3.
 */
export const MERMAID_TOKEN_MIN_CONTRAST = 4.5

export type Rgb = readonly [number, number, number]

/**
 * Parse a colour into an RGB triple.
 *
 * `MermaidSettings.parseCssColorLuminance` exists and is NOT reused: it returns
 * a single YIQ perceived-brightness number, which is the right instrument for
 * "is this surface dark" and the wrong one here. A contrast ratio needs the
 * WCAG relative luminance, and adjusting a hue needs the channels themselves.
 *
 * Accepts what `getComputedStyle().getPropertyValue()` can hand back for a
 * custom property: a hex literal (3, 4, 6 or 8 digits), an `rgb()`/`rgba()`
 * triple in either the comma or the space syntax, and a bare `transparent`.
 * Anything else — `color(srgb …)`, `oklch()`, a named colour, a `var()` that
 * did not resolve — returns null, and the caller then keeps the declared
 * default rather than guessing.
 */
export function parseCssRgb(value: unknown): Rgb | null {
  if (typeof value !== 'string') {
    return null
  }
  const text = value.trim().toLowerCase()
  if (text === 'transparent') {
    return null
  }
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)
  if (hex) {
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      const expanded = digits
        .slice(0, 3)
        .split('')
        .map((character) => character + character)
        .join('')
      return [
        parseInt(expanded.slice(0, 2), 16),
        parseInt(expanded.slice(2, 4), 16),
        parseInt(expanded.slice(4, 6), 16),
      ]
    }
    if (digits.length === 6 || digits.length === 8) {
      return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)]
    }
    return null
  }
  const rgb = /^rgba?\(\s*([\d.]+)%?[\s,]+([\d.]+)%?[\s,]+([\d.]+)%?/.exec(text)
  if (!rgb) {
    return null
  }
  const channels = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])]
  if (!channels.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 255)) {
    return null
  }
  return [channels[0], channels[1], channels[2]]
}

/** WCAG 2.1 relative luminance. */
export function relativeLuminance(rgb: Rgb): number {
  const linear = rgb.map((channel) => {
    const unit = channel / 255
    return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** WCAG 2.1 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = relativeLuminance(a)
  const second = relativeLuminance(b)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function toHsl(rgb: Rgb): { h: number; s: number; l: number } {
  const [r, g, b] = rgb.map((channel) => channel / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) {
    return { h: 0, s: 0, l }
  }
  const delta = max - min
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let h: number
  if (max === r) {
    h = ((g - b) / delta + (g < b ? 6 : 0)) / 6
  } else if (max === g) {
    h = ((b - r) / delta + 2) / 6
  } else {
    h = ((r - g) / delta + 4) / 6
  }
  return { h, s, l }
}

function hueToChannel(p: number, q: number, t: number): number {
  let shifted = t
  if (shifted < 0) {
    shifted += 1
  }
  if (shifted > 1) {
    shifted -= 1
  }
  if (shifted < 1 / 6) {
    return p + (q - p) * 6 * shifted
  }
  if (shifted < 1 / 2) {
    return q
  }
  if (shifted < 2 / 3) {
    return p + (q - p) * (2 / 3 - shifted) * 6
  }
  return p
}

function fromHsl(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const grey = Math.round(l * 255)
    return [grey, grey, grey]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  return [
    Math.round(hueToChannel(p, q, h + 1 / 3) * 255),
    Math.round(hueToChannel(p, q, h) * 255),
    Math.round(hueToChannel(p, q, h - 1 / 3) * 255),
  ]
}

/**
 * Move a colour's LIGHTNESS — never its hue, never its saturation — until it
 * clears `minimum` against `background`.
 *
 * The direction is away from the background: darker on a light surface, lighter
 * on a dark one. Moving the other way would reach a high ratio too, by sailing
 * past the background to the far side, and would turn a light theme's amber
 * into a near-white one. The search is a 24-step bisection on lightness, which
 * is well inside a byte of precision per channel, and the extreme (black or
 * white) is returned when even that cannot reach the minimum — which is the
 * best any colour can do and still better than the colour it started from.
 *
 * Pure, so the whole derivation is testable with no browser.
 */
export function adjustForContrast(colour: Rgb, background: Rgb, minimum = MERMAID_TOKEN_MIN_CONTRAST): Rgb {
  if (contrastRatio(colour, background) >= minimum) {
    return colour
  }
  const { h, s, l } = toHsl(colour)
  const backgroundIsLight = relativeLuminance(background) > relativeLuminance([0, 0, 0] as const) + 0.18
  // `low`/`high` bracket the lightness: one end is where we are, the other the
  // extreme we are allowed to reach.
  let near = l
  let far = backgroundIsLight ? 0 : 1
  if (contrastRatio(fromHsl(h, s, far), background) < minimum) {
    return fromHsl(h, s, far)
  }
  for (let step = 0; step < 24; step++) {
    const middle = (near + far) / 2
    if (contrastRatio(fromHsl(h, s, middle), background) >= minimum) {
      far = middle
    } else {
      near = middle
    }
  }
  return fromHsl(h, s, far)
}

/** `rgb(r, g, b)`, which is what every engine accepts and what a spec can read back. */
export function formatRgb(rgb: Rgb): string {
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`
}

export type MermaidTokenPalette = Record<MermaidColouredTokenType, string>

/**
 * Build the palette from a property reader.
 *
 * Pure: the reader is `getComputedStyle(document.documentElement).getPropertyValue`
 * in the app and a plain record in a spec.
 *
 * Returns null when the SURFACE cannot be read, because every decision here is
 * relative to it and a palette judged against a guessed background is worse
 * than the declared default. A single unreadable TOKEN is different: that one
 * class is omitted from the result and keeps its declared default, so one
 * missing property in one theme costs one colour and not the feature.
 */
export function buildMermaidTokenPalette(
  read: (property: string) => unknown,
  minimum = MERMAID_TOKEN_MIN_CONTRAST,
): Partial<MermaidTokenPalette> | null {
  const value = (property: string): string => {
    const raw = read(property)
    return typeof raw === 'string' ? raw.trim() : ''
  }
  let background: Rgb | null = null
  for (const property of MERMAID_PALETTE_BACKGROUND_PROPERTIES) {
    background = parseCssRgb(value(property))
    if (background) {
      break
    }
  }
  if (!background) {
    return null
  }
  const palette: Partial<MermaidTokenPalette> = {}
  for (const [type, properties] of Object.entries(MERMAID_TOKEN_PALETTE_SOURCES) as [
    MermaidColouredTokenType,
    readonly string[],
  ][]) {
    for (const property of properties) {
      const source = parseCssRgb(value(property))
      if (source) {
        palette[type] = formatRgb(adjustForContrast(source, background, minimum))
        break
      }
    }
  }
  return palette
}

/**
 * The palette as an inline style object: the same `--srn-mermaid-token-*`
 * properties `mermaid-code.scss` declares, so setting them on the underlay
 * overrides the declared defaults for that element and nothing else.
 */
export function mermaidTokenPaletteStyle(
  palette: Partial<MermaidTokenPalette> | null,
): React.CSSProperties | undefined {
  if (!palette) {
    return undefined
  }
  const style: Record<string, string> = {}
  for (const [type, colour] of Object.entries(palette) as [MermaidColouredTokenType, string][]) {
    style[MERMAID_TOKEN_PALETTE_PROPERTIES[type]] = colour
  }
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined
}

/** Read the live cascade. Impure by definition; every decision is delegated above. */
export function readMermaidTokenPalette(): Partial<MermaidTokenPalette> | null {
  if (
    typeof window === 'undefined' ||
    typeof document === 'undefined' ||
    typeof window.getComputedStyle !== 'function'
  ) {
    return null
  }
  const styles = window.getComputedStyle(document.documentElement)
  return buildMermaidTokenPalette((property) => styles.getPropertyValue(property))
}

/**
 * The palette, kept live.
 *
 * Subscribes through `subscribeToAppThemeSignals` — the same subscription the
 * diagram's own colours use, and the only one that works: a theme switch is a
 * `<link>` appearing in or disappearing from `<head>`, which changes no
 * attribute on `<html>` and so is invisible to a MutationObserver on it. See
 * MermaidAppTheme.ts for the full account.
 *
 * The result is compared by its serialised form before being committed, so an
 * unrelated signal costs one `getComputedStyle` and no re-render.
 */
export function useMermaidTokenPalette(enabled: boolean): React.CSSProperties | undefined {
  const [palette, setPalette] = useState<Partial<MermaidTokenPalette> | null>(() => {
    return enabled ? readMermaidTokenPalette() : null
  })

  useEffect(() => {
    if (!enabled) {
      setPalette(null)
      return
    }
    const refresh = (): void => {
      setPalette((previous) => {
        const next = readMermaidTokenPalette()
        return JSON.stringify(previous) === JSON.stringify(next) ? previous : next
      })
    }
    refresh()
    return subscribeToAppThemeSignals(refresh)
  }, [enabled])

  return useMemo(() => mermaidTokenPaletteStyle(palette), [palette])
}
