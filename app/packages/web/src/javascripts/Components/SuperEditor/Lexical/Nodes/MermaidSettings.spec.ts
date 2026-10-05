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
  buildMermaidAppTokens,
  FIRST_MERMAID_VERSION_WITH_APP_THEME,
  isDarkMermaidSurface,
  isUsableCssColor,
  LEGACY_DEFAULT_MERMAID_THEME,
  MERMAID_APP_TOKEN_PROPERTIES,
  MERMAID_BUILTIN_THEME_BACKGROUNDS,
  MERMAID_BUILTIN_THEME_IS_DARK,
  mermaidAppThemeVariables,
  mermaidThemeDisagreesWithApp,
  migrateMermaidThemeMode,
  resolveMermaidRenderTheme,
  resolveMermaidSurfaceColor,
  APP_SURFACE_CSS_VAR,
  MERMAID_BACKGROUND_LABELS,
  MERMAID_BACKGROUNDS,
  mermaidViewportBackgroundStyle,
  type MermaidAppTheme,
  type MermaidAppTokens,
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

  it('leaves the pre-existing appearance alone where it was not the bug', () => {
    // Each of these is what every already-saved diagram rendered as, so turning
    // them into settings changes nothing until the user says so.
    expect(DEFAULT_MERMAID_ALIGNMENT).toBe('left')
    expect(DEFAULT_MERMAID_ZOOM_PAN).toBe(true)
    expect(DEFAULT_MERMAID_VIEW_MODE).toBe('split')
  })

  it('does NOT leave the background alone, because transparent WAS the bug', () => {
    // This default deliberately moved (t122). "What every saved diagram already
    // rendered as" was the right instinct for alignment and pan/zoom, where the
    // old behaviour was merely a behaviour; for the background it was the
    // remaining broken case — a diagram pinned to a theme that disagrees with
    // the app, on a transparent box, measures 1.40-1.54 contrast in real Chrome,
    // which is unreadable rather than merely unchanged.
    //
    // `auto` is a default that CAN move safely because it paints nothing for a
    // diagram that agrees with the app, i.e. it is invisible except where the
    // old value was unreadable. And nothing is migrated: a stored value still
    // wins (see MermaidNodeSerialization.spec.ts), so this changes only the
    // diagrams that never had one — which, since `background` did not exist as
    // a serialized field before version 4, is every diagram authored before it.
    expect(DEFAULT_MERMAID_BACKGROUND).toBe('auto')
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

/*
 * ---------------------------------------------------------------------------
 * Following the APP's theme, not mermaid's idea of light and dark.
 *
 * The operator's report was that diagrams do not adapt to the current theme
 * "overall". Three separable things were wrong; the two that are pure policy are
 * pinned here, and the third — WHEN the app theme is re-read — is a live-DOM
 * question, proved in MermaidAppTheme.spec.tsx against a real MermaidNode. The
 * rendered colours are measured in real headless Chrome; this file pins which
 * colour is chosen, not how it looks.
 * ---------------------------------------------------------------------------
 */

/** The dark burgundy base palette this product ships with no theme installed. */
const STANDARD_RED: Record<string, string> = {
  [MERMAID_APP_TOKEN_PROPERTIES.themeType]: 'dark',
  [MERMAID_APP_TOKEN_PROPERTIES.background]: '#16090f',
  [MERMAID_APP_TOKEN_PROPERTIES.foreground]: '#eadde0',
  [MERMAID_APP_TOKEN_PROPERTIES.contrastBackground]: '#241019',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryBackground]: '#200c14',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryContrastBackground]: '#321520',
  [MERMAID_APP_TOKEN_PROPERTIES.border]: '#94636f',
  [MERMAID_APP_TOKEN_PROPERTIES.passive]: '#b2939b',
}

