/**
 * Standard Red Notes — contracts for the derived token palette.
 *
 * The whole point of this module is a MEASURED claim: every token class clears
 * WCAG AA against the surface its theme paints. These tests assert that claim
 * against the two real palettes that failed and passed in headless Chrome —
 * this product's own dark base (`packages/styles/src/Styles/_colors.scss`) and
 * the bundled Titanium light theme — using the colours copied from those files.
 *
 * They are not a substitute for the browser measurement, which is in
 * MermaidTokenPalette.ts's header: jsdom resolves no custom properties and
 * computes no cascade, so the READER half is unprovable here. What is provable,
 * and is the half that could silently be wrong, is the arithmetic.
 */
import {
  MERMAID_TOKEN_MIN_CONTRAST,
  MERMAID_TOKEN_PALETTE_PROPERTIES,
  MERMAID_TOKEN_PALETTE_SOURCES,
  adjustForContrast,
  buildMermaidTokenPalette,
  contrastRatio,
  formatRgb,
  mermaidTokenPaletteStyle,
  parseCssRgb,
  relativeLuminance,
  type MermaidColouredTokenType,
  type Rgb,
} from './MermaidTokenPalette'
import { MERMAID_TOKEN_CLASS, MERMAID_TOKEN_TYPES } from './MermaidSyntax'

/** This product's own base palette, verbatim from `_colors.scss`. */
const DARK_THEME: Record<string, string> = {
  '--sn-stylekit-background-color': '#16090f',
  '--sn-stylekit-editor-background-color': '#190b11',
  '--sn-stylekit-foreground-color': '#eadde0',
  '--sn-stylekit-info-color': '#e85f6d',
  '--sn-stylekit-success-color': '#50c49c',
  '--sn-stylekit-warning-color': '#f0b84c',
  '--sn-stylekit-danger-color': '#f4767d',
  '--sn-stylekit-passive-color-0': '#c8afb5',
  '--sn-stylekit-passive-color-1': '#b2939b',
  '--sn-stylekit-accessory-tint-color-1': '#e85f6d',
  '--sn-stylekit-accessory-tint-color-3': '#e5ad46',
  '--sn-stylekit-accessory-tint-color-4': '#aa88e8',
  '--sn-stylekit-accessory-tint-color-5': '#50c49c',
  '--sn-stylekit-accessory-tint-color-6': '#ef8a5c',
}

/**
 * The bundled Titanium theme, verbatim from
 * `src/components/assets/org.standardnotes.theme-titanium/index.css`. This is
 * the palette that measured five classes below AA before the derivation, so it
 * is the one that proves the derivation does something.
 */
const LIGHT_THEME: Record<string, string> = {
  '--sn-stylekit-background-color': '#eeeff1',
  '--sn-stylekit-editor-background-color': '#eeeff1',
  '--sn-stylekit-foreground-color': '#3d3c40',
  '--sn-stylekit-info-color': '#663399',
  '--sn-stylekit-success-color': '#2b9612',
  '--sn-stylekit-warning-color': '#f6a200',
  '--sn-stylekit-danger-color': '#f80324',
  '--sn-stylekit-passive-color-0': '#626166',
  '--sn-stylekit-passive-color-1': '#72767e',
  '--sn-stylekit-accessory-tint-color-1': '#086dd6',
  '--sn-stylekit-accessory-tint-color-3': '#ebad00',
  '--sn-stylekit-accessory-tint-color-4': '#7049cf',
  '--sn-stylekit-accessory-tint-color-5': '#1aa772',
  '--sn-stylekit-accessory-tint-color-6': '#f28c52',
}

const readerFor =
  (theme: Record<string, string>) =>
  (property: string): string =>
    theme[property] ?? ''

const rgbOf = (value: string): Rgb => {
  const parsed = parseCssRgb(value)
  if (!parsed) {
    throw new Error(`not a colour: ${value}`)
  }
  return parsed
}

