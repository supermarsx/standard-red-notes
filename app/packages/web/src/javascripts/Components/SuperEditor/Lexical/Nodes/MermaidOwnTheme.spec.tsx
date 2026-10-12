/**
 * @jest-environment jsdom
 *
 * A diagram that names its own theme is drawn in that theme.
 *
 * Measured in the running app's dark theme before this rule existed (stock
 * Firefox 157, reduced motion on, a `theme: forest` diagram alone in a note):
 * mermaid's own stylesheet gave the labels `#eadde0` — the application's text
 * colour — on Forest's `#cde498` fill, 1.05 to 1, with nothing painted behind
 * the diagram. The app had handed mermaid its whole palette, and mermaid
 * computes a named theme ON TOP of whatever it was handed.
 *
 * The first half of this file is the rule itself, which is pure. The second
 * mounts a REAL MermaidNode in a REAL LexicalComposer and reads the two things
 * the rule decides: what reached `mermaid.initialize` last, and what the preview
 * box painted. Mermaid is faked — it cannot lay anything out in jsdom — so what
 * a text MEANS is supplied by the fake `parse`; that the real library reads
 * these texts this way is `scripts/MermaidContract.mjs`'s business.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode } from './MermaidNode'
import {
  MERMAID_APP_TOKEN_PROPERTIES,
  MERMAID_BUILTIN_THEME_BACKGROUNDS,
  MERMAID_BUILTIN_THEME_IS_DARK,
  MERMAID_BUILTIN_THEMES,
  MERMAID_LIBRARY_THEME_BACKGROUNDS,
  MERMAID_LIBRARY_THEME_IS_DARK,
  MERMAID_LIBRARY_THEMES,
  mermaidThemeDisagreesWithApp,
  normalizeMermaidLibraryTheme,
  normalizeMermaidOwnSurface,
  resolveMermaidDrawnTheme,
  resolveMermaidOwnTheme,
  resolveMermaidSurfaceColor,
  type MermaidAppTheme,
  type MermaidRenderTheme,
  type MermaidThemeMode,
} from './MermaidSettings'

const DIAGRAM_SVG =
  '<svg id="m-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

const BODY = 'flowchart LR\n  A[Alpha] --> B[Beta]'
const withFrontmatter = (theme: string): string => `---\nconfig:\n  theme: ${theme}\n---\n${BODY}`
/** The form mermaid's own theming documentation teaches: `base`, and a colour. */
const BASE_WITH_ITS_OWN_FILL = `---\nconfig:\n  theme: base\n  themeVariables:\n    primaryColor: "#ffcc00"\n---\n${BODY}`
/** `base` made into a dark diagram by its own text. */
const BASE_WITH_A_DARK_PAGE = `---\nconfig:\n  theme: base\n  themeVariables:\n    darkMode: true\n    background: "#1a1a2e"\n---\n${BODY}`
/** Variables with NO theme key: the application's diagram, with larger text. */
const VARIABLES_ONLY = `---\nconfig:\n  themeVariables:\n    fontSize: 20px\n    background: "#ffffff"\n---\n${BODY}`

/** Mermaid's reading of each text, as the fake `parse` reports it. */
const CONFIG_IN_TEXT = new Map<string, Record<string, unknown>>([
  [withFrontmatter('forest'), { theme: 'forest' }],
  [withFrontmatter('dark'), { theme: 'dark' }],
  [withFrontmatter('base'), { theme: 'base' }],
  [BASE_WITH_ITS_OWN_FILL, { theme: 'base', themeVariables: { primaryColor: '#ffcc00' } }],
  [BASE_WITH_A_DARK_PAGE, { theme: 'base', themeVariables: { darkMode: true, background: '#1a1a2e' } }],
  [VARIABLES_ONLY, { themeVariables: { fontSize: '20px', background: '#ffffff' } }],
])

const mermaidInitialize = jest.fn()
const mermaidRender = jest.fn(async () => ({ svg: DIAGRAM_SVG }))
const mermaidParse = jest.fn(async (text: string) => ({
  diagramType: 'flowchart-v2',
  config: CONFIG_IN_TEXT.get(text) ?? {},
}))

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: { reset: () => undefined },
    initialize: (...args: unknown[]) => mermaidInitialize(...(args as [])),
    parse: (text: string) => mermaidParse(text),
    render: (...args: unknown[]) => mermaidRender(...(args as [])),
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The real base palette this product ships with no theme installed: dark. */
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

