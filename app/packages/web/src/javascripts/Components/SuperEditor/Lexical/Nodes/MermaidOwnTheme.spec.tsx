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

/** Mermaid's reading of each text, as the fake `parse` reports it. */
const CONFIG_IN_TEXT = new Map<string, Record<string, unknown>>([
  [withFrontmatter('forest'), { theme: 'forest' }],
  [withFrontmatter('dark'), { theme: 'dark' }],
  [withFrontmatter('base'), { theme: 'base' }],
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
  it('replaces the app palette, for every theme mermaid ships but `base`', () => {
    for (const theme of MERMAID_LIBRARY_THEMES) {
      const expected =
        theme === 'base'
          ? { ownTheme: undefined, withoutAppPalette: false }
          : { ownTheme: theme, withoutAppPalette: true }
      expect(resolveMermaidOwnTheme(theme, APP_MODE)).toEqual(expected)
    }
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

  it('keeps the app palette, and the bare page, under `theme: base`', async () => {
    await mount(withFrontmatter('base'))
    expect(initializeCalls()).toHaveLength(1)
    expect(lastInitialize().themeVariables).toMatchObject({ background: '#16090f' })
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