describe('parseCssRgb', () => {
  it('reads the spellings getComputedStyle hands back', () => {
    expect(parseCssRgb('#abc')).toEqual([170, 187, 204])
    expect(parseCssRgb('#aabbcc')).toEqual([170, 187, 204])
    expect(parseCssRgb('#aabbccdd')).toEqual([170, 187, 204])
    expect(parseCssRgb('rgb(1, 2, 3)')).toEqual([1, 2, 3])
    expect(parseCssRgb('rgba(1, 2, 3, 0.5)')).toEqual([1, 2, 3])
    expect(parseCssRgb('rgb(1 2 3)')).toEqual([1, 2, 3])
    expect(parseCssRgb('  #FFF  ')).toEqual([255, 255, 255])
  })

  it('refuses what it cannot read rather than guessing', () => {
    for (const value of [
      '',
      'transparent',
      'rebeccapurple',
      'var(--x)',
      'color(srgb 0.1 0.2 0.3)',
      'oklch(0.5 0.1 200)',
      'rgb(300, 0, 0)',
      '#12345',
      undefined,
      null,
      42,
    ]) {
      expect(parseCssRgb(value)).toBeNull()
    }
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 5)
    expect(contrastRatio([255, 255, 255], [255, 255, 255])).toBeCloseTo(1, 5)
    // #767676 on white is the canonical "exactly AA" grey.
    expect(contrastRatio(rgbOf('#767676'), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(rgbOf('#777777'), [255, 255, 255])).toBeLessThan(4.5)
  })

  it('is symmetric', () => {
    expect(contrastRatio([10, 20, 30], [200, 210, 220])).toBeCloseTo(contrastRatio([200, 210, 220], [10, 20, 30]), 10)
  })
})

describe('adjustForContrast', () => {
  it('leaves a colour that already clears the minimum completely alone', () => {
    const colour = rgbOf('#e85f6d')
    const background = rgbOf('#16090f')
    expect(contrastRatio(colour, background)).toBeGreaterThanOrEqual(MERMAID_TOKEN_MIN_CONTRAST)
    expect(adjustForContrast(colour, background)).toEqual(colour)
  })

  it('darkens on a light surface and lightens on a dark one', () => {
    const amber = rgbOf('#f6a200')
    const onLight = adjustForContrast(amber, rgbOf('#eeeff1'))
    const onDark = adjustForContrast(amber, rgbOf('#101010'))
    expect(relativeLuminance(onLight)).toBeLessThan(relativeLuminance(amber))
    // On a dark surface this amber already passes, so it must not move at all.
    expect(onDark).toEqual(amber)
  })

  it('reaches the minimum for every token of the light theme that failed', () => {
    const background = rgbOf(LIGHT_THEME['--sn-stylekit-background-color'])
    // The five measured failures, with the ratios headless Chrome reported.
    const failures: [string, number][] = [
      ['#ebad00', 1.74],
      ['#f6a200', 1.81],
      ['#f28c52', 2.11],
      ['#2b9612', 3.33],
      ['#72767e', 3.96],
    ]
    for (const [hex, measured] of failures) {
      const before = contrastRatio(rgbOf(hex), background)
      expect(before).toBeCloseTo(measured, 1)
      expect(before).toBeLessThan(MERMAID_TOKEN_MIN_CONTRAST)
      const after = adjustForContrast(rgbOf(hex), background)
      expect(contrastRatio(after, background)).toBeGreaterThanOrEqual(MERMAID_TOKEN_MIN_CONTRAST)
    }
  })

  it('keeps the hue — a dark amber, not a grey and not a different colour', () => {
    const adjusted = adjustForContrast(rgbOf('#f6a200'), rgbOf('#eeeff1'))
    // Red > green > blue, with blue at zero: still unmistakably amber.
    expect(adjusted[0]).toBeGreaterThan(adjusted[1])
    expect(adjusted[1]).toBeGreaterThan(adjusted[2])
    expect(adjusted[2]).toBe(0)
  })

  it('does not sail past the background to the far side', () => {
    // Moving the WRONG way also reaches a high ratio — by turning a light
    // theme's amber into a near-white one. The adjusted colour must stay on
    // the dark side of the background it is read against.
    const background = rgbOf('#eeeff1')
    const adjusted = adjustForContrast(rgbOf('#f6a200'), background)
    expect(relativeLuminance(adjusted)).toBeLessThan(relativeLuminance(background))
  })

  it('returns the extreme when even black cannot reach the minimum', () => {
    // A mid-grey surface: nothing clears 7:1 against it, so the answer is the
    // best available rather than an exception or the unadjusted colour.
    const adjusted = adjustForContrast(rgbOf('#808080'), rgbOf('#808080'), 7)
    expect(adjusted).toEqual([0, 0, 0])
  })

  it('never produces an out-of-range channel', () => {
    for (const hex of Object.values(LIGHT_THEME).concat(Object.values(DARK_THEME))) {
      const parsed = parseCssRgb(hex)
      if (!parsed) {
        continue
      }
      for (const background of ['#ffffff', '#000000', '#eeeff1', '#16090f']) {
        for (const channel of adjustForContrast(parsed, rgbOf(background))) {
          expect(channel).toBeGreaterThanOrEqual(0)
          expect(channel).toBeLessThanOrEqual(255)
          expect(Number.isInteger(channel)).toBe(true)
        }
      }
    }
  })
})