/** The real standard-notes-blue theme's own values. */
const BLUE: Record<string, string> = {
  [MERMAID_APP_TOKEN_PROPERTIES.themeType]: 'light',
  [MERMAID_APP_TOKEN_PROPERTIES.background]: '#ffffff',
  [MERMAID_APP_TOKEN_PROPERTIES.foreground]: '#19191c',
  [MERMAID_APP_TOKEN_PROPERTIES.contrastBackground]: 'rgba(244, 245, 247, 1)',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryBackground]: '#eeeff1',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryContrastBackground]: '#e3e3e3',
  [MERMAID_APP_TOKEN_PROPERTIES.border]: '#dfe1e4',
  [MERMAID_APP_TOKEN_PROPERTIES.passive]: '#72767e',
}

const readerFor =
  (palette: Record<string, string>) =>
  (property: string): string =>
    palette[property] ?? ''

const DARK_APP: MermaidAppTheme = { isDark: true, tokens: buildMermaidAppTokens(readerFor(STANDARD_RED), true) }
const LIGHT_APP: MermaidAppTheme = { isDark: false, tokens: buildMermaidAppTokens(readerFor(BLUE), false) }
const UNREADABLE_DARK: MermaidAppTheme = { isDark: true, tokens: null }
const UNREADABLE_LIGHT: MermaidAppTheme = { isDark: false, tokens: null }

describe('the application palette is assembled from the stylekit tokens', () => {
  it('reads every token of this product own dark palette', () => {
    expect(DARK_APP.tokens).toEqual<MermaidAppTokens>({
      background: '#16090f',
      foreground: '#eadde0',
      contrastBackground: '#241019',
      secondaryBackground: '#200c14',
      secondaryContrastBackground: '#321520',
      border: '#94636f',
      passive: '#b2939b',
    })
  })

  it('accepts the rgba() spelling a theme may use', () => {
    expect(LIGHT_APP.tokens?.contrastBackground).toBe('rgba(244, 245, 247, 1)')
  })

  it('SKIPS a surface token whose polarity disagrees with the theme', () => {
    // Proton declares no --sn-stylekit-secondary-contrast-background-color, so a
    // LIGHT Proton leaves this product's DARK #321520 readable underneath it. A
    // chart drawn with that would put a near-black band on a white page.
    const leaking = { ...BLUE, [MERMAID_APP_TOKEN_PROPERTIES.secondaryContrastBackground]: '#321520' }
    const tokens = buildMermaidAppTokens(readerFor(leaking), false)
    expect(tokens?.secondaryContrastBackground).not.toBe('#321520')
    // It falls back to the raised surface this theme DOES declare.
    expect(tokens?.secondaryContrastBackground).toBe('rgba(244, 245, 247, 1)')
  })

  it('falls back through the other raised surfaces for a missing one', () => {
    const noContrast = { ...BLUE, [MERMAID_APP_TOKEN_PROPERTIES.contrastBackground]: '' }
    expect(buildMermaidAppTokens(readerFor(noContrast), false)?.contrastBackground).toBe('#eeeff1')
  })

  it('gives up entirely rather than hand back half a palette', () => {
    // No readable surface at all — jsdom, or first paint. The caller then uses
    // mermaid's own coarse pair, which is what shipped before.
    expect(buildMermaidAppTokens(() => '', true)).toBeNull()
    // A background whose polarity contradicts the decision it produced.
    expect(buildMermaidAppTokens(readerFor(BLUE), true)).toBeNull()
    // Text that is not the opposite polarity of the surface: invisible.
    const washedOut = { ...STANDARD_RED, [MERMAID_APP_TOKEN_PROPERTIES.foreground]: '#120709' }
    expect(buildMermaidAppTokens(readerFor(washedOut), true)).toBeNull()
  })

  it('names the properties it reads, so a spec and the reader cannot drift', () => {
    expect(MERMAID_APP_TOKEN_PROPERTIES.background).toBe('--sn-stylekit-background-color')
    expect(MERMAID_APP_TOKEN_PROPERTIES.themeType).toBe('--sn-stylekit-theme-type')
  })

  it('reports darkness only for a colour it can read', () => {
    expect(isDarkMermaidSurface('#16090f')).toBe(true)
    expect(isDarkMermaidSurface('#ffffff')).toBe(false)
    expect(isDarkMermaidSurface('var(--x)')).toBeNull()
    expect(isUsableCssColor('#16090f')).toBe(true)
    expect(isUsableCssColor('')).toBe(false)
  })
})