const TOKENS = {
  background: '#16090f',
  foreground: '#eadde0',
  contrastBackground: '#241019',
  secondaryBackground: '#200c14',
  secondaryContrastBackground: '#321520',
  border: '#94636f',
  passive: '#b2939b',
}
const DARK_APP: MermaidAppTheme = { isDark: true, tokens: TOKENS }
const LIGHT_APP: MermaidAppTheme = {
  isDark: false,
  tokens: { ...TOKENS, background: '#ffffff', foreground: '#19191c' },
}

const APP_MODE: MermaidRenderTheme = { theme: 'base', themeVariables: { primaryColor: '#241019' } }
const PINNED_DARK: MermaidRenderTheme = { theme: 'dark' }

describe('what a theme named in the diagram’s own text means for one render', () => {
  it('replaces the app palette, for every theme mermaid ships — `base` included', () => {
    for (const theme of MERMAID_LIBRARY_THEMES) {
      expect(resolveMermaidOwnTheme(theme, APP_MODE)).toEqual({ ownTheme: theme, withoutAppPalette: true })
    }
    // `base` was the exception once, and it was the same defect with a different
    // fill: the app's near-white text on the diagram's own yellow, 1.15 to 1.
    expect(resolveMermaidOwnTheme('base', APP_MODE).withoutAppPalette).toBe(true)
  })

  it('leaves the block’s theme standing when the text names none', () => {
    expect(resolveMermaidOwnTheme(undefined, APP_MODE)).toEqual({ ownTheme: undefined, withoutAppPalette: false })
  })

  it('treats a name mermaid does not know as no name: mermaid records it and draws the block’s theme', () => {
    for (const unknown of ['nosuch', 'null', 'Forest', '', 7, null, { theme: 'forest' }]) {
      expect(resolveMermaidOwnTheme(unknown, APP_MODE)).toEqual({ ownTheme: undefined, withoutAppPalette: false })
    }
  })

  it('has nothing to withhold from a block that carries no palette, and reports what will be drawn', () => {
    expect(resolveMermaidOwnTheme('forest', PINNED_DARK)).toEqual({ ownTheme: 'forest', withoutAppPalette: false })
    // `base` over a pinned theme is plain `base`: light, and no longer the block's.
    expect(resolveMermaidOwnTheme('base', PINNED_DARK)).toEqual({ ownTheme: 'base', withoutAppPalette: false })
  })
})