describe('buildMermaidTokenPalette', () => {
  it('clears AA for EVERY token class on the dark base palette', () => {
    const palette = buildMermaidTokenPalette(readerFor(DARK_THEME))
    expect(palette).not.toBeNull()
    const background = rgbOf(DARK_THEME['--sn-stylekit-editor-background-color'])
    for (const type of Object.keys(MERMAID_TOKEN_PALETTE_SOURCES) as MermaidColouredTokenType[]) {
      const colour = palette?.[type]
      expect(colour).toBeDefined()
      expect(contrastRatio(rgbOf(colour as string), background)).toBeGreaterThanOrEqual(MERMAID_TOKEN_MIN_CONTRAST)
    }
  })

  it('clears AA for EVERY token class on the Titanium light palette', () => {
    const palette = buildMermaidTokenPalette(readerFor(LIGHT_THEME))
    expect(palette).not.toBeNull()
    const background = rgbOf(LIGHT_THEME['--sn-stylekit-editor-background-color'])
    for (const type of Object.keys(MERMAID_TOKEN_PALETTE_SOURCES) as MermaidColouredTokenType[]) {
      const colour = palette?.[type]
      expect(colour).toBeDefined()
      expect(contrastRatio(rgbOf(colour as string), background)).toBeGreaterThanOrEqual(MERMAID_TOKEN_MIN_CONTRAST)
    }
  })

  it('changes NOTHING on the dark palette, which already passed', () => {
    // The derivation must be inert where it is not needed, or it would quietly
    // redesign a palette that was correct.
    const palette = buildMermaidTokenPalette(readerFor(DARK_THEME))
    expect(palette?.keyword).toBe(formatRgb(rgbOf(DARK_THEME['--sn-stylekit-info-color'])))
    expect(palette?.string).toBe(formatRgb(rgbOf(DARK_THEME['--sn-stylekit-success-color'])))
    expect(palette?.number).toBe(formatRgb(rgbOf(DARK_THEME['--sn-stylekit-warning-color'])))
  })

  it('leaves the eight classes visually distinguishable, not collapsed into one', () => {
    // An adjustment that drove everything to black would pass every contrast
    // assertion above and destroy the feature.
    for (const theme of [DARK_THEME, LIGHT_THEME]) {
      const palette = buildMermaidTokenPalette(readerFor(theme))
      const colours = Object.values(palette ?? {})
      expect(colours.length).toBe(8)
      expect(new Set(colours).size).toBeGreaterThanOrEqual(7)
    }
  })

  it('returns null when the surface cannot be read', () => {
    expect(buildMermaidTokenPalette(() => '')).toBeNull()
    expect(buildMermaidTokenPalette(() => undefined)).toBeNull()
    expect(buildMermaidTokenPalette(readerFor({ '--sn-stylekit-info-color': '#fff' }))).toBeNull()
  })

  it('omits only the class whose own token is unreadable', () => {
    const theme = { ...LIGHT_THEME }
    delete theme['--sn-stylekit-success-color']
    delete theme['--sn-stylekit-accessory-tint-color-5']
    const palette = buildMermaidTokenPalette(readerFor(theme))
    expect(palette?.string).toBeUndefined()
    expect(palette?.keyword).toBeDefined()
    expect(Object.keys(palette ?? {})).toHaveLength(7)
  })

  it('falls back to the second source when the first is undeclared', () => {
    const theme = { ...LIGHT_THEME }
    delete theme['--sn-stylekit-accessory-tint-color-3']
    const palette = buildMermaidTokenPalette(readerFor(theme))
    const expected = formatRgb(
      adjustForContrast(
        rgbOf(LIGHT_THEME['--sn-stylekit-warning-color']),
        rgbOf(LIGHT_THEME['--sn-stylekit-background-color']),
      ),
    )
    expect(palette?.directive).toBe(expected)
  })

  it('prefers the EDITOR background, which is the surface the pane sits on', () => {
    const theme = { ...DARK_THEME, '--sn-stylekit-editor-background-color': '#ffffff' }
    const palette = buildMermaidTokenPalette(readerFor(theme))
    // Judged against white, this product's pale passive grey must have moved.
    expect(palette?.comment).not.toBe(formatRgb(rgbOf(DARK_THEME['--sn-stylekit-passive-color-1'])))
    expect(contrastRatio(rgbOf(palette?.comment as string), [255, 255, 255])).toBeGreaterThanOrEqual(
      MERMAID_TOKEN_MIN_CONTRAST,
    )
  })
})

