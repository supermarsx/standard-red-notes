/**
 * @jest-environment jsdom
 *
 * Render contract for GanttChartNode's preview (t96 follow-up): a Gantt chart
 * is rendered through mermaid.render() with the exact same output shape as a
 * plain flowchart (verified against the installed mermaid@11.16.1 source:
 * ganttRenderer.js calls the same configureSvgSize/viewBox path as the
 * flowchart renderer), so it hit the identical "doesn't fit its container, no
 * navigation controls" bug the user reported for "mermaid charts" in general.
 *
 * This proves the WIRING — that GanttChartComponent's preview now goes
 * through the real MermaidSvgViewport (fit-to-container + zoom/pan/fit
 * controls), not a bare `dangerouslySetInnerHTML` div — by asserting on the
 * actual DOM markers MermaidSvgViewport produces. MermaidSvgViewport's own
 * fit/zoom/pan/fallback correctness is already covered exhaustively in
 * MermaidSvgViewport.spec.tsx; this file does not re-prove that math, only
 * that GanttChartNode now uses it.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { GanttChartComponent, GanttChartData } from './GanttChartNode'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Shaped exactly like mermaid@11.16.1's actual gantt output (viewBox + the
// useMaxWidth width/style pair) — see ganttRenderer.js in the installed
// package, which calls the same setupGraphViewbox/configureSvgSize helpers
// the flowchart renderer uses.
const GANTT_SVG =
  '<svg id="gantt-1" width="100%" style="max-width: 600px;" viewBox="0 0 600 240" xmlns="http://www.w3.org/2000/svg"><g><rect width="100" height="20"/></g></svg>'

const mockEditor = { update: jest.fn((callback: () => void) => callback()) }
const mermaidRender = jest.fn(async () => ({ svg: GANTT_SVG }))

jest.mock('@lexical/react/LexicalComposerContext', () => ({ useLexicalComposerContext: () => [mockEditor] }))
jest.mock('mermaid', () => ({
  __esModule: true,
  default: { initialize: jest.fn(), render: (...args: unknown[]) => mermaidRender(...(args as [])) },
}))

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const STUB_VIEWPORT_WIDTH = 400
const STUB_VIEWPORT_HEIGHT = 300

let container: HTMLElement
let root: Root
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect
let originalClientWidth: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined

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

  originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: STUB_VIEWPORT_WIDTH,
      height: STUB_VIEWPORT_HEIGHT,
      top: 0,
      left: 0,
      right: STUB_VIEWPORT_WIDTH,
      bottom: STUB_VIEWPORT_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect
  }
  originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      return STUB_VIEWPORT_WIDTH
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return STUB_VIEWPORT_HEIGHT
    },
  })

  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // jest.config.js sets `resetMocks: true` globally, which wipes a jest.fn's
  // IMPLEMENTATION (not just call history) before every test — including the
  // one passed to jest.fn(...) at module scope — so it must be re-established
  // here rather than relied on from the factory.
  mermaidRender.mockImplementation(async () => ({ svg: GANTT_SVG }))
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
  if (originalClientWidth) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth)
  }
  if (originalClientHeight) {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight)
  }
})

const TASK_DATA: GanttChartData = {
  version: 1,
  title: 'Project plan',
  tasks: [{ name: 'Research', section: 'Phase 1', start: '2024-01-01', duration: '5d' }],
}

const renderGantt = async (data: GanttChartData) => {
  await act(async () => {
    root.render(createElement(GanttChartComponent, { data, nodeKey: 'gantt-node' }))
    // Flush the async render() effect: dynamic import('mermaid') -> .then(m
    // => m.default) -> mermaid.render() are each their own microtask hop, so
    // a couple of bare Promise.resolve() ticks isn't reliably enough; a
    // macrotask tick guarantees every pending microtask has drained first.
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

describe('GanttChartNode preview — routes through MermaidSvgViewport, not a raw div', () => {
  it('renders the real MermaidSvgViewport once a chart has been produced', async () => {
    await renderGantt(TASK_DATA)
    expect(mermaidRender).toHaveBeenCalledTimes(1)
    expect(container.querySelector('[data-mermaid-viewport="true"]')).not.toBeNull()
  })

  it('does NOT fall back to a bare dangerouslySetInnerHTML wrapper for the svg', async () => {
    await renderGantt(TASK_DATA)
    // Before the fix, the svg's only home in the DOM was a plain <div> with no
    // marker at all; after the fix it is only ever inserted through the
    // viewport's own host element.
    expect(container.querySelector('[data-mermaid-svg-host="true"]')).not.toBeNull()
    expect(container.querySelector('[data-mermaid-svg-host="true"] svg')).not.toBeNull()
  })

  it('actually fits the 600px-wide gantt chart to a 400px container, same as a flowchart', async () => {
    await renderGantt(TASK_DATA)
    const host = container.querySelector('[data-mermaid-svg-host="true"]') as HTMLElement
    // 400 / 600 viewport-to-natural-width ratio.
    expect(host.style.transform).toContain(`scale(${400 / 600})`)
  })

  it('exposes the same zoom/pan/fit controls a mermaid diagram gets', async () => {
    await renderGantt(TASK_DATA)
    expect(container.querySelector('button[aria-label="Zoom in"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Zoom out"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Fit to width"]')).not.toBeNull()
  })

  it('keeps the empty-state message when there are no tasks (no viewport, nothing to render)', async () => {
    await renderGantt({ version: 1, title: '', tasks: [] })
    expect(mermaidRender).not.toHaveBeenCalled()
    expect(container.querySelector('[data-mermaid-viewport="true"]')).toBeNull()
    expect(container.textContent).toContain('Add a task to render the chart.')
  })

  it('still surfaces a render error inline when mermaid.render() rejects', async () => {
    mermaidRender.mockImplementationOnce(async () => {
      throw new Error('boom')
    })
    await renderGantt(TASK_DATA)
    expect(container.textContent).toContain('boom')
  })
})