describe('the themes a diagram’s text may name', () => {
  it('are the block picker’s five and six more, each with a surface and a polarity', () => {
    expect(MERMAID_LIBRARY_THEMES).toHaveLength(11)
    expect(new Set(MERMAID_LIBRARY_THEMES).size).toBe(11)
    for (const theme of MERMAID_LIBRARY_THEMES) {
      expect(MERMAID_LIBRARY_THEME_BACKGROUNDS[theme]).toMatch(/^#[0-9a-f]{6}$/)
      expect(typeof MERMAID_LIBRARY_THEME_IS_DARK[theme]).toBe('boolean')
      expect(normalizeMermaidLibraryTheme(theme)).toBe(theme)
    }
    for (const theme of MERMAID_BUILTIN_THEMES) {
      expect(MERMAID_LIBRARY_THEME_BACKGROUNDS[theme]).toBe(MERMAID_BUILTIN_THEME_BACKGROUNDS[theme])
      expect(MERMAID_LIBRARY_THEME_IS_DARK[theme]).toBe(MERMAID_BUILTIN_THEME_IS_DARK[theme])
    }
  })

  it('are dark exactly when their surface is', () => {
    for (const theme of MERMAID_LIBRARY_THEMES) {
      expect(MERMAID_LIBRARY_THEME_IS_DARK[theme]).toBe(MERMAID_LIBRARY_THEME_BACKGROUNDS[theme] === '#333333')
    }
  })
})

describe('the surface is decided by the theme the diagram is DRAWN in', () => {
  it('is the diagram’s own theme when its text selected one, otherwise the block’s mode', () => {
    expect(resolveMermaidDrawnTheme('app', 'forest')).toBe('forest')
    expect(resolveMermaidDrawnTheme('dark', 'neo')).toBe('neo')
    expect(resolveMermaidDrawnTheme('app', undefined)).toBe('app')
    expect(resolveMermaidDrawnTheme('neutral', undefined)).toBe('neutral')
    expect(resolveMermaidDrawnTheme('garbage', 'nosuch')).toBe('app')
  })

  it('paints Forest’s page behind a Forest diagram in a dark app, as it does for a block pinned to Forest', () => {
    expect(mermaidThemeDisagreesWithApp('forest', DARK_APP)).toBe(true)
    expect(resolveMermaidSurfaceColor('auto', resolveMermaidDrawnTheme('app', 'forest'), DARK_APP)).toBe('#ffffff')
    expect(resolveMermaidSurfaceColor('auto', 'forest', DARK_APP)).toBe('#ffffff')
  })

  it('knows the six themes the picker does not offer', () => {
    expect(mermaidThemeDisagreesWithApp('neo', DARK_APP)).toBe(true)
    expect(mermaidThemeDisagreesWithApp('neo-dark', DARK_APP)).toBe(false)
    expect(mermaidThemeDisagreesWithApp('redux-dark-color', LIGHT_APP)).toBe(true)
    expect(resolveMermaidSurfaceColor('auto', 'redux', DARK_APP)).toBe('#ffffff')
    expect(resolveMermaidSurfaceColor('auto', 'redux-dark', DARK_APP)).toBeUndefined()
    expect(resolveMermaidSurfaceColor('themed', 'neo-dark', LIGHT_APP)).toBe('#333333')
    expect(resolveMermaidSurfaceColor('transparent', 'neo', DARK_APP)).toBeUndefined()
  })

  it('still treats a name it does not know as the app’s', () => {
    expect(mermaidThemeDisagreesWithApp('nosuch', DARK_APP)).toBe(false)
    expect(resolveMermaidSurfaceColor('themed', 'nosuch', DARK_APP)).toBe('#16090f')
  })
})

describe('a diagram that themes itself can give that theme a page of its own', () => {
  it('paints `base`’s stock page when the text set none', () => {
    expect(resolveMermaidSurfaceColor('auto', 'base', DARK_APP)).toBe('#f4f4f4')
    expect(resolveMermaidSurfaceColor('auto', 'base', DARK_APP, undefined)).toBe('#f4f4f4')
  })

  it('goes by the page the text set, not by the theme’s name: a dark `base` agrees with a dark app', () => {
    // By name `base` is light, and its stock page under a diagram whose text
    // made it dark — light links and all — is light lines on a light page.
    expect(mermaidThemeDisagreesWithApp('base', DARK_APP, '#1a1a2e')).toBe(false)
    expect(resolveMermaidSurfaceColor('auto', 'base', DARK_APP, '#1a1a2e')).toBeUndefined()
    expect(resolveMermaidSurfaceColor('themed', 'base', DARK_APP, '#1a1a2e')).toBe('#1a1a2e')
    expect(mermaidThemeDisagreesWithApp('base', LIGHT_APP, '#1a1a2e')).toBe(true)
    expect(resolveMermaidSurfaceColor('auto', 'base', LIGHT_APP, '#1a1a2e')).toBe('#1a1a2e')
  })

  it('works the other way round for a dark theme given a light page', () => {
    expect(mermaidThemeDisagreesWithApp('dark', DARK_APP)).toBe(false)
    expect(mermaidThemeDisagreesWithApp('dark', DARK_APP, '#ffffff')).toBe(true)
    expect(resolveMermaidSurfaceColor('auto', 'dark', DARK_APP, 'rgb(255, 255, 255)')).toBe('rgb(255, 255, 255)')
  })

  it('never lets an own page speak for a diagram that follows the app', () => {
    expect(mermaidThemeDisagreesWithApp('app', DARK_APP, '#ffffff')).toBe(false)
    expect(resolveMermaidSurfaceColor('themed', 'app', DARK_APP, '#ffffff')).toBe('#16090f')
  })

  it('accepts a hex colour or an rgb() triple, whole, and hands back that and no more', () => {
    expect(normalizeMermaidOwnSurface('#1A1A2E')).toBe('#1a1a2e')
    expect(normalizeMermaidOwnSurface(' #333 ')).toBe('#333')
    expect(normalizeMermaidOwnSurface('rgb(26,26, 46)')).toBe('rgb(26, 26, 46)')
    expect(normalizeMermaidOwnSurface('RGB( 0 , 0 , 0 )')).toBe('rgb(0, 0, 0)')
  })

  /**
   * The value comes out of a diagram's text — in a shared note, somebody
   * else's — and goes into a `background`, a shorthand in which `url(…)` is as
   * valid as a colour. So what is not exactly a colour this reads is refused
   * outright, and the theme's stock page is used instead.
   */
  it.each([
    ['a colour followed by an image', 'rgb(1,2,3) url(favicon.ico)'],
    ['an image', 'url(https://example.invalid/x.png)'],
    ['a hex followed by anything', '#fff url(x)'],
    ['a second declaration', '#fff; background-image: url(x)'],
    ['a channel out of range', 'rgb(256, 0, 0)'],
    ['rgba', 'rgba(0, 0, 0, 0.5)'],
    ['a colour name', 'white'],
    ['hsl', 'hsl(240, 100%, 50%)'],
    ['a var()', 'var(--sn-stylekit-background-color)'],
    ['a hex of the wrong length', '#12345'],
    ['an empty string', ''],
    ['a number', 0x1a1a2e],
    ['an object', { toString: () => '#ffffff' }],
    ['nothing', undefined],
  ])('refuses %s', (_name, value) => {
    expect(normalizeMermaidOwnSurface(value)).toBeUndefined()
    expect(resolveMermaidSurfaceColor('themed', 'base', DARK_APP, value)).toBe('#f4f4f4')
    expect(mermaidThemeDisagreesWithApp('base', DARK_APP, value)).toBe(true)
  })
})

// --- a real MermaidNode -----------------------------------------------------

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const installComputedStyleStub = (): void => {
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    if (element !== document.documentElement) {
      return original(element, pseudo ?? undefined)
    }
    return { getPropertyValue: (property: string) => STANDARD_RED[property] ?? '' } as CSSStyleDeclaration
  }) as typeof window.getComputedStyle
}

