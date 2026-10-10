/**
 * @jest-environment jsdom
 *
 * "The mermaid chart is rendered very weirdly, like way too wide, like it is
 * trying to adapt to a gigantic container."
 *
 * It was adapting to one. Two independent defects produced that, and this file
 * pins both at the level jsdom can actually see. Measured in headless Chrome —
 * real LexicalComposer, real MermaidNode, freshly compiled editor.scss +
 * Tailwind, window 1440x1000 — the default 263x363 flowchart in a 668px note
 * column whose preview viewport is 650px:
 *
 *   before 768b9a14 (23f9da92):  box 480, scale 132%, drawn 347.8 x 480
 *   at 768b9a14 and after:       box 897, scale 247%, drawn 650   x 897.1
 *   with this fix:               box 363, scale 100%, drawn 263   x 363
 *
 * and in `graphical` view mode at a 334px note column:
 *
 *   before 88db007a:  .ContentEditable__root 319px (the builder had no preview)
 *   at 88db007a:      .ContentEditable__root 468px, block 434px — 134px of it
 *                     clipped by `.editor`, and the preview fitted to 201px of
 *                     a column that does not exist
 *   with this fix:    .ContentEditable__root 334px, identical to `split`
 *
 * jsdom has no layout engine, so nothing here asserts a measured geometry. What
 * it asserts instead is everything that DECIDES the geometry: the committed box
 * height and transform for a declared container width, the classes that let the
 * two-pane row shrink, and the stylesheet rule that stops a widget's contents
 * sizing the note column. The numbers above are the browser's.
 */
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $getRoot } from 'lexical'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { $createMermaidNode, MermaidNode } from './MermaidNode'
import { DEFAULT_MERMAID_FIT_MODE, defaultMermaidMaxHeightPx, type MermaidViewMode } from './MermaidSettings'
import { computeFitBoxHeight, computeFitScale } from './MermaidSvgViewport'

/** The default four-box flowchart's real natural size, as mermaid emits it. */
const NATURAL_WIDTH = 263
const NATURAL_HEIGHT = 363
const DIAGRAM_SVG =
  `<svg id="srn-rendered-diagram" width="100%" style="max-width: ${NATURAL_WIDTH}px;" ` +
  `viewBox="0 0 ${NATURAL_WIDTH} ${NATURAL_HEIGHT}" xmlns="http://www.w3.org/2000/svg">` +
  '<g><rect width="10" height="10"/></g></svg>'

jest.mock('mermaid', () => ({
  __esModule: true,
  default: {
    initialize: () => undefined,
    render: async () => ({ svg: DIAGRAM_SVG }),
  },
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

/**
 * The width the preview viewport reports. In the browser this is the pane's real
 * `clientWidth`; here it is declared, because jsdom reports 0 for everything and
 * the fit would then take its "cannot determine a size" branch.
 */
let declaredViewportWidth = 650
let container: HTMLElement
let root: Root
let seedMode: MermaidViewMode = 'preview'
let originalClientWidth: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined

function Seed() {
  const [editor] = useLexicalComposerContext()
  // One discrete update on mount, so the node exists before anything is read.
  // In an effect rather than during render: Lexical's update flushes
  // synchronously, and React rejects a flushSync from inside a render pass.
  useEffect(() => {
    editor.update(
      () => {
        $getRoot()
          .clear()
          .append($createMermaidNode('flowchart TD\n  A[Start] --> B[End]', 'app', seedMode))
      },
      { discrete: true },
    )
  }, [editor])
  return null
}

const mountWith = async (viewMode: MermaidViewMode, viewportWidth: number) => {
  seedMode = viewMode
  declaredViewportWidth = viewportWidth
  container = document.createElement('div')
  document.body.appendChild(container)
  await act(async () => {
    root = createRoot(container)
    root.render(
      createElement(
        LexicalComposer,
        {
          initialConfig: {
            namespace: 'mermaid-container-fit',
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
        createElement(Seed),
      ),
    )
  })
  // The diagram arrives from an async mermaid render behind the node's own 400ms
  // RENDER_DEBOUNCE_MS, then a dynamic `import('mermaid')`, then the fit. Real
  // time rather than fake timers, because the import's promise and the debounce
  // have to interleave the way they do in the browser.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 600))
  })
}

beforeEach(() => {
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
  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return declaredViewportWidth
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      // The box's own committed height, which is what the fit reads back.
      return parseFloat(this.style.height) || 0
    },
  })
})

afterEach(() => {
  if (root) {
    act(() => root.unmount())
  }
  container?.remove()
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  }
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  }
})

const svgHost = () => container.querySelector('[data-mermaid-svg-host="true"]') as HTMLElement
const previewBox = () => svgHost().parentElement as HTMLElement
const scaleOf = (element: HTMLElement): number => {
  const match = /scale\(([-\d.]+)\)/.exec(element.style.transform)
  if (!match) {
    throw new Error(`no scale() in transform ${JSON.stringify(element.style.transform)}`)
  }
  return parseFloat(match[1])
}

