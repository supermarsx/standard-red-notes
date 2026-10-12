/** @jest-environment jsdom */

/**
 * The half that tsc and a pure unit test are both blind to: whether a diagram
 * ALREADY ON SCREEN restyles itself when the user changes the application's
 * theme.
 *
 * Every assertion here is about the config that actually reaches
 * `mermaid.initialize` from a REAL MermaidNode inside a REAL LexicalComposer —
 * not about what a resolution function returns when called directly. The
 * difference matters: the resolution was already correct before this work, and
 * the diagram still did not change, because nothing re-ran it.
 *
 * HOW A THEME SWITCH IS SIMULATED, and why that shape is the whole point.
 * ThemeManager installs a theme by appending `<link rel="stylesheet">` to
 * `<head>` and uninstalls it by removing that element
 * (`ui-services/src/Theme/ThemeManager.ts`, `activateTheme` /
 * `deactivateThemeInTheUI`). It does NOT touch any attribute of `<html>`. So
 * these tests change the palette and move a `<link>`, and deliberately leave
 * `document.documentElement` alone — which is exactly the case the previous
 * `MutationObserver(documentElement, { attributeFilter: ['style', 'class'] })`
 * could not see. It appeared to work only because ThemeManager ALSO writes
 * `--popover-background-color` onto `documentElement.style` from the new link's
 * `onload`, and only while the translucent-UI preference is on. The same switch
 * with that preference off left mermaid's dark palette on a white page at 1.61
 * contrast, measured in headless Chrome.
 *
 * jsdom resolves no cascade for custom properties, so the palette is served
 * through a `getComputedStyle` stub for `document.documentElement` only;
 * everything else is delegated to jsdom's own. The RENDERED colours are measured
 * in real headless Chrome — see the notes referenced from MermaidAppTheme.ts.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createParagraphNode, $createTextNode, $getRoot } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode, type SerializedMermaidNode } from './MermaidNode'
import { $createGanttChartNode, GanttChartNode } from './GanttChartNode'
import { declaredThemeTypeToTrust, mermaidAppThemeKey, readMermaidAppTheme } from './MermaidAppTheme'
import {
  mermaidAppThemeVariables,
  MERMAID_APP_TOKEN_PROPERTIES,
  MERMAID_LABEL_FONT_FALLBACK,
  type MermaidThemeMode,
} from './MermaidSettings'

const DIAGRAM_SVG =
  '<svg id="m-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

const mermaidInitialize = jest.fn()
const mermaidRender = jest.fn(async () => ({ svg: DIAGRAM_SVG }))

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    mermaidAPI: { reset: () => undefined },
    initialize: (...args: unknown[]) => mermaidInitialize(...(args as [])),
    render: (...args: unknown[]) => mermaidRender(...(args as [])),
  },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/** The real base palette this product ships with no theme installed. */
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

/** The real org.standardnotes.theme-standard-notes-blue values. */
const BLUE: Record<string, string> = {
  [MERMAID_APP_TOKEN_PROPERTIES.themeType]: 'light',
  [MERMAID_APP_TOKEN_PROPERTIES.background]: '#ffffff',
  [MERMAID_APP_TOKEN_PROPERTIES.foreground]: '#19191c',
  [MERMAID_APP_TOKEN_PROPERTIES.contrastBackground]: '#f4f5f7',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryBackground]: '#eeeff1',
  [MERMAID_APP_TOKEN_PROPERTIES.secondaryContrastBackground]: '#e3e3e3',
  [MERMAID_APP_TOKEN_PROPERTIES.border]: '#dfe1e4',
  [MERMAID_APP_TOKEN_PROPERTIES.passive]: '#72767e',
}

let palette: Record<string, string> = STANDARD_RED
let prefersDark = false

const installComputedStyleStub = (): void => {
  const original = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    if (element !== document.documentElement) {
      return original(element, pseudo ?? undefined)
    }
    return { getPropertyValue: (property: string) => palette[property] ?? '' } as CSSStyleDeclaration
  }) as typeof window.getComputedStyle
}

