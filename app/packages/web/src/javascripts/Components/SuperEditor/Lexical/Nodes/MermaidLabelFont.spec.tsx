/** @jest-environment jsdom */

/**
 * The font mermaid MEASURES a node in has to be the font that node is DRAWN in.
 *
 * `fontFamily: 'inherit'` guarantees it is not. Mermaid sizes every node from
 * its label's measured text, and it performs that measurement inside a
 * temporary element it appends to `document.body` — for html labels the label
 * itself, for `<text>` labels a throwaway `<svg>` read with `getBBox()`
 * (`calculateTextDimensions`). Both call sites here invoke
 * `mermaid.render(id, source)` with no containing element, which is the branch
 * that appends to `document.body` (mermaid.core.mjs:1285/1310). The finished SVG
 * string is then injected into the EDITOR. So a value that defers to its parent
 * is resolved twice, against two different fonts, and every node box is sized
 * from metrics the label never had.
 *
 * What that costs, measured in headless Chrome at 16px with the editor font set
 * to the app's own Monospace preset (`scratchpad/opus5-nodes-h`, four-node
 * flowchart, 700px column) — BEFORE:
 *
 *   label                       mermaid's slot   label drew   box
 *   "Collect the requirements"  173.45 x 24      200 x 24     233.45 x 54
 *   "Design the data model"     160.67 x 24      184.73 x 24  220.67 x 54
 *   "Ship it"                    44.52 x 24       61.58 x 24  104.52 x 54
 *
 * — so "Ship it" got a box 38% too small for its own label, the text ate 8.5px
 * into the 30px padding on each side, and the longest label was clamped at
 * mermaid's 200px `wrappingWidth` and overflowed. AFTER, with a concrete stack,
 * every node is 30/30/15/15 with zero overflow and the longest label wraps to
 * two lines in a box mermaid sized for two lines (260 x 78).
 *
 * The font FAMILY is only half of it. Everything else that decides how a run of
 * text breaks and shapes is INHERITED, and several of those also differ between
 * `document.body` and the editor — `word-break`, `overflow-wrap`, `line-break`,
 * the ligature preference, `tab-size`. Those are reset on the SVG host in
 * Theme/editor.scss; the last describe below is their contract. That half is
 * what produced "some graphs appear okay but others are crazy weird with node
 * being separated apart like a universe distance".
 *
 * jsdom has no layout engine, so NONE of that geometry is assertable here — the
 * numbers above come from the headless-Chrome harness, which is not a CI gate.
 * What IS assertable, and is the thing that regressed, is the config that
 * reaches `mermaid.initialize` from a real node in a real composer: a concrete
 * family read off the block the diagram is drawn in, never a CSS-wide keyword,
 * and re-read when the Editor Font preference changes.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $getRoot } from 'lexical'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode } from './MermaidNode'
import { $createGanttChartNode, GanttChartNode } from './GanttChartNode'
import { readMermaidLabelFontFamily, useFontFacesLoadedToken } from './MermaidAppTheme'
import { MERMAID_LABEL_FONT_FALLBACK, resolveMermaidLabelFontFamily } from './MermaidSettings'

const DIAGRAM_SVG =
  '<svg id="m-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 300" xmlns="http://www.w3.org/2000/svg"><g><rect width="10" height="10"/></g></svg>'

const mermaidInitialize = jest.fn()
const mermaidRender = jest.fn(async () => ({ svg: DIAGRAM_SVG }))

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
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

/**
 * A family name that exists nowhere else, so an assertion against it cannot
 * pass on the fallback, on jsdom's default, or on a stale value.
 */
const EDITOR_FACE = "'Opus5 Probe Face', sans-serif"
/** jsdom normalises the quoting when it hands the value back. */
const EDITOR_FACE_COMPUTED = '"Opus5 Probe Face", sans-serif'

/**
 * A stand-in for `document.fonts`, which jsdom does not implement. Only the
 * two methods the hook uses, plus a way to fire the one event it listens for.
 */