describe('what actually reaches mermaid.initialize', () => {
  it('renders the app mode as mermaid base carrying the APP palette', () => {
    const resolved = resolveMermaidRenderTheme('app', DARK_APP)
    // `base` and not `dark`: mermaid's own dark theme hardcodes its palette and
    // ignores overrides, so `dark` could never be this product's colours.
    expect(resolved.theme).toBe('base')
    expect(resolved.themeVariables).toMatchObject({
      darkMode: true,
      background: '#16090f',
      primaryColor: '#241019',
      primaryTextColor: '#eadde0',
      textColor: '#eadde0',
    })
  })

  it('carries the LIGHT palette under a light theme', () => {
    const resolved = resolveMermaidRenderTheme('app', LIGHT_APP)
    expect(resolved.theme).toBe('base')
    expect(resolved.themeVariables).toMatchObject({ darkMode: false, background: '#ffffff', textColor: '#19191c' })
  })

  it('hands a PINNED built-in theme through untouched, with no overrides', () => {
    for (const mode of MERMAID_BUILTIN_THEMES) {
      expect(resolveMermaidRenderTheme(mode, DARK_APP)).toEqual({ theme: mode })
    }
  })

  it('falls back to mermaid own coarse pair when no palette can be read', () => {
    expect(resolveMermaidRenderTheme('app', UNREADABLE_DARK)).toEqual({ theme: 'dark' })
    expect(resolveMermaidRenderTheme('app', UNREADABLE_LIGHT)).toEqual({ theme: 'default' })
  })

  it('treats an unusable stored mode as the app mode, like the default does', () => {
    expect(resolveMermaidRenderTheme('chartreuse', UNREADABLE_DARK)).toEqual({ theme: 'dark' })
    expect(resolveMermaidRenderTheme(undefined, UNREADABLE_LIGHT)).toEqual({ theme: 'default' })
  })

  it('overrides the keys mermaid base does NOT derive', () => {
    // Without these four, a dark diagram still gets `white` alternating gantt
    // bands, a `lightgrey` done-task bar under light text, a `lightgrey` grid
    // and a black edge-label box — measured against mermaid 11.16.1.
    const variables = mermaidAppThemeVariables(DARK_APP.tokens as MermaidAppTokens, true)
    expect(variables.altSectionBkgColor).toBe('#200c14')
    expect(variables.doneTaskBkgColor).toBe('#321520')
    expect(variables.gridColor).toBe('#94636f')
    expect(variables.edgeLabelBackground).toBe('#16090f')
  })

  it('outlines a node with the mid-tone, not the panel border', () => {
    // The fill is one step off the surface, so the OUTLINE is what separates a
    // box from the page. Measured against each theme's own surface, the border
    // token is 1.31 under standard-notes-blue and 1.15 under Midnight.
    const variables = mermaidAppThemeVariables(LIGHT_APP.tokens as MermaidAppTokens, false)
    expect(variables.primaryBorderColor).toBe('#72767e')
    expect(variables.primaryBorderColor).not.toBe('#dfe1e4')
    expect(variables.lineColor).toBe('#72767e')
  })
})