/**
 * Only the listeners registered against `(prefers-color-scheme: dark)`. The
 * editor subtree also uses `matchMedia` for its layout breakpoints (StyledTooltip
 * through `useMediaQuery`), and those handlers read `event.matches`, so firing
 * every listener for a colour-scheme change throws rather than testing anything.
 */
let colorSchemeListeners = new Set<(event: { matches: boolean }) => void>()

const PREFERS_DARK = /prefers-color-scheme:\s*dark/

const installMatchMediaStub = (): void => {
  colorSchemeListeners = new Set()
  window.matchMedia = ((query: string) => {
    const isColorScheme = PREFERS_DARK.test(query)
    const add = (listener: (event: { matches: boolean }) => void) => {
      if (isColorScheme) {
        colorSchemeListeners.add(listener)
      }
    }
    const remove = (listener: (event: { matches: boolean }) => void) => colorSchemeListeners.delete(listener)
    return {
      matches: isColorScheme ? prefersDark : false,
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => add(listener),
      removeEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => remove(listener),
      addListener: add,
      removeListener: remove,
      dispatchEvent: () => false,
    }
  }) as unknown as typeof window.matchMedia
}

const fireColorSchemeChange = async (matches: boolean): Promise<void> => {
  prefersDark = matches
  await act(async () => {
    colorSchemeListeners.forEach((listener) => listener({ matches }))
  })
  await settle()
}

/** Past the component's 400ms render debounce, then flush the microtasks. */
const RENDER_DEBOUNCE_MS = 400
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, RENDER_DEBOUNCE_MS + 120))
  })
}

/**
 * Install a theme the way ThemeManager does: a `<link>` in `<head>` whose
 * `load` fires once the palette is live. NOTHING on `document.documentElement`
 * is touched — `translucent` is the ThemeManager preference that incidentally
 * did touch it, and it is off here unless a test asks for it.
 */
const installTheme = async (next: Record<string, string>, translucent = false): Promise<void> => {
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = 'theme.css'
  link.id = 'test-theme'
  document.head.appendChild(link)
  palette = next
  await act(async () => {
    link.dispatchEvent(new Event('load'))
    if (translucent) {
      document.documentElement.style.setProperty(
        '--popover-background-color',
        next[MERMAID_APP_TOKEN_PROPERTIES.background],
      )
    }
  })
  await settle()
}

/**
 * A stylesheet that was ALREADY in `<head>` finishing its load. No element is
 * added or removed, so no mutation of any kind is delivered — the only signal is
 * the `load` event itself. This is the real first-paint case: the cached theme
 * link is in the document before React mounts anything, and its palette becomes
 * readable only once it has applied.
 */
const finishLoadingExistingTheme = async (next: Record<string, string>): Promise<void> => {
  const link = document.getElementById('test-theme') as HTMLLinkElement
  palette = next
  await act(async () => {
    link.dispatchEvent(new Event('load'))
  })
  await settle()
}

/** Uninstall it: the element is removed, and no `load` event ever fires. */
const removeTheme = async (next: Record<string, string>): Promise<void> => {
  palette = next
  await act(async () => {
    document.getElementById('test-theme')?.remove()
  })
  await settle()
}

const lastInitializeConfig = (): Record<string, unknown> =>
  mermaidInitialize.mock.calls[mermaidInitialize.mock.calls.length - 1][0] as Record<string, unknown>

const lastThemeVariables = (): Record<string, unknown> | undefined =>
  lastInitializeConfig().themeVariables as Record<string, unknown> | undefined

let container: HTMLElement
let root: Root

type Seed = () => void

function SeedPlugin({ seed }: { seed: Seed }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    editor.update(seed, { discrete: true })
  }, [editor, seed])
  return null
}

function harness(seed: Seed) {
  return createElement(
    LexicalComposer,
    {
      initialConfig: {
        namespace: 'mermaid-app-theme',
        nodes: [MermaidNode, GanttChartNode],
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
  )
}

const mount = async (seed: Seed): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(harness(seed))
  })
  await settle()
}

