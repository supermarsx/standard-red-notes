/**
 * @jest-environment node
 *
 * The shared mermaid-settings module: defaults, normalizers, the maximum-height
 * resolution that replaced the hardcoded 480px cap, and the app-theme decision.
 *
 * Pure arithmetic and string handling only — no DOM, no layout. The RENDERED
 * geometry these numbers produce is measured in real headless Chrome (jsdom has
 * no layout engine, so every dimension there reads 0); this file pins the policy,
 * not the pixels.
 */
import {
  DARK_SURFACE_LUMINANCE_THRESHOLD,
  DEFAULT_MERMAID_ALIGNMENT,
  DEFAULT_MERMAID_BACKGROUND,
  DEFAULT_MERMAID_FIT_MODE,
  DEFAULT_MERMAID_MAX_HEIGHT_FRACTION,
  DEFAULT_MERMAID_SETTINGS,
  DEFAULT_MERMAID_THEME_MODE,
  DEFAULT_MERMAID_VIEW_MODE,
  DEFAULT_MERMAID_ZOOM_PAN,
  defaultMermaidMaxHeightPx,
  FALLBACK_WINDOW_HEIGHT_PX,
  MAX_MERMAID_MAX_HEIGHT_PX,
  MERMAID_ALIGNMENTS,
  MERMAID_BUILTIN_THEMES,
  MERMAID_FIT_MODES,
  MERMAID_MAX_HEIGHT_NONE,
  MERMAID_THEME_MODES,
  MERMAID_VIEW_MODES,
  mermaidAlignmentStyle,
  mermaidAppThemeIsDark,
  MIN_MERMAID_MAX_HEIGHT_PX,
  normalizeMermaidAlignment,
  normalizeMermaidBackground,
  normalizeMermaidFitMode,
  normalizeMermaidMaxHeight,
  normalizeMermaidThemeMode,
  normalizeMermaidViewMode,
  normalizeMermaidZoomPan,
  parseCssColorLuminance,
  resolveMermaidMaxHeightPx,
  resolveMermaidSettings,
  resolveMermaidTheme,
} from './MermaidSettings'

describe('the default settings are the ones the component actually uses', () => {
  it('names a default for every field', () => {
    expect(DEFAULT_MERMAID_SETTINGS).toEqual({
      fitMode: DEFAULT_MERMAID_FIT_MODE,
      maxHeight: undefined,
      alignment: DEFAULT_MERMAID_ALIGNMENT,
      themeMode: DEFAULT_MERMAID_THEME_MODE,
      background: DEFAULT_MERMAID_BACKGROUND,
      zoomPan: DEFAULT_MERMAID_ZOOM_PAN,
    })
  })

  it('fits the WIDTH by default — the fit the user asked for', () => {
    expect(DEFAULT_MERMAID_FIT_MODE).toBe('fitWidth')
  })

  it('follows the APP theme by default, so a dark editor does not get a light chart', () => {
    expect(DEFAULT_MERMAID_THEME_MODE).toBe('app')
  })

  it('leaves the pre-existing appearance alone for the two cosmetic fields', () => {
    // Both of these are what every already-saved diagram rendered as, so turning
    // them into settings changes nothing until the user says so.
    expect(DEFAULT_MERMAID_ALIGNMENT).toBe('left')
    expect(DEFAULT_MERMAID_BACKGROUND).toBe('transparent')
    expect(DEFAULT_MERMAID_ZOOM_PAN).toBe(true)
    expect(DEFAULT_MERMAID_VIEW_MODE).toBe('split')
  })

  it('offers the options the surfaces claim to offer', () => {
    expect(MERMAID_FIT_MODES).toEqual(['fitWidth', 'fitBoth', 'actual'])
    expect(MERMAID_ALIGNMENTS).toEqual(['left', 'center', 'right'])
    expect(MERMAID_VIEW_MODES).toEqual(['split', 'code', 'preview', 'graphical'])
    // Every mermaid built-in, plus the app-following mode, and `app` first.
    expect(MERMAID_THEME_MODES).toEqual(['app', ...MERMAID_BUILTIN_THEMES])
  })
})