describe('an un-configured diagram is fitted to its container, not inflated by it', () => {
  it('draws a small diagram at its natural size in a wide column', async () => {
    await mountWith('preview', 650)
    // The regression: 897px tall at 247%. A 263x363 diagram must commit a 363px
    // box at 1:1 — the size mermaid drew it, with its baked-in label sizes still
    // in proportion to the note's body text.
    expect(previewBox().style.height).toBe('363px')
    expect(scaleOf(svgHost())).toBe(1)
  })

  it('still SHRINKS the same diagram to fit a narrow pane', async () => {
    await mountWith('preview', 134)
    // Shrink-to-fit is the half of "fit the container" that was never wrong, and
    // it must survive the ceiling: 134/263 = 0.5095.
    expect(scaleOf(svgHost())).toBeCloseTo(134 / NATURAL_WIDTH, 4)
    expect(parseFloat(previewBox().style.height)).toBeCloseTo(NATURAL_HEIGHT * (134 / NATURAL_WIDTH), 1)
  })

  it('cannot be reached by the window at all', () => {
    // The precise mechanism of the bug: the auto-fit cap is 0.9 x the window's
    // height, and under the old default that cap was the only brake on the
    // upscale — so a taller window drew a BIGGER diagram. Now the default fit is
    // identical whatever the window reports.
    const scaleIn = (windowHeight: number) =>
      computeFitScale(
        650,
        computeFitBoxHeight(650, NATURAL_WIDTH, NATURAL_HEIGHT, defaultMermaidMaxHeightPx(windowHeight)),
        NATURAL_WIDTH,
        NATURAL_HEIGHT,
      )
    expect(defaultMermaidMaxHeightPx(2400)).toBeGreaterThan(defaultMermaidMaxHeightPx(800))
    expect(scaleIn(2400)).toBe(scaleIn(800))
    expect(scaleIn(2400)).toBe(1)
  })

  it('leaves the explicit fitWidth choice able to fill the column', () => {
    // The feature 768b9a14 added is kept; it is simply no longer imposed on a
    // diagram nobody configured.
    expect(DEFAULT_MERMAID_FIT_MODE).not.toBe('fitWidth')
    expect(computeFitScale(650, 897, NATURAL_WIDTH, NATURAL_HEIGHT, 'fitWidth')).toBeCloseTo(650 / NATURAL_WIDTH, 4)
  })
})

describe('a mermaid block never sizes the note column from its own contents', () => {
  const editorScss = readFileSync(join(__dirname, '..', 'Theme', 'editor.scss'), 'utf8')

  it('contains the block in the inline axis, in the same scope that gives it a width', () => {
    // Why a stylesheet assertion: the defect is invisible to every other gate.
    // `inline-size: min(100%, 72rem)` is definite during layout but resolves to
    // auto under INTRINSIC sizing, so the block reported its contents'
    // min-content width to the editor's flex wrapper and stretched it. Size
    // containment is the fix; with no definite inline size it would instead
    // COLLAPSE the block, so the two rules must share a scope.
    expect(editorScss).toMatch(/\.ContentEditable__root \[data-mermaid-block\]\s*\{[^}]*contain:\s*inline-size/s)
    expect(editorScss).toMatch(
      /\.ContentEditable__root \[data-super-widget-layout='canvas'\]\s*\{[^}]*inline-size:\s*min\(100%, 72rem\)/s,
    )
  })

  it('floors every two-pane pane at zero so none of them refuses to shrink', async () => {
    await mountWith('graphical', 317)
    const row = container.querySelector('[data-mermaid-block] > div:nth-of-type(2)') as HTMLElement
    expect(row.className).toContain('min-w-0')
    const builderPane = container.querySelector('[data-mermaid-graphical="true"]')?.parentElement as HTMLElement
    expect(builderPane.className).toContain('min-w-0')
    expect(builderPane.className).toContain('md:w-1/2')
    // And the preview pane beside it, which already had it.
    expect(previewBox().closest('[data-mermaid-block] > div > div')?.className).toContain('min-w-0')
  })

  it('lets the builder reflow and scroll rather than demand a width', async () => {
    await mountWith('graphical', 317)
    const builder = container.querySelector('[data-mermaid-graphical="true"]') as HTMLElement
    // The backstop for anything that cannot reflow: reachable, not clipped.
    expect(builder.className).toContain('overflow-x-auto')
    const rows = builder.querySelectorAll('select')
    expect(rows.length).toBeGreaterThan(0)
    // A <select>'s intrinsic width is its widest option, so every one of them
    // has to be allowed to shrink or the row cannot wrap.
    for (const select of Array.from(rows)) {
      expect(select.className).toContain('min-w-0')
    }

    // Every control row wraps. Without this a row keeps all of its controls on
    // one line and the whole form stays ~400px wide whatever the pane offers,
    // which is the demand that stretched the note column in the first place.
    // Located by each row's own remove button, which is a direct child of it —
    // structural, so it does not quietly match the Direction <label> at the top
    // (which is not a row and has no Add/remove control).
    const controlRows = Array.from(
      builder.querySelectorAll('[aria-label^="Remove node"], [aria-label^="Remove edge"]'),
    ).map((button) => button.parentElement as HTMLElement)
    // The seed is 2 nodes + 1 edge, so there are 3 rows; asserting the count
    // keeps the selector honest if those labels are ever renamed.
    expect(controlRows).toHaveLength(3)
    for (const row of controlRows) {
      expect(row.className).toContain('flex-wrap')
    }

    // ...and so do the "Nodes"/"Links" headings beside their Add button. Without
    // it Chrome squeezes the heading below its min-content and breaks the word
    // itself — measured: "Nodes" rendered as "Node s" in a 149px pane.
    const headings = Array.from(builder.querySelectorAll('span.font-semibold')).map(
      (span) => span.parentElement as HTMLElement,
    )
    expect(headings.map((heading) => heading.textContent?.slice(0, 5))).toEqual(['Nodes', 'Links'])
    for (const heading of headings) {
      expect(heading.className).toContain('flex-wrap')
    }
  })

  it('shows the builder AND the diagram, which is what made the pane two-pane', async () => {
    await mountWith('graphical', 317)
    expect(container.querySelector('[data-mermaid-graphical="true"]')).not.toBeNull()
    expect(svgHost().querySelector('#srn-rendered-diagram')).not.toBeNull()
  })
})