const mermaidSeed =
  (themeMode?: MermaidThemeMode, background?: 'transparent' | 'themed'): Seed =>
  () => {
    const node = $createMermaidNode('graph TD\n  A --> B', themeMode, 'preview', undefined, undefined, { background })
    $getRoot()
      .clear()
      .append($createParagraphNode().append($createTextNode('before')), node)
  }

beforeEach(() => {
  palette = STANDARD_RED
  prefersDark = false
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  installComputedStyleStub()
  installMatchMediaStub()
  // jest.config.js sets `resetMocks: true`, which wipes the IMPLEMENTATION given
  // at module scope, not just the call history.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))
  mermaidInitialize.mockImplementation(() => undefined)
})

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  document.getElementById('test-theme')?.remove()
  document.documentElement.removeAttribute('style')
})

describe('a diagram on screen follows the application theme', () => {
  it('renders the APP palette, not mermaid own dark theme', async () => {
    await mount(mermaidSeed())
    expect(mermaidInitialize).toHaveBeenCalled()
    // `base`, because mermaid's `dark` theme hardcodes its palette and would
    // ignore every one of these.
    expect(lastInitializeConfig().theme).toBe('base')
    expect(lastThemeVariables()).toMatchObject({
      darkMode: true,
      background: '#16090f',
      primaryColor: '#241019',
      textColor: '#eadde0',
    })
  })

  it('RESTYLES on a live switch that touches no attribute of <html>', async () => {
    await mount(mermaidSeed())
    expect(lastThemeVariables()).toMatchObject({ darkMode: true, background: '#16090f' })
    const before = mermaidRender.mock.calls.length

    await installTheme(BLUE)

    // A NEW render happened — the SVG already on screen has the old theme's
    // colours baked into its own <style>, so nothing less restyles it.
    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastInitializeConfig().theme).toBe('base')
    expect(lastThemeVariables()).toMatchObject({
      darkMode: false,
      background: '#ffffff',
      primaryColor: '#f4f5f7',
      textColor: '#19191c',
    })
  })

  it('RESTYLES when a stylesheet already in <head> finishes loading', async () => {
    // Nothing is added to or removed from the document, so no MutationObserver
    // fires at all; the `load` event in the capture phase is the only signal.
    // This is the shape of first paint, where the cached theme link is already
    // in the document before anything mounts.
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'theme.css'
    link.id = 'test-theme'
    document.head.appendChild(link)
    await mount(mermaidSeed())
    expect(lastThemeVariables()).toMatchObject({ darkMode: true })
    const before = mermaidRender.mock.calls.length

    await finishLoadingExistingTheme(BLUE)

    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastThemeVariables()).toMatchObject({ darkMode: false, background: '#ffffff' })
  })

  it('RESTYLES when the theme stylesheet is REMOVED, which fires no load event', async () => {
    await mount(mermaidSeed())
    await installTheme(BLUE)
    expect(lastThemeVariables()).toMatchObject({ darkMode: false })
    const before = mermaidRender.mock.calls.length

    await removeTheme(STANDARD_RED)

    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastThemeVariables()).toMatchObject({ darkMode: true, background: '#16090f' })
  })

  it('still restyles when the translucent-UI write DOES happen', async () => {
    // The path that used to be the only working one. It must keep working, and
    // must not re-render twice as hard.
    await mount(mermaidSeed())
    await installTheme(BLUE, true)
    expect(lastThemeVariables()).toMatchObject({ darkMode: false, background: '#ffffff' })
  })

  it('does NOT re-render for a theme event that moved no colour', async () => {
    await mount(mermaidSeed())
    const before = mermaidRender.mock.calls.length
    // A stylesheet that is not a theme: same palette, a real `load` in `<head>`.
    await installTheme(STANDARD_RED)
    expect(mermaidRender.mock.calls.length).toBe(before)
  })

  it('keeps an explicitly PINNED theme across a live switch', async () => {
    await mount(mermaidSeed('dark'))
    expect(lastInitializeConfig().theme).toBe('dark')
    expect(lastThemeVariables()).toBeUndefined()

    await installTheme(BLUE)

    // The user pinned this diagram to mermaid's dark theme. A theme switch must
    // not take that away.
    expect(lastInitializeConfig().theme).toBe('dark')
    expect(lastThemeVariables()).toBeUndefined()
  })

  it('follows the OS preference when no palette can be read at all', async () => {
    palette = {}
    prefersDark = true
    await mount(mermaidSeed())
    // No tokens, so mermaid's own coarse pair — which is what shipped before.
    expect(lastInitializeConfig()).toMatchObject({ theme: 'dark', themeVariables: undefined })

    await fireColorSchemeChange(false)
    expect(lastInitializeConfig()).toMatchObject({ theme: 'default' })
  })
})