const fontFaceListeners = new Set<() => void>()
const installFontFaceSetStub = (): void => {
  fontFaceListeners.clear()
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: {
      addEventListener: (type: string, listener: () => void) => {
        if (type === 'loadingdone') {
          fontFaceListeners.add(listener)
        }
      },
      removeEventListener: (_type: string, listener: () => void) => {
        fontFaceListeners.delete(listener)
      },
    },
  })
}

/** Past the component's 400ms render debounce, then flush the microtasks. */
const RENDER_DEBOUNCE_MS = 400
const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, RENDER_DEBOUNCE_MS + 120))
  })
}

let container: HTMLElement
let root: Root

const seed = (make: () => void) => {
  function Seed() {
    const [editor] = useLexicalComposerContext()
    useEffect(() => {
      editor.update(make, { discrete: true })
    }, [editor])
    return null
  }
  return Seed
}

const mount = async (Seed: () => null): Promise<void> => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'mermaid-label-font',
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
        createElement(Seed),
      ),
    )
  })
  await settle()
}

const lastInitializeConfig = (): Record<string, unknown> => {
  const calls = mermaidInitialize.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  return calls[calls.length - 1][0] as Record<string, unknown>
}

const block = (selector: string) => container.querySelector(selector) as HTMLElement

/**
 * The Editor Font preference, as `Utils/editorFont.ts` applies it: the resolved
 * stack is written to `--sn-stylekit-editor-font-family` on
 * `document.documentElement`, and `.font-editor` (SuperEditor.tsx) turns that
 * into the editor subtree's `font-family`.
 *
 * jsdom resolves no custom-property cascade, so this ALSO writes the resolved
 * value inline on the element the cascade would have delivered it to. The
 * documentElement write is still what the subscription observes — remove it and
 * nothing re-reads, which is what the "re-renders" test below is for.
 */
const setEditorFont = async (selector: string, stack: string): Promise<void> => {
  block(selector).style.fontFamily = stack
  await act(async () => {
    document.documentElement.style.setProperty('--sn-stylekit-editor-font-family', stack)
  })
  await settle()
}

/**
 * The editor font applied through a STYLESHEET, i.e. already in force before
 * anything mounts — the real first-paint case, since `.font-editor` is in the
 * app's own CSS and a saved preference is written to `<html>` at startup. jsdom
 * does apply author stylesheets to `getComputedStyle`.
 */
let preMountSheet: HTMLStyleElement | undefined
const installEditorFontStylesheet = (selector: string, stack: string): void => {
  preMountSheet = document.createElement('style')
  preMountSheet.textContent = `${selector}{font-family:${stack}}`
  document.head.appendChild(preMountSheet)
}

/** A webfont finishing its download, under a family name that never changed. */
const finishLoadingFontFaces = async (): Promise<void> => {
  await act(async () => {
    fontFaceListeners.forEach((listener) => listener())
  })
  await settle()
}

beforeEach(() => {
  installFontFaceSetStub()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
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
  // jest.config.js sets `resetMocks: true`, which wipes the implementation given
  // to jest.fn(...) at module scope, not just the call history. Without this,
  // mermaid.render() resolves to undefined from the second test onward and the
  // component lands in its error branch with no preview at all.
  mermaidRender.mockImplementation(async () => ({ svg: DIAGRAM_SVG }))
})

afterEach(() => {
  if (root) {
    act(() => root.unmount())
  }
  container?.remove()
  preMountSheet?.remove()
  preMountSheet = undefined
  document.documentElement.removeAttribute('style')
})

