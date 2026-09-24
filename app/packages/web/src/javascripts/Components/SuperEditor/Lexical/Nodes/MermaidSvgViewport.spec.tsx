/**
 * @jest-environment jsdom
 *
 * Bug fix (t96): a rendered mermaid diagram did not fit its container (a wide
 * diagram just ran past the note's width, with only a bare scrollbar to see
 * the rest) and had no zoom/pan/fit controls.
 *
 * This proves what can be honestly proven in jsdom without a real mermaid
 * render (mermaid needs a browser layout engine it does not have here):
 *  - the pure sizing math (`parseSvgNaturalSize`, `computeFitBoxHeight`)
 *  - that the component actually FITS the diagram to the container's width by
 *    default, with no user action, by asserting the real inline `transform:
 *    scale(...)` style applied to the SVG host after mount
 *  - that zoom in / zoom out / reset / fit controls are present, wired, and
 *    drive real state transitions (the displayed zoom percentage changes)
 *  - the graceful fallback when the diagram's natural size can't be
 *    determined: no controls, no clipping (matches the pre-fix behaviour)
 *    rather than guessing and cutting the diagram off
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import MermaidSvgViewport, {
  computeFitBoxHeight,
  MAX_PREVIEW_HEIGHT,
  MIN_PREVIEW_HEIGHT,
  parseSvgNaturalSize,
} from './MermaidSvgViewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A realistic shape for what mermaid.render() actually emits (verified against
// the installed mermaid@11.16.1 bundle: src/setupGraphViewbox.js sets
// width="100%" + a max-width style, and stamps viewBox="0 0 W H").
const WIDE_MERMAID_SVG =
  '<svg id="mermaid-1" width="100%" style="max-width: 800px;" viewBox="0 0 800 400" xmlns="http://www.w3.org/2000/svg"><g><rect width="100" height="50"/></g></svg>'

// A diagram type that (hypothetically) only stamps raw pixel attributes.
const PIXEL_ATTR_SVG = '<svg width="300" height="150" xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

// What a "can't determine size" SVG looks like: percentage width, no viewBox.
const UNSIZED_SVG = '<svg width="100%" xmlns="http://www.w3.org/2000/svg"><rect/></svg>'

class MockResizeObserver {
  constructor(_cb: ResizeObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let container: HTMLElement
let root: Root
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect
let originalClientWidth: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined

// The stubbed viewport is 400px wide x 300px tall — narrower than the 800px
// WIDE_MERMAID_SVG, which is the whole point: proves the diagram shrinks to
// fit rather than overflowing.
const STUB_VIEWPORT_WIDTH = 400
const STUB_VIEWPORT_HEIGHT = 300

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

const render = (svg: string) => {
  act(() => {
    root.render(createElement(MermaidSvgViewport, { svg }))
  })
}

const svgHost = () => container.querySelector('[data-mermaid-svg-host="true"]') as HTMLElement
const controlsPill = () => container.querySelector('[data-mermaid-viewport-controls="true"]')
const button = (label: string) => container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null
const percentButton = () => container.querySelector('button[aria-label="Reset to actual size"]') as HTMLButtonElement

describe('parseSvgNaturalSize (pure)', () => {
  it('reads the natural size from a viewBox, the shape mermaid.render() actually emits', () => {
    expect(parseSvgNaturalSize(WIDE_MERMAID_SVG)).toEqual({ width: 800, height: 400 })
  })

  it('falls back to numeric width/height attributes when there is no viewBox', () => {
    expect(parseSvgNaturalSize(PIXEL_ATTR_SVG)).toEqual({ width: 300, height: 150 })
  })

  it('returns null (not a guess) when neither a viewBox nor numeric attributes are present', () => {
    expect(parseSvgNaturalSize(UNSIZED_SVG)).toBeNull()
  })
})

describe('computeFitBoxHeight (pure)', () => {
  it('scales the box height proportionally to the width-fit when under the cap', () => {
    // 400 viewport / 800 natural width = 0.5 scale -> 400 * 0.5 = 200 tall.
    expect(computeFitBoxHeight(400, 800, 400)).toBe(200)
  })

  it('caps the box height at MAX_PREVIEW_HEIGHT for a very tall diagram', () => {
    expect(computeFitBoxHeight(400, 400, 4000)).toBe(MAX_PREVIEW_HEIGHT)
  })

  it('falls back to MIN_PREVIEW_HEIGHT for degenerate (zero/negative) inputs', () => {
    expect(computeFitBoxHeight(0, 800, 400)).toBe(MIN_PREVIEW_HEIGHT)
    expect(computeFitBoxHeight(400, 0, 400)).toBe(MIN_PREVIEW_HEIGHT)
  })
})

describe('MermaidSvgViewport — fits the diagram to the container by default', () => {
  it('scales an 800px-wide diagram down to fit a 400px viewport with no user action', () => {
    render(WIDE_MERMAID_SVG)
    const host = svgHost()
    expect(host.style.transform).toContain('scale(0.5)')
  })

  it('sizes the box to the fitted height (400 * 0.5 = 200px), not a fixed/oversized box', () => {
    render(WIDE_MERMAID_SVG)
    const viewport = container.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement
    expect(viewport.style.height).toBe('200px')
  })

  it('inserts the raw SVG markup into the host so the diagram itself is unchanged', () => {
    render(WIDE_MERMAID_SVG)
    expect(svgHost().querySelector('svg')).not.toBeNull()
    expect(svgHost().querySelector('rect')).not.toBeNull()
  })
})

describe('MermaidSvgViewport — navigation controls', () => {
  it('renders zoom out, zoom in, reset, and fit controls once the diagram size is known', () => {
    render(WIDE_MERMAID_SVG)
    expect(button('Zoom out')).not.toBeNull()
    expect(button('Zoom in')).not.toBeNull()
    expect(button('Reset to actual size')).not.toBeNull()
    expect(button('Fit to width')).not.toBeNull()
  })

  it('starts at the fitted zoom percentage (50%)', () => {
    render(WIDE_MERMAID_SVG)
    expect(percentButton().textContent).toBe('50%')
  })

  it('zoom in increases the scale and the displayed percentage', () => {
    render(WIDE_MERMAID_SVG)
    act(() => {
      button('Zoom in')?.click()
    })
    // 0.5 * 1.25 = 0.625 -> rounds to 63%.
    expect(percentButton().textContent).toBe('63%')
    expect(svgHost().style.transform).toContain('scale(0.625)')
  })

  it('zoom out decreases the scale and the displayed percentage', () => {
    render(WIDE_MERMAID_SVG)
    act(() => {
      button('Zoom out')?.click()
    })
    // 0.5 / 1.25 = 0.4 -> rounds to 40%.
    expect(percentButton().textContent).toBe('40%')
  })

  it('fit-to-width returns a zoomed-in view back to the original fit scale', () => {
    render(WIDE_MERMAID_SVG)
    act(() => {
      button('Zoom in')?.click()
      button('Zoom in')?.click()
    })
    expect(percentButton().textContent).not.toBe('50%')
    act(() => {
      button('Fit to width')?.click()
    })
    expect(percentButton().textContent).toBe('50%')
  })

  it('reset-to-actual-size jumps straight to 100%', () => {
    render(WIDE_MERMAID_SVG)
    act(() => {
      percentButton().click()
    })
    expect(percentButton().textContent).toBe('100%')
  })
})

describe('MermaidSvgViewport — graceful fallback when the diagram size cannot be determined', () => {
  it('renders no navigation controls (nothing to fit/zoom against)', () => {
    render(UNSIZED_SVG)
    expect(controlsPill()).toBeNull()
    expect(button('Zoom in')).toBeNull()
  })

  it('does not clip the diagram: falls back to scrollable overflow instead of a hard-capped box', () => {
    render(UNSIZED_SVG)
    const viewport = container.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement
    expect(viewport.style.overflow).toBe('auto')
  })

  it('still inserts the SVG markup so the diagram is not lost', () => {
    render(UNSIZED_SVG)
    expect(svgHost().querySelector('svg')).not.toBeNull()
  })
})

describe('MermaidSvgViewport — re-fits when the source diagram changes', () => {
  it('recomputes the fit scale when a new (differently-sized) svg prop arrives', () => {
    render(WIDE_MERMAID_SVG)
    expect(percentButton().textContent).toBe('50%')

    // A narrower diagram (400 natural width) exactly matches the 400px viewport -> 100%.
    const narrowSvg =
      '<svg width="100%" style="max-width: 400px;" viewBox="0 0 400 200" xmlns="http://www.w3.org/2000/svg"><rect/></svg>'
    render(narrowSvg)
    expect(percentButton().textContent).toBe('100%')
  })

  it('clears stale controls/state when switching from a fittable to an unfittable diagram', () => {
    render(WIDE_MERMAID_SVG)
    expect(controlsPill()).not.toBeNull()

    render(UNSIZED_SVG)
    expect(controlsPill()).toBeNull()
  })
})