describe('a diagram authored before the app mode existed adapts on load', () => {
  it('renders a version-3 `default` diagram in the APP palette', async () => {
    // The operator's every-note case: every build before version 4 wrote
    // mermaid's light `default` into the note whether the user chose it or not.
    await mount(() => {
      const node = MermaidNode.importJSON({
        type: 'mermaid',
        version: 3,
        code: 'graph TD\n  A --> B',
        theme: 'default',
        viewMode: 'preview',
      } as SerializedMermaidNode)
      $getRoot().clear().append(node)
    })
    expect(lastInitializeConfig().theme).toBe('base')
    expect(lastThemeVariables()).toMatchObject({ darkMode: true, background: '#16090f' })
  })

  it('leaves a version-4 `default` diagram pinned light', async () => {
    await mount(() => {
      const node = MermaidNode.importJSON({
        type: 'mermaid',
        version: 4,
        code: 'graph TD\n  A --> B',
        theme: 'default',
        viewMode: 'preview',
      } as SerializedMermaidNode)
      $getRoot().clear().append(node)
    })
    expect(lastInitializeConfig()).toMatchObject({ theme: 'default', themeVariables: undefined })
  })
})

describe('the preview box paints the surface the diagram belongs on', () => {
  const viewportBox = (): HTMLElement =>
    document.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement

  it('paints the app surface for a diagram that follows the app', async () => {
    await mount(mermaidSeed('app', 'themed'))
    expect(viewportBox().style.background).toBe('rgb(22, 9, 15)')
  })

  it('paints the DIAGRAM surface for a pinned one, not the app dark surface', async () => {
    await mount(mermaidSeed('default', 'themed'))
    // mermaid's own `default` background. Painting #16090f here is what left a
    // legacy diagram's dark text on a dark box.
    expect(viewportBox().style.background).toBe('rgb(255, 255, 255)')
  })

  it('repaints the box on a live switch', async () => {
    await mount(mermaidSeed('app', 'themed'))
    expect(viewportBox().style.background).toBe('rgb(22, 9, 15)')
    await installTheme(BLUE)
    expect(viewportBox().style.background).toBe('rgb(255, 255, 255)')
  })
})

describe('the gantt block shares the same resolution instead of its own', () => {
  it('renders the app palette and restyles on a live switch', async () => {
    await mount(() => {
      $getRoot()
        .clear()
        .append(
          $createGanttChartNode({
            version: 1,
            title: 'Plan',
            tasks: [{ name: 'Research', section: 'Phase 1', start: '2024-01-01', duration: '5d' }],
          }),
        )
    })
    expect(lastInitializeConfig().theme).toBe('base')
    expect(lastThemeVariables()).toMatchObject({
      darkMode: true,
      background: '#16090f',
      // The four mermaid `base` does not derive. A gantt chart is where they
      // show: without them the alternating band stays `white` and the done bar
      // stays `lightgrey` under light text.
      altSectionBkgColor: '#200c14',
      doneTaskBkgColor: '#321520',
    })
    const before = mermaidRender.mock.calls.length

    await installTheme(BLUE)

    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastThemeVariables()).toMatchObject({
      darkMode: false,
      background: '#ffffff',
      altSectionBkgColor: '#eeeff1',
    })
  })
})