describe('the preview box background has to agree with the diagram, not the app', () => {
  it('paints nothing when the setting says transparent', () => {
    expect(resolveMermaidSurfaceColor('transparent', 'app', DARK_APP)).toBeUndefined()
    expect(resolveMermaidSurfaceColor('transparent', 'default', DARK_APP)).toBeUndefined()
  })

  it('paints the APP surface for a diagram that follows the app', () => {
    expect(resolveMermaidSurfaceColor('themed', 'app', DARK_APP)).toBe('#16090f')
    expect(resolveMermaidSurfaceColor('themed', 'app', LIGHT_APP)).toBe('#ffffff')
  })

  it('paints the DIAGRAM theme surface for a pinned diagram', () => {
    // The whole point: painting the app's dark surface behind a diagram pinned
    // to mermaid's light `default` is the thing that made it unreadable.
    expect(resolveMermaidSurfaceColor('themed', 'default', DARK_APP)).toBe('#ffffff')
    expect(resolveMermaidSurfaceColor('themed', 'dark', LIGHT_APP)).toBe('#333333')
    for (const mode of MERMAID_BUILTIN_THEMES) {
      expect(resolveMermaidSurfaceColor('themed', mode, DARK_APP)).toBe(MERMAID_BUILTIN_THEME_BACKGROUNDS[mode])
    }
  })

  it('has nothing to paint when the app palette is unreadable', () => {
    expect(resolveMermaidSurfaceColor('themed', 'app', UNREADABLE_DARK)).toBeUndefined()
  })

  it('knows which pin disagrees with the app, and that the app mode never can', () => {
    expect(mermaidThemeDisagreesWithApp('default', DARK_APP)).toBe(true)
    expect(mermaidThemeDisagreesWithApp('dark', DARK_APP)).toBe(false)
    expect(mermaidThemeDisagreesWithApp('dark', LIGHT_APP)).toBe(true)
    expect(mermaidThemeDisagreesWithApp('app', DARK_APP)).toBe(false)
    expect(mermaidThemeDisagreesWithApp('app', LIGHT_APP)).toBe(false)
  })

  /*
   * `auto` — the default, and the value that closes the last broken case: a
   * diagram PINNED to a theme that disagrees with the app, on a transparent box,
   * measured at 1.40-1.54 contrast in headless Chrome. It paints only in that
   * case, which is what lets it be a default: a diagram that already agrees with
   * the app gets no box drawn round it.
   */
  it('paints nothing for auto while the diagram agrees with the app', () => {
    // `app` mode can never disagree, by construction.
    expect(resolveMermaidSurfaceColor('auto', 'app', DARK_APP)).toBeUndefined()
    expect(resolveMermaidSurfaceColor('auto', 'app', LIGHT_APP)).toBeUndefined()
    // A pin that happens to AGREE is equally fine left alone.
    expect(resolveMermaidSurfaceColor('auto', 'dark', DARK_APP)).toBeUndefined()
    expect(resolveMermaidSurfaceColor('auto', 'default', LIGHT_APP)).toBeUndefined()
  })

  it('paints the diagram theme surface for auto exactly when the pin disagrees', () => {
    expect(resolveMermaidSurfaceColor('auto', 'default', DARK_APP)).toBe('#ffffff')
    expect(resolveMermaidSurfaceColor('auto', 'dark', LIGHT_APP)).toBe('#333333')
    // Which is the same surface `themed` would paint for that pin — `auto` is
    // the same repair, applied only when it is needed.
    for (const mode of MERMAID_BUILTIN_THEMES) {
      for (const app of [DARK_APP, LIGHT_APP]) {
        const auto = resolveMermaidSurfaceColor('auto', mode, app)
        expect([mode, app.isDark, auto]).toEqual([
          mode,
          app.isDark,
          mermaidThemeDisagreesWithApp(mode, app) ? resolveMermaidSurfaceColor('themed', mode, app) : undefined,
        ])
      }
    }
  })

  it('leaves an explicit transparent override alone in every combination', () => {
    // The whole contract: a user who chose `transparent` keeps it, including in
    // the disagreeing case `auto` exists to repair.
    for (const mode of [...MERMAID_BUILTIN_THEMES, 'app']) {
      for (const app of [DARK_APP, LIGHT_APP, UNREADABLE_DARK, UNREADABLE_LIGHT]) {
        expect([mode, resolveMermaidSurfaceColor('transparent', mode, app)]).toEqual([mode, undefined])
      }
    }
  })

  it('has nothing to paint for auto when the app palette is unreadable', () => {
    // No palette means no polarity to disagree with, so nothing is repaired
    // rather than something being guessed.
    expect(resolveMermaidSurfaceColor('auto', 'app', UNREADABLE_DARK)).toBeUndefined()
    // A pin still resolves, because its surface comes from mermaid's own table.
    expect(resolveMermaidSurfaceColor('auto', 'default', UNREADABLE_DARK)).toBe('#ffffff')
  })

  /*
   * The PAINT decision, which is where the three values differ in how they treat
   * "the caller resolved no colour".
   */
  it('turns a setting plus a resolved colour into the box background', () => {
    expect(mermaidViewportBackgroundStyle('transparent', undefined)).toBeUndefined()
    expect(mermaidViewportBackgroundStyle('transparent', '#ffffff')).toBeUndefined()
    // `themed` invents the app surface when the caller has no opinion...
    expect(mermaidViewportBackgroundStyle('themed', undefined)).toBe(APP_SURFACE_CSS_VAR)
    expect(mermaidViewportBackgroundStyle('themed', '#333333')).toBe('#333333')
    // ...and `auto` must NOT, or every agreeing diagram gets a box.
    expect(mermaidViewportBackgroundStyle('auto', undefined)).toBeUndefined()
    expect(mermaidViewportBackgroundStyle('auto', '#ffffff')).toBe('#ffffff')
  })

  it('declares auto as the default, and keeps the other two expressible', () => {
    expect(DEFAULT_MERMAID_BACKGROUND).toBe('auto')
    expect(MERMAID_BACKGROUNDS).toContain(DEFAULT_MERMAID_BACKGROUND)
    // `transparent` stays a value a user can hold and choose.
    expect(MERMAID_BACKGROUNDS).toContain('transparent')
    expect(MERMAID_BACKGROUNDS).toContain('themed')
    // Every value is normalizable and labelled, so none can reach a surface
    // unvalidated or render as a blank option.
    for (const value of MERMAID_BACKGROUNDS) {
      expect(normalizeMermaidBackground(value)).toBe(value)
      expect(MERMAID_BACKGROUND_LABELS[value].length).toBeGreaterThan(0)
    }
    expect(Object.keys(MERMAID_BACKGROUND_LABELS).sort()).toEqual([...MERMAID_BACKGROUNDS].sort())
  })

  it('records mermaid own background per built-in theme', () => {
    expect(MERMAID_BUILTIN_THEME_BACKGROUNDS).toEqual({
      default: '#ffffff',
      dark: '#333333',
      forest: '#ffffff',
      neutral: '#ffffff',
      base: '#f4f4f4',
    })
    expect(MERMAID_BUILTIN_THEME_IS_DARK).toEqual({
      default: false,
      dark: true,
      forest: false,
      neutral: false,
      base: false,
    })
  })
})