describe('mermaidTokenPaletteStyle', () => {
  it('emits the same custom properties the stylesheet declares', () => {
    const style = mermaidTokenPaletteStyle(buildMermaidTokenPalette(readerFor(LIGHT_THEME))) as unknown as Record<
      string,
      string
    >
    for (const property of Object.values(MERMAID_TOKEN_PALETTE_PROPERTIES)) {
      expect(style[property]).toMatch(/^rgb\(\d+, \d+, \d+\)$/)
    }
  })

  it('is undefined when there is no palette, so the declared defaults win', () => {
    expect(mermaidTokenPaletteStyle(null)).toBeUndefined()
    expect(mermaidTokenPaletteStyle({})).toBeUndefined()
  })
})

describe('the palette and the tokenizer agree about the classes', () => {
  it('covers every coloured token type and no others', () => {
    const coloured = MERMAID_TOKEN_TYPES.filter((type) => type !== 'text')
    expect(Object.keys(MERMAID_TOKEN_PALETTE_SOURCES).sort()).toEqual([...coloured].sort())
    expect(Object.keys(MERMAID_TOKEN_PALETTE_PROPERTIES).sort()).toEqual([...coloured].sort())
  })

  it('names a custom property per class that matches its CSS class', () => {
    for (const type of Object.keys(MERMAID_TOKEN_PALETTE_PROPERTIES) as MermaidColouredTokenType[]) {
      expect(MERMAID_TOKEN_PALETTE_PROPERTIES[type]).toBe(`--srn-mermaid-token-${type}`)
      expect(MERMAID_TOKEN_CLASS[type]).toBe(`MermaidCode__${type}`)
    }
  })

  it('reads only `--sn-stylekit-*` properties — no literal colour anywhere', () => {
    for (const properties of Object.values(MERMAID_TOKEN_PALETTE_SOURCES)) {
      for (const property of properties) {
        expect(property.startsWith('--sn-stylekit-')).toBe(true)
      }
    }
  })
})