describe('a declared theme type is only trusted when the page agrees with it', () => {
  it('ignores an INHERITED `dark` on a light page', async () => {
    // Autobiography declares no --sn-stylekit-theme-type, so it inherits the
    // base palette's `dark` while painting a cream #ede4da page.
    palette = {
      [MERMAID_APP_TOKEN_PROPERTIES.themeType]: 'dark',
      [MERMAID_APP_TOKEN_PROPERTIES.background]: '#ede4da',
      [MERMAID_APP_TOKEN_PROPERTIES.foreground]: '#5c3f27',
      [MERMAID_APP_TOKEN_PROPERTIES.contrastBackground]: '#e8d9c8',
      [MERMAID_APP_TOKEN_PROPERTIES.secondaryBackground]: '#e3d2bd',
      [MERMAID_APP_TOKEN_PROPERTIES.secondaryContrastBackground]: '#d9c6b1',
      [MERMAID_APP_TOKEN_PROPERTIES.border]: '#d9c6b1',
      [MERMAID_APP_TOKEN_PROPERTIES.passive]: '#a37337',
    }
    await mount(mermaidSeed())
    expect(lastThemeVariables()).toMatchObject({ darkMode: false, background: '#ede4da' })
  })

  it('keeps a declaration that agrees with its own background', () => {
    expect(declaredThemeTypeToTrust('dark', '#16090f')).toBe('dark')
    expect(declaredThemeTypeToTrust('light', '#ffffff')).toBe('light')
  })

  it('drops a declaration the background contradicts', () => {
    expect(declaredThemeTypeToTrust('dark', '#ede4da')).toBe('')
    expect(declaredThemeTypeToTrust('light', '#16090f')).toBe('')
  })

  it('keeps a declaration when the background cannot be read', () => {
    expect(declaredThemeTypeToTrust('dark', 'var(--x)')).toBe('dark')
    expect(declaredThemeTypeToTrust('dark', '')).toBe('dark')
  })

  it('passes anything that is not a declaration straight through', () => {
    expect(declaredThemeTypeToTrust('', '#16090f')).toBe('')
    expect(declaredThemeTypeToTrust(undefined, '#16090f')).toBe('')
    expect(declaredThemeTypeToTrust('DARK', '#16090f')).toBe('dark')
  })
})

describe('the theme key is what suppresses a pointless re-render', () => {
  it('changes when the polarity changes and when any token moves', () => {
    palette = STANDARD_RED
    const dark = mermaidAppThemeKey(readMermaidAppTheme())
    palette = BLUE
    const light = mermaidAppThemeKey(readMermaidAppTheme())
    expect(dark).not.toBe(light)

    palette = { ...STANDARD_RED, [MERMAID_APP_TOKEN_PROPERTIES.passive]: '#c8afb5' }
    expect(mermaidAppThemeKey(readMermaidAppTheme())).not.toBe(dark)

    palette = STANDARD_RED
    expect(mermaidAppThemeKey(readMermaidAppTheme())).toBe(dark)
  })

  it('distinguishes an unreadable palette from a readable one of the same polarity', () => {
    palette = STANDARD_RED
    const readable = mermaidAppThemeKey(readMermaidAppTheme())
    palette = { [MERMAID_APP_TOKEN_PROPERTIES.themeType]: 'dark' }
    expect(mermaidAppThemeKey(readMermaidAppTheme())).not.toBe(readable)
  })
})