describe('a diagram authored before the app mode existed must start following the app', () => {
  it('turns the pre-version-4 default into the app mode', () => {
    // THE operator's complaint. Before version 4 the default was literally
    // mermaid's light `default` theme, written into every note whether or not
    // the user ever opened the control, so no existing diagram could adapt.
    expect(LEGACY_DEFAULT_MERMAID_THEME).toBe('default')
    expect(FIRST_MERMAID_VERSION_WITH_APP_THEME).toBe(4)
    expect(migrateMermaidThemeMode('default', 2)).toBe('app')
    expect(migrateMermaidThemeMode('default', 3)).toBe('app')
    // Version 1 stored no theme at all; a hand edit may carry no version.
    expect(migrateMermaidThemeMode('default', 1)).toBe('app')
    expect(migrateMermaidThemeMode('default', undefined)).toBe('app')
  })

  it('keeps `default` once the app mode was on offer — then it IS a choice', () => {
    expect(migrateMermaidThemeMode('default', 4)).toBe('default')
    expect(migrateMermaidThemeMode('default', 5)).toBe('default')
  })

  it('keeps every other stored name at EVERY version — never a default', () => {
    for (const mode of ['dark', 'forest', 'neutral', 'base'] as const) {
      for (const version of [2, 3, 4, 5]) {
        expect(migrateMermaidThemeMode(mode, version)).toBe(mode)
      }
    }
    expect(migrateMermaidThemeMode('app', 4)).toBe('app')
  })

  it('leaves an unrecognizable stored value alone for the normalizer to reject', () => {
    expect(migrateMermaidThemeMode('chartreuse', 2)).toBe('chartreuse')
    expect(migrateMermaidThemeMode(undefined, 2)).toBeUndefined()
    expect(migrateMermaidThemeMode(null, 2)).toBeNull()
    expect(resolveMermaidSettings({ themeMode: migrateMermaidThemeMode('chartreuse', 2) }).themeMode).toBe('app')
  })
})