describe('the maximum height replaces the hardcoded 480px cap', () => {
  it('defaults to a share of the window, not a constant', () => {
    expect(defaultMermaidMaxHeightPx(1000)).toBe(Math.round(1000 * DEFAULT_MERMAID_MAX_HEIGHT_FRACTION))
    expect(defaultMermaidMaxHeightPx(1000)).not.toBe(defaultMermaidMaxHeightPx(600))
  })

  it('is far more than the old 480 on a normal window, which is the point', () => {
    expect(defaultMermaidMaxHeightPx(1080)).toBeGreaterThan(480)
  })

  it('clamps the window-derived value into the same bounds an explicit one gets', () => {
    expect(defaultMermaidMaxHeightPx(10)).toBe(MIN_MERMAID_MAX_HEIGHT_PX)
    expect(defaultMermaidMaxHeightPx(100000)).toBe(MAX_MERMAID_MAX_HEIGHT_PX)
  })

  it.each([[undefined], [null], [0], [-100], [Number.NaN], [Infinity], ['900'], [{}]])(
    'falls back to a fixed window height for the unusable window height %p',
    (bad) => {
      expect(defaultMermaidMaxHeightPx(bad)).toBe(
        Math.round(FALLBACK_WINDOW_HEIGHT_PX * DEFAULT_MERMAID_MAX_HEIGHT_FRACTION),
      )
    },
  )

  it('resolves "none" to no cap at all', () => {
    expect(resolveMermaidMaxHeightPx(MERMAID_MAX_HEIGHT_NONE, 1000)).toBeNull()
  })

  it('resolves an explicit number to that number', () => {
    expect(resolveMermaidMaxHeightPx(640, 1000)).toBe(640)
  })

  it('resolves an absent setting to the window default', () => {
    expect(resolveMermaidMaxHeightPx(undefined, 1000)).toBe(defaultMermaidMaxHeightPx(1000))
  })

  it('accepts the spellings a text field produces, and rejects the rest', () => {
    expect(normalizeMermaidMaxHeight('640')).toBe(640)
    expect(normalizeMermaidMaxHeight('640px')).toBe(640)
    expect(normalizeMermaidMaxHeight(' 640 ')).toBe(640)
    expect(normalizeMermaidMaxHeight('640.4')).toBe(640)
    expect(normalizeMermaidMaxHeight(MERMAID_MAX_HEIGHT_NONE)).toBe(MERMAID_MAX_HEIGHT_NONE)
    for (const bad of ['auto', '', '  ', '-20', '1e3', '50%', 'none ', null, undefined, {}, [], true, Number.NaN]) {
      expect(normalizeMermaidMaxHeight(bad)).toBeUndefined()
    }
  })

  it('clamps an out-of-range explicit height rather than trusting it', () => {
    expect(normalizeMermaidMaxHeight(1)).toBe(MIN_MERMAID_MAX_HEIGHT_PX)
    expect(normalizeMermaidMaxHeight(999999)).toBe(MAX_MERMAID_MAX_HEIGHT_PX)
    expect(normalizeMermaidMaxHeight('999999')).toBe(MAX_MERMAID_MAX_HEIGHT_PX)
  })
})

describe('each normalizer rejects what it does not recognize', () => {
  it.each([
    [normalizeMermaidFitMode, 'fitBoth'],
    [normalizeMermaidAlignment, 'center'],
    [normalizeMermaidThemeMode, 'forest'],
    [normalizeMermaidBackground, 'themed'],
    [normalizeMermaidViewMode, 'code'],
  ])('accepts a known value and rejects the unknown ones', (normalize, good) => {
    expect((normalize as (value: unknown) => unknown)(good)).toBe(good)
    for (const bad of ['', 'nope', 0, 1, null, undefined, {}, [], true, Number.NaN]) {
      expect((normalize as (value: unknown) => unknown)(bad)).toBeUndefined()
    }
  })

  it('takes only a real boolean for pan/zoom', () => {
    expect(normalizeMermaidZoomPan(true)).toBe(true)
    expect(normalizeMermaidZoomPan(false)).toBe(false)
    for (const bad of ['true', 'false', 0, 1, null, undefined, {}]) {
      expect(normalizeMermaidZoomPan(bad)).toBeUndefined()
    }
  })
})