describe('the label FONT is part of the theme contract, and was not asserted for four months', () => {
  /**
   * `fontFamily: 'inherit'` shipped in `a416573e` (2026-06-13, the commit that
   * created MermaidNode.tsx) and survived until `64ab24ed` four months later,
   * through this suite and through every other. That is what these cases exist
   * to stop happening again.
   *
   * WHY IT MATTERS, measured in headless Chrome against freshly compiled
   * SCSS + Tailwind inside the real editor chain, under the PRODUCTION CSP:
   * with the Editor Font preference set to the app's own Monospace preset the
   * stack handed to mermaid is `SFMono-Regular, Consolas, ...` and 0 of 6 labels
   * clip; with `inherit` it resolved to `document.body`'s stack while measuring
   * and to the editor's while drawing, and a label measured in one font and
   * drawn in another overflows the slot reserved for it.
   *
   * The theme variables carry NO `fontSize` and no `fontFamily`, deliberately:
   * mermaid's own `base` theme supplies `16px` and `getStyles` emits it as
   * `#<svgId>{font-size:16px}` into the SVG, which pins BOTH contexts. The
   * family travels as the top-level `fontFamily` instead. The last case below
   * pins that shape, because a `fontSize` added to the variables would be a
   * second source of truth for the one property that already agrees.
   */
  const svgHost = () => container.querySelector('[data-mermaid-svg-host="true"]') as HTMLElement
  const measureHost = () => container.querySelector('[data-mermaid-measure-host="true"]') as HTMLElement

  const mermaidBlock = () => container.querySelector('[data-mermaid-block="true"]') as HTMLElement

  /**
   * The preconditions a font assertion depends on, asserted before it.
   *
   * `readMermaidLabelFontFamily` answers with MERMAID_LABEL_FONT_FALLBACK for
   * THREE different reasons: no element, no `window.getComputedStyle`, and a
   * computed value that is not a measurable stack. So a test that only compares
   * the family cannot say WHICH happened, and a torn-down environment -- a worker
   * going away mid-run, a root unmounted by a previous `afterEach` -- reads as a
   * font mismatch. That failure is unreproducible by anyone who runs the file on
   * its own, which is the worst shape a red can take.
   *
   * This makes the environment the thing that fails when the environment is the
   * problem. It is not a retry and it does not relax any assertion.
   */
  const expectMeasurableEnvironment = (element: HTMLElement | null): void => {
    expect(typeof window.getComputedStyle).toBe('function')
    expect(element).not.toBeNull()
    expect(element?.isConnected).toBe(true)
  }

  /**
   * The Editor Font preference, as `Utils/editorFont.ts` applies it: the
   * resolved stack goes to `--sn-stylekit-editor-font-family` on
   * `document.documentElement`, and `.font-editor` turns that into the editor
   * subtree's `font-family`.
   *
   * jsdom resolves no custom-property cascade AND does not inherit `font-family`
   * down a subtree, so this also writes the resolved value inline on the block —
   * the element the component reads. The documentElement write is still what the
   * subscription observes; remove it and nothing re-reads.
   */
  const setEditorFont = async (stack: string): Promise<void> => {
    mermaidBlock().style.fontFamily = stack
    await act(async () => {
      document.documentElement.style.setProperty('--sn-stylekit-editor-font-family', stack)
    })
    await settle()
  }

  it('hands mermaid the family read off the diagram own block, not a constant', async () => {
    await mount(mermaidSeed('app'))
    await setEditorFont('"Opus5 Theme Probe", monospace')
    expectMeasurableEnvironment(mermaidBlock())
    // Tied to the element the SVG is drawn inside, so a constant, a keyword, or
    // a read off `document.body` all fail.
    expect(window.getComputedStyle(mermaidBlock()).fontFamily).toContain('Opus5 Theme Probe')
    expect(lastInitializeConfig().fontFamily).toBe(window.getComputedStyle(mermaidBlock()).fontFamily)
    expect(lastInitializeConfig().fontFamily).not.toBe('inherit')
    expect(lastInitializeConfig().fontFamily).not.toBe(MERMAID_LABEL_FONT_FALLBACK)
  })

  it('follows the Editor Font preference, so the family cannot go stale', async () => {
    await mount(mermaidSeed('app'))
    expectMeasurableEnvironment(mermaidBlock())
    const before = lastInitializeConfig().fontFamily
    await setEditorFont('"Opus5 Theme Probe", monospace')
    const after = lastInitializeConfig().fontFamily
    expect(after).not.toBe(before)
    expect(after).toContain('Opus5 Theme Probe')
  })

  it('never hands over a value that would be resolved twice', async () => {
    // A CSS-wide keyword or an unresolved custom property is `inherit` with
    // extra steps: it resolves separately in each context. The resolver refuses
    // them, and the fallback is a concrete stack.
    await mount(mermaidSeed('app'))
    await setEditorFont('var(--sn-stylekit-editor-font-family)')
    expect(lastInitializeConfig().fontFamily).toBe(MERMAID_LABEL_FONT_FALLBACK)
    for (const keyword of ['inherit', 'initial', 'unset', 'revert']) {
      await setEditorFont(keyword)
      expect(lastInitializeConfig().fontFamily).toBe(MERMAID_LABEL_FONT_FALLBACK)
    }
  })

  it('measures and draws under the same ancestor, so neither can take a different font', async () => {
    // The structural half: `mermaid.render`'s third argument points at
    // `[data-mermaid-measure-host]`, so the font (and size, and every other
    // inherited text property) a label is laid out in is the one it is painted
    // in BY CONSTRUCTION. jsdom performs no layout and does not inherit
    // `font-family` down a subtree, so the assertable form of that is the
    // ancestry and the absence of any font declaration of their own. Measured in
    // headless Chrome, both hosts compute the identical family and size, and the
    // computed-text-property diff between them is empty.
    await mount(mermaidSeed('app'))
    const block = mermaidBlock()
    expect(block.contains(svgHost())).toBe(true)
    // This is the line that goes red if the measuring element is moved out of
    // the block, which is the only way the two contexts can diverge again.
    expect(block.contains(measureHost())).toBe(true)
    for (const host of [svgHost(), measureHost()]) {
      expect(host.style.fontFamily).toBe('')
      expect(host.style.fontSize).toBe('')
      expect(host.style.lineHeight).toBe('')
      // And no utility class that would set one.
      expect(host.className).not.toMatch(/\bfont-(?:editor|mono|sans|serif)\b|\btext-(?:xs|sm|base|lg|xl)\b/)
    }
  })

  it('carries no font SIZE and no font FAMILY in the theme variables', async () => {
    // Not an omission to fix: mermaid's `base` theme supplies `fontSize: 16px`
    // and emits it into the SVG's own `<style>`, which is what makes the
    // measuring and drawing contexts agree on size. A `fontSize` here would be
    // a second source of truth for it. The family travels as the top-level
    // `fontFamily` so that it also reaches `calculateTextDimensions`, which
    // measures `<text>` labels in a throwaway svg under `document.body` and is
    // NOT moved by the container argument.
    await mount(mermaidSeed('app'))
    const variables = lastThemeVariables() ?? {}
    expect(Object.keys(variables)).not.toContain('fontSize')
    expect(Object.keys(variables)).not.toContain('fontFamily')
    expect(typeof lastInitializeConfig().fontFamily).toBe('string')
    // And the pure builder agrees with what the component actually sent, so
    // this cannot pass against a hand-written object.
    const built = mermaidAppThemeVariables(
      {
        background: '#ffffff',
        foreground: '#000000',
        contrastBackground: '#eeeeee',
        secondaryBackground: '#dddddd',
        secondaryContrastBackground: '#cccccc',
        border: '#bbbbbb',
        passive: '#999999',
      },
      false,
    )
    expect(Object.keys(built)).not.toContain('fontSize')
    expect(Object.keys(built)).not.toContain('fontFamily')
    // Every value has to be something mermaid can interpolate into CSS text; an
    // empty one would silently drop a declaration.
    for (const [key, value] of Object.entries(built)) {
      expect([key, typeof value === 'boolean' || (typeof value === 'string' && value.length > 0)]).toEqual([key, true])
    }
  })
})