const installMatchMediaStub = (): void => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
}

/** Past the component's 400ms render debounce, then flush the microtasks. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 520))
  })
}

let container: HTMLElement | undefined
let root: Root | undefined

function SeedPlugin({ seed }: { seed: () => void }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    editor.update(seed, { discrete: true })
  }, [editor, seed])
  return null
}

const mount = async (code: string, themeMode?: MermaidThemeMode): Promise<void> => {
  const seed = () => {
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('before')), $createMermaidNode(code, themeMode, 'preview'))
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  const mounted = root
  await act(async () => {
    mounted.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'mermaid-own-theme',
            nodes: [MermaidNode],
            onError: (error: Error) => {
              throw error
            },
          },
        },
        createElement(RichTextPlugin, {
          contentEditable: createElement(ContentEditable, { 'aria-label': 'editor' }),
          placeholder: null,
          ErrorBoundary: LexicalErrorBoundary,
        }),
        createElement(SeedPlugin, { seed }),
      ),
    )
  })
  await settle()
}

const initializeCalls = (): Record<string, unknown>[] =>
  mermaidInitialize.mock.calls.map((call) => call[0] as Record<string, unknown>)

const lastInitialize = (): Record<string, unknown> => {
  const calls = initializeCalls()
  if (calls.length === 0) {
    throw new Error('the mounted MermaidNode never configured mermaid')
  }
  return calls[calls.length - 1]
}

const paintedSurface = (): string => {
  const box = document.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement | null
  if (!box) {
    throw new Error('no preview box: the diagram did not render')
  }
  return box.style.background
}

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  installComputedStyleStub()
  installMatchMediaStub()
  // jest.config.js sets `resetMocks: true`, which wipes the IMPLEMENTATION given
  // at module scope, not just the call history.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))
  mermaidInitialize.mockImplementation(() => undefined)
  mermaidParse.mockImplementation(async (text: string) => ({
    diagramType: 'flowchart-v2',
    config: CONFIG_IN_TEXT.get(text) ?? {},
  }))
})

afterEach(() => {
  const mounted = root
  if (mounted) {
    act(() => mounted.unmount())
  }
  root = undefined
  container?.remove()
  container = undefined
})

describe('a real Mermaid block, in the dark app theme', () => {
  it('hands a plain diagram the app palette and paints nothing behind it', async () => {
    await mount(BODY)
    expect(lastInitialize()).toMatchObject({ theme: 'base', themeVariables: { darkMode: true, background: '#16090f' } })
    expect(mermaidParse).not.toHaveBeenCalled()
    expect(paintedSurface()).toBe('')
  })

  it('renders a `theme: forest` diagram WITHOUT the app palette, on Forest’s white page', async () => {
    await mount(withFrontmatter('forest'))
    // Configured twice: as the block asked, so mermaid could read the text under
    // the app's own rules, then again without the palette, which is what it
    // drew with.
    expect(initializeCalls().map((config) => config.themeVariables !== undefined)).toEqual([true, false])
    expect(lastInitialize().themeVariables).toBeUndefined()
    expect(mermaidRender).toHaveBeenCalledTimes(1)
    expect(paintedSurface()).toBe('rgb(255, 255, 255)')
  })

  it('paints nothing behind a dark theme the text names: it agrees with the app', async () => {
    await mount(withFrontmatter('dark'))
    expect(lastInitialize().themeVariables).toBeUndefined()
    expect(paintedSurface()).toBe('')
  })

  /**
   * THE case this rule was widened for. Measured in the running app before:
   * `theme: base` with `primaryColor: "#ffcc00"` — the form mermaid's theming
   * documentation teaches — drew the app's `rgb(234, 221, 224)` text on that
   * yellow, 1.15 to 1, because `base` was the one theme still handed the app's
   * palette.
   */
  it('renders `theme: base` with its own fill WITHOUT the app palette, on `base`’s page', async () => {
    await mount(BASE_WITH_ITS_OWN_FILL)
    expect(initializeCalls().map((config) => config.themeVariables !== undefined)).toEqual([true, false])
    expect(lastInitialize()).toMatchObject({ theme: 'base', themeVariables: undefined })
    expect(paintedSurface()).toBe('rgb(244, 244, 244)')
  })

  it('does the same for `theme: base` alone: the rule is the theme key, with no exception', async () => {
    await mount(withFrontmatter('base'))
    expect(lastInitialize().themeVariables).toBeUndefined()
    expect(paintedSurface()).toBe('rgb(244, 244, 244)')
  })

  it('paints nothing behind a `base` diagram whose own text made it dark', async () => {
    await mount(BASE_WITH_A_DARK_PAGE)
    expect(lastInitialize().themeVariables).toBeUndefined()
    // Its page is `#1a1a2e`, which agrees with the dark app. `base`'s stock
    // `#f4f4f4` here would sit under the light links mermaid draws for it.
    expect(paintedSurface()).toBe('')
  })

  it('leaves a diagram that only sets variables — no theme — exactly as the app’s', async () => {
    await mount(VARIABLES_ONLY)
    expect(initializeCalls()).toHaveLength(1)
    expect(lastInitialize().themeVariables).toMatchObject({ darkMode: true, background: '#16090f' })
    // Its `background: "#ffffff"` decides nothing: without a theme of its own
    // the diagram is still the application's, on the application's page.
    expect(paintedSurface()).toBe('')
  })

  it('paints Forest’s page even when the BLOCK is pinned to a theme that agrees with the app', async () => {
    await mount(withFrontmatter('forest'), 'dark')
    // The block says Dark, the app is dark, and by the stored mode alone nothing
    // would be painted — under a diagram mermaid drew in Forest.
    expect(lastInitialize()).toMatchObject({ theme: 'dark', themeVariables: undefined })
    expect(paintedSurface()).toBe('rgb(255, 255, 255)')
  })
})