describe('resolveMermaidLabelFontFamily', () => {
  it('refuses every CSS-wide keyword, because none of them is a font', () => {
    for (const keyword of ['inherit', 'initial', 'unset', 'revert', 'revert-layer', 'INHERIT', '  inherit  ']) {
      expect(resolveMermaidLabelFontFamily(keyword)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    }
  })

  it('refuses an empty or non-string value', () => {
    for (const value of ['', '   ', undefined, null, 0, {}, ['Georgia']]) {
      expect(resolveMermaidLabelFontFamily(value)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    }
  })

  it('refuses an unresolved custom property, which is `inherit` with extra steps', () => {
    expect(resolveMermaidLabelFontFamily('var(--sn-stylekit-editor-font-family)')).toBe(MERMAID_LABEL_FONT_FALLBACK)
    expect(resolveMermaidLabelFontFamily('Georgia, var(--fallback)')).toBe(MERMAID_LABEL_FONT_FALLBACK)
  })

  it('refuses anything that could escape the declaration mermaid writes it into', () => {
    // The Editor Font preference accepts a free-text CSS stack, and mermaid
    // interpolates `fontFamily` straight into its stylesheet text with no
    // escaping (createCssStyles / getStyles).
    for (const value of [
      'Georgia}#x{color:red',
      'Georgia;color:red',
      'Georgia/*x*/, serif',
      'Georgia, serif */',
      'Georgia<script>',
      '@import url(x)',
      'Georgia\\, serif',
      'Georgia,\nserif',
    ]) {
      expect(resolveMermaidLabelFontFamily(value)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    }
  })

  it('passes a concrete stack through verbatim', () => {
    expect(resolveMermaidLabelFontFamily('  Georgia, Cambria, "Times New Roman", Times, serif  ')).toBe(
      'Georgia, Cambria, "Times New Roman", Times, serif',
    )
    expect(resolveMermaidLabelFontFamily(EDITOR_FACE_COMPUTED)).toBe(EDITOR_FACE_COMPUTED)
  })

  it('offers a fallback that is itself a concrete stack', () => {
    expect(resolveMermaidLabelFontFamily(MERMAID_LABEL_FONT_FALLBACK)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    expect(MERMAID_LABEL_FONT_FALLBACK).not.toContain('inherit')
    expect(MERMAID_LABEL_FONT_FALLBACK).not.toContain('var(')
  })
})

describe('readMermaidLabelFontFamily', () => {
  it('reads the element it is given', () => {
    const el = document.createElement('div')
    el.style.fontFamily = EDITOR_FACE
    document.body.appendChild(el)
    expect(readMermaidLabelFontFamily(el)).toBe(EDITOR_FACE_COMPUTED)
    el.remove()
  })

  it('falls back when there is no element, or nothing resolves', () => {
    expect(readMermaidLabelFontFamily(null)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    expect(readMermaidLabelFontFamily(undefined)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    const bare = document.createElement('div')
    document.body.appendChild(bare)
    expect(readMermaidLabelFontFamily(bare)).toBe(MERMAID_LABEL_FONT_FALLBACK)
    bare.remove()
  })
})

describe('what reaches mermaid.initialize from a real Mermaid block', () => {
  beforeEach(async () => {
    await mount(
      seed(() => {
        $getRoot().clear().append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]'))
      }),
    )
  })

  it('is a concrete font family, never a CSS-wide keyword', () => {
    const fontFamily = lastInitializeConfig().fontFamily
    expect(typeof fontFamily).toBe('string')
    expect(fontFamily).not.toBe('inherit')
    expect(String(fontFamily)).not.toContain('inherit')
    expect(String(fontFamily)).not.toContain('var(')
    expect(String(fontFamily).length).toBeGreaterThan(0)
  })

  it('is the font resolved off the block the diagram is drawn in', async () => {
    expect(lastInitializeConfig().fontFamily).toBe(MERMAID_LABEL_FONT_FALLBACK)
    await setEditorFont('[data-mermaid-block="true"]', EDITOR_FACE)
    expect(lastInitializeConfig().fontFamily).toBe(EDITOR_FACE_COMPUTED)
  })

  it('re-renders the diagram when the Editor Font preference changes', async () => {
    const before = mermaidRender.mock.calls.length
    expect(before).toBeGreaterThan(0)
    await setEditorFont('[data-mermaid-block="true"]', EDITOR_FACE)
    // Not optional: the SVG now carries a concrete family of its own, so a
    // diagram that is not re-rendered keeps the font it was MEASURED in while
    // the note around it changes. `inherit` tracked this for free, at the cost
    // of being measured wrong.
    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastInitializeConfig().fontFamily).toBe(EDITOR_FACE_COMPUTED)
  })
})

describe('a font that was already in force before the diagram mounted', () => {
  it('reaches the FIRST render, not only a later change', async () => {
    // The subscription reads immediately on subscribe. Without that first read
    // the hook sits on its fallback until some unrelated signal arrives, and a
    // note opened with a saved Editor Font renders its diagram measured in the
    // wrong font until the user touches something.
    installEditorFontStylesheet('[data-mermaid-block="true"]', EDITOR_FACE)
    await mount(
      seed(() => {
        $getRoot().clear().append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]'))
      }),
    )
    expect(mermaidInitialize.mock.calls.length).toBe(1)
    expect(lastInitializeConfig().fontFamily).toBe(EDITOR_FACE_COMPUTED)
  })
})

describe('a webfont finishing its download', () => {
  beforeEach(async () => {
    await mount(
      seed(() => {
        $getRoot().clear().append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]'))
      }),
    )
  })

  it('re-renders the diagram, although the family name never changed', async () => {
    const before = mermaidRender.mock.calls.length
    const family = lastInitializeConfig().fontFamily
    await finishLoadingFontFaces()
    // `editorFont.ts` asks Google Fonts for `display=swap`, so the editor paints
    // a generic fallback under the chosen family's name until the woff2 lands.
    // A diagram rendered in that window was MEASURED in the fallback's metrics
    // and is now DRAWN in the webfont's. The family string is identical either
    // side of the swap, so only the swap itself can say so.
    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
    expect(lastInitializeConfig().fontFamily).toBe(family)
  })
})

describe('useFontFacesLoadedToken', () => {
  it('is inert where the browser offers no FontFaceSet', () => {
    // jsdom has no `document.fonts`; neither does a server render. The hook has
    // to be a no-op there rather than throwing on `addEventListener`.
    const original = Object.getOwnPropertyDescriptor(document, 'fonts')
    Object.defineProperty(document, 'fonts', { configurable: true, value: undefined })
    let seen: number | undefined
    function Probe() {
      seen = useFontFacesLoadedToken()
      return null
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const probeRoot = createRoot(host)
    act(() => probeRoot.render(createElement(Probe)))
    expect(seen).toBe(0)
    act(() => probeRoot.unmount())
    host.remove()
    if (original) {
      Object.defineProperty(document, 'fonts', original)
    }
  })
})

describe('what reaches mermaid.initialize from a real Gantt chart block', () => {
  beforeEach(async () => {
    await mount(
      seed(() => {
        $getRoot()
          .clear()
          .append(
            $createGanttChartNode({
              version: 1,
              title: 'Plan',
              tasks: [{ name: 'Research the options', section: 'Phase 1', start: '2024-01-01', duration: '5d' }],
            }),
          )
      }),
    )
  })

  it('is a concrete font family, never a CSS-wide keyword', () => {
    const fontFamily = lastInitializeConfig().fontFamily
    expect(typeof fontFamily).toBe('string')
    expect(String(fontFamily)).not.toContain('inherit')
    expect(String(fontFamily)).not.toContain('var(')
  })

  it('is the font resolved off the block, and a change re-renders the chart', async () => {
    expect(lastInitializeConfig().fontFamily).toBe(MERMAID_LABEL_FONT_FALLBACK)
    const before = mermaidRender.mock.calls.length
    await setEditorFont('[data-gantt-block="true"]', EDITOR_FACE)
    expect(lastInitializeConfig().fontFamily).toBe(EDITOR_FACE_COMPUTED)
    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
  })

  it('re-renders the chart when a webfont finishes downloading', async () => {
    // A gantt chart is the diagram type this matters most to: every task name
    // is a `<text>` measured through `calculateTextDimensions`, and the bar
    // geometry is derived from those widths.
    const before = mermaidRender.mock.calls.length
    await finishLoadingFontFaces()
    expect(mermaidRender.mock.calls.length).toBeGreaterThan(before)
  })
})

describe('the text-shaping the SVG inherits from the editor, which mermaid did not measure in', () => {
  const editorScss = readFileSync(join(__dirname, '..', 'Theme', 'editor.scss'), 'utf8')
  const hostRule = /\[data-mermaid-svg-host='true'\]\s*\{([^}]*)\}/s.exec(editorScss)?.[1] ?? ''

  /**
   * Measured in headless Chrome: the computed value in `document.body` (where
   * mermaid measures) against the computed value on a mermaid label in the
   * editor (where it draws). Every one of these is an INHERITED property that
   * changes how a run of text breaks or shapes, so a difference is a diagram
   * laid out to one set of metrics and painted with another.
   *
   * The fourth column is honest about what each one is worth. Each property was
   * put BACK alone, with `!important`, over the fixed build and re-measured:
   * only `word-break` moved any geometry, and putting it back alone reproduced
   * the defect in full. The other five are DEFENSIVE — a real divergence in
   * computed value with no demonstrated consequence in this browser with this
   * font. The assertions below check that the rule still names them; they are
   * not evidence that any of the five matters.
   */
  const MEASURED_DIVERGENCES = [
    ['word-break', 'normal', 'break-word', 'demonstrated'],
    ['overflow-wrap', 'normal', 'break-word', 'defensive'],
    ['line-break', 'auto', 'after-white-space', 'defensive'],
    ['font-variant-ligatures', 'normal', 'none', 'defensive'],
    ['font-feature-settings', 'normal', '"calt" 0, "liga" 0', 'defensive'],
    ['tab-size', '4', '2', 'defensive'],
  ] as const

  /** The rule body as `property -> value`, so an assertion names one thing. */
  const declarations = new Map(
    hostRule
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const at = part.indexOf(':')
        return [part.slice(0, at).trim(), part.slice(at + 1).trim()] as [string, string]
      }),
  )

  it('resets every property measured to differ, to the value mermaid measured with', () => {
    expect(hostRule).not.toBe('')
    for (const [property, inBody, inEditor] of MEASURED_DIVERGENCES) {
      expect([property, declarations.get(property)]).toEqual([property, inBody])
      // And the reset has to be to the MEASUREMENT context's value, not to
      // whatever the editor happened to have.
      expect(declarations.get(property)).not.toBe(inEditor)
    }
  })

  it('keeps the one property that is demonstrated, whatever else is trimmed', () => {
    // The whole defect, isolated: putting `word-break: break-word` back alone
    // over the fixed build reproduces it in full — the URL edge label's slot
    // stays 410.64 x 48 while the label draws 200 x 72 — identically to putting
    // all six back. If the rule is ever trimmed, this is the line that may not
    // go.
    const demonstrated = MEASURED_DIVERGENCES.filter(([, , , standing]) => standing === 'demonstrated')
    expect(demonstrated.map(([property]) => property)).toEqual(['word-break'])
    expect(declarations.get('word-break')).toBe('normal')
  })

  it('resets nothing it cannot show a reason for', () => {
    // A declaration with no divergence behind it is one no assertion can
    // defend: `white-space: normal` was in the first draft of this rule and
    // survived its own mutant, because mermaid sets `white-space` inline on
    // every label it measures. The rule is exactly the measured divergences.
    expect([...declarations.keys()].sort()).toEqual(
      MEASURED_DIVERGENCES.map(([p]) => p)
        .slice()
        .sort(),
    )
  })

  it('is NOT scoped to the editor, because the SVG is drawn in five places', () => {
    // The note, the revision preview, the share viewer, the print snapshot and
    // the exported HTML all mount the same viewport. The invariant belongs to
    // mermaid's output, not to one host.
    expect(editorScss).toMatch(/(^|\n)\[data-mermaid-svg-host='true'\]\s*\{/)
    expect(editorScss).not.toMatch(/\.ContentEditable__root \[data-mermaid-svg-host='true'\]/)
  })

  it('selects an attribute the viewport actually renders', async () => {
    // A selector that matches nothing is a rule that cannot be made red by any
    // stylesheet assertion. This is the half jsdom CAN check.
    await mount(
      seed(() => {
        $getRoot().clear().append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]'))
      }),
    )
    expect(container.querySelector('[data-mermaid-svg-host="true"]')).not.toBeNull()
  })
})