describe('resolveMermaidSettings — a diagram saved by an older build keeps rendering', () => {
  it('fills in every default for an empty record', () => {
    expect(resolveMermaidSettings({})).toEqual(DEFAULT_MERMAID_SETTINGS)
  })

  it('keeps a stored theme name — the version-2/3 field arrives here untranslated', () => {
    // There is no legacy-field translation step: `MermaidNode.importJSON` hands
    // its stored `theme` straight in as the theme mode, which is what makes an
    // existing diagram keep the theme it was authored with. The node-level proof
    // is in MermaidNodeSerialization.spec.ts.
    expect(resolveMermaidSettings({ themeMode: 'dark' }).themeMode).toBe('dark')
    expect(resolveMermaidSettings({ themeMode: 'default' }).themeMode).toBe('default')
  })

  it('falls back to the new default for an unusable stored theme', () => {
    expect(resolveMermaidSettings({ themeMode: 'chartreuse' }).themeMode).toBe(DEFAULT_MERMAID_THEME_MODE)
    expect(resolveMermaidSettings({}).themeMode).toBe(DEFAULT_MERMAID_THEME_MODE)
  })

  it('never throws, whatever the record holds', () => {
    for (const bad of [null, undefined, 0, '', [], true, () => 'x', { toString: () => 'x' }]) {
      expect(() =>
        resolveMermaidSettings({
          fitMode: bad,
          maxHeight: bad,
          alignment: bad,
          themeMode: bad,
          background: bad,
          zoomPan: bad,
        }),
      ).not.toThrow()
    }
  })
})

describe('the app theme decides what `app` renders as', () => {
  it('uses an explicitly declared theme type first', () => {
    expect(mermaidAppThemeIsDark({ themeType: 'dark', backgroundColor: '#ffffff' })).toBe(true)
    expect(mermaidAppThemeIsDark({ themeType: ' LIGHT ', backgroundColor: '#000000' })).toBe(false)
  })

  it('falls back to the background colour, which every theme sets', () => {
    expect(mermaidAppThemeIsDark({ backgroundColor: '#101010' })).toBe(true)
    expect(mermaidAppThemeIsDark({ backgroundColor: '#ffffff' })).toBe(false)
    expect(mermaidAppThemeIsDark({ backgroundColor: 'rgb(16, 16, 16)' })).toBe(true)
    expect(mermaidAppThemeIsDark({ backgroundColor: 'rgba(255, 255, 255, 1)' })).toBe(false)
    expect(mermaidAppThemeIsDark({ backgroundColor: '#111' })).toBe(true)
  })

  it('falls back to the OS preference when nothing is readable', () => {
    expect(mermaidAppThemeIsDark({ prefersDark: true })).toBe(true)
    expect(mermaidAppThemeIsDark({ prefersDark: false })).toBe(false)
    expect(mermaidAppThemeIsDark({ themeType: '', backgroundColor: 'var(--something)', prefersDark: true })).toBe(true)
    expect(mermaidAppThemeIsDark({})).toBe(false)
  })

  it('reads a luminance only from a colour it understands', () => {
    expect(parseCssColorLuminance('#000000')).toBe(0)
    expect(parseCssColorLuminance('#ffffff')).toBe(255)
    expect(parseCssColorLuminance('rgb(0,0,0)')).toBe(0)
    for (const bad of ['', 'red', 'var(--x)', '#12', '#1234567', null, undefined, 0, {}]) {
      expect(parseCssColorLuminance(bad)).toBeNull()
    }
  })

  it('puts the dark/light boundary where isDarkColor does', () => {
    expect(DARK_SURFACE_LUMINANCE_THRESHOLD).toBe(128)
  })

  it('maps the mode to a real mermaid theme name', () => {
    expect(resolveMermaidTheme('app', true)).toBe('dark')
    expect(resolveMermaidTheme('app', false)).toBe('default')
    expect(resolveMermaidTheme('forest', true)).toBe('forest')
    // An unrecognized stored mode follows the app, like the default does.
    expect(resolveMermaidTheme('chartreuse', true)).toBe('dark')
    expect(resolveMermaidTheme(undefined, false)).toBe('default')
    for (const mode of MERMAID_BUILTIN_THEMES) {
      expect(resolveMermaidTheme(mode, true)).toBe(mode)
    }
  })
})

describe('alignment is expressed as margins, which is what gives a narrow block slack', () => {
  it('leaves a left-aligned block exactly as it rendered before', () => {
    expect(mermaidAlignmentStyle('left')).toEqual({ marginLeft: undefined, marginRight: undefined })
  })

  it('centres and right-aligns with auto margins', () => {
    expect(mermaidAlignmentStyle('center')).toEqual({ marginLeft: 'auto', marginRight: 'auto' })
    expect(mermaidAlignmentStyle('right')).toEqual({ marginLeft: 'auto', marginRight: '0' })
  })
})
