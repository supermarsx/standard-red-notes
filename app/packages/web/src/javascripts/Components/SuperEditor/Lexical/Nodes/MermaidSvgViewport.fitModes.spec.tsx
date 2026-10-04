/**
 * @jest-environment jsdom
 *
 * The fit MODES and the configurable maximum height that replaced the hardcoded
 * 480px cap (t118).
 *
 * jsdom has no layout engine — every width and height reads 0 — so the rects and
 * `clientWidth` are DECLARED here, never measured, and this file pins the policy
 * arithmetic plus the attributes and handlers the modes switch on. The RENDERED
 * geometry (what scale a real browser draws at, in a real parent box) is measured
 * in headless Chrome; see the header of MermaidSvgViewport.tsx.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import MermaidSvgViewport, {
  computeFitBoxHeight,
  computeFitScale,
  diagramFitTransform,
  effectiveFitMode,
  MAX_FIT_UPSCALE,
  MAX_PREVIEW_HEIGHT,
  MIN_PREVIEW_HEIGHT,
} from './MermaidSvgViewport'

/** A portrait diagram: the shape that exposed the height-bound fit. */
const TALL_SVG =
  '<svg id="t" width="100%" viewBox="0 0 263 363" style="max-width:263px"><g><rect width="10" height="10"/></g></svg>'

const VIEWPORT_WIDTH = 700
const VIEWPORT_HEIGHT = 480

let container: HTMLElement
let root: Root
let originalGetBoundingClientRect: typeof Element.prototype.getBoundingClientRect
let originalClientWidth: PropertyDescriptor | undefined
let originalClientHeight: PropertyDescriptor | undefined
let declaredHeight = VIEWPORT_HEIGHT

class MockResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = MockResizeObserver
  // jsdom has neither; StyledTooltip inside the zoom cluster calls matchMedia on
  // mount, and the component's own refit observer needs ResizeObserver to exist.
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
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      width: VIEWPORT_WIDTH,
      height: declaredHeight,
      top: 0,
      left: 0,
      right: VIEWPORT_WIDTH,
      bottom: declaredHeight,
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
      return VIEWPORT_WIDTH
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get() {
      return declaredHeight
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

const viewportBox = () => container.querySelector('[data-mermaid-viewport="true"]') as HTMLElement
const innerBox = () => viewportBox().firstElementChild as HTMLElement
const svgHost = () => container.querySelector('[data-mermaid-svg-host="true"]') as HTMLElement
const controlsPill = () => container.querySelector('[data-mermaid-viewport-controls="true"]')

const scaleOf = (element: HTMLElement): number => {
  const match = /scale\(([-\d.]+)\)/.exec(element.style.transform)
  if (!match) {
    throw new Error(`no scale() in transform ${JSON.stringify(element.style.transform)}`)
  }
  return parseFloat(match[1])
}

const translateOf = (element: HTMLElement): { x: number; y: number } => {
  const match = /translate\(([-\d.]+)px,\s*([-\d.]+)px\)/.exec(element.style.transform)
  if (!match) {
    throw new Error(`no translate() in transform ${JSON.stringify(element.style.transform)}`)
  }
  return { x: parseFloat(match[1]), y: parseFloat(match[2]) }
}

describe('computeFitScale — each mode is a different, observable scale', () => {
  // A 263x363 diagram in a 700x480 box: the exact case that filled only 49.7% of
  // the width before fit modes existed.
  it('fitBoth is the old behaviour — bound by the shorter axis', () => {
    expect(computeFitScale(700, 480, 263, 363, 'fitBoth')).toBeCloseTo(480 / 363, 6)
  })

  it('fitWidth spans the full width, whatever the box height is', () => {
    expect(computeFitScale(700, 480, 263, 363, 'fitWidth')).toBeCloseTo(700 / 263, 6)
    // And it does NOT change when the box gets shorter — that is what makes it
    // "fit the container's width" rather than "fit whichever axis binds".
    expect(computeFitScale(700, 120, 263, 363, 'fitWidth')).toBeCloseTo(700 / 263, 6)
  })

  it('actual is exactly 1, however big the box is', () => {
    expect(computeFitScale(700, 480, 263, 363, 'actual')).toBe(1)
    expect(computeFitScale(70, 48, 263, 363, 'actual')).toBe(1)
  })

  it('defaults to fitBoth, so a caller that configures nothing is unchanged', () => {
    expect(computeFitScale(700, 480, 263, 363)).toBe(computeFitScale(700, 480, 263, 363, 'fitBoth'))
  })

  it('still respects the upscale ceiling in fitWidth', () => {
    expect(computeFitScale(700, 480, 10, 10, 'fitWidth')).toBe(MAX_FIT_UPSCALE)
  })

  it('returns 1 for degenerate inputs in every mode', () => {
    for (const mode of ['fitWidth', 'fitBoth', 'actual'] as const) {
      expect(computeFitScale(0, 480, 263, 363, mode)).toBe(1)
      expect(computeFitScale(700, 0, 263, 363, mode)).toBe(1)
      expect(computeFitScale(700, 480, 0, 363, mode)).toBe(1)
      expect(computeFitScale(700, 480, 263, 0, mode)).toBe(1)
    }
  })
})

describe('computeFitBoxHeight — the cap is an argument, not a constant', () => {
  it('honours an explicit maximum instead of 480', () => {
    // Width-fit height for 263x363 at 700 wide is 363 * (700/263) = 966.1.
    expect(computeFitBoxHeight(700, 263, 363, 2000)).toBeCloseTo(363 * (700 / 263), 4)
    expect(computeFitBoxHeight(700, 263, 363, 600)).toBe(600)
  })

  it('applies NO cap at all for null — what "No limit" resolves to', () => {
    expect(computeFitBoxHeight(700, 263, 363, null)).toBeCloseTo(363 * (700 / 263), 4)
    expect(computeFitBoxHeight(400, 400, 4000, null)).toBe(4000)
  })

  it('still defaults to the legacy constant, so an unconfigured caller is unchanged', () => {
    expect(computeFitBoxHeight(400, 400, 4000)).toBe(MAX_PREVIEW_HEIGHT)
    expect(computeFitBoxHeight(400, 400, 4000, MAX_PREVIEW_HEIGHT)).toBe(MAX_PREVIEW_HEIGHT)
  })

  it('never goes below the minimum, capped or not', () => {
    expect(computeFitBoxHeight(700, 10, 10, null)).toBe(MIN_PREVIEW_HEIGHT)
    expect(computeFitBoxHeight(700, 10, 10, 50)).toBe(MIN_PREVIEW_HEIGHT)
  })

  it('uses the diagram’s own height for actual size', () => {
    expect(computeFitBoxHeight(700, 263, 363, null, 'actual')).toBe(363)
    expect(computeFitBoxHeight(700, 263, 363, 200, 'actual')).toBe(200)
  })
})

describe('diagramFitTransform — a diagram larger than its box is anchored, not centred off-screen', () => {
  it('top-left anchors a fitWidth diagram taller than the box', () => {
    const { scale, offsetX, offsetY } = diagramFitTransform(700, 480, 263, 363, 'fitWidth')
    expect(scale).toBeCloseTo(700 / 263, 6)
    // 263 * 2.662 = 700 exactly, so there is no horizontal slack...
    expect(offsetX).toBeCloseTo(0, 6)
    // ...and the 966px-tall drawing would otherwise be centred at -243.
    expect(offsetY).toBe(0)
  })

  it('leaves a fitting diagram centred, exactly as before', () => {
    const { offsetX, offsetY } = diagramFitTransform(400, 400, 100, 200, 'fitBoth')
    expect(offsetX).toBe(100)
    expect(offsetY).toBe(0)
  })
})

describe('effectiveFitMode — fitWidth needs a way to reach what overflows', () => {
  it('keeps fitWidth while pan/zoom is available', () => {
    expect(effectiveFitMode('fitWidth', true)).toBe('fitWidth')
  })

  it('degrades fitWidth to fitBoth when pan/zoom is off, so nothing is unreachable', () => {
    expect(effectiveFitMode('fitWidth', false)).toBe('fitBoth')
  })

  it('leaves the other modes alone either way', () => {
    for (const zoomPan of [true, false]) {
      expect(effectiveFitMode('fitBoth', zoomPan)).toBe('fitBoth')
      expect(effectiveFitMode('actual', zoomPan)).toBe('actual')
    }
  })
})

describe('the mounted viewport applies the configured mode and cap', () => {
  it('fills the declared width in fitWidth, where fitBoth filled only half of it', () => {
    declaredHeight = VIEWPORT_HEIGHT
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitBoth', maxHeightPx: 480 }))
    })
    const bothScale = scaleOf(svgHost())
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', maxHeightPx: null }))
    })
    const widthScale = scaleOf(svgHost())

    expect(bothScale).toBeCloseTo(480 / 363, 4)
    expect(widthScale).toBeCloseTo(700 / 263, 4)
    // The drawn width as a fraction of the declared box: the metric the Chrome
    // harness reports. 0.497 before, 1.000 after.
    expect((263 * bothScale) / VIEWPORT_WIDTH).toBeCloseTo(0.497, 3)
    expect((263 * widthScale) / VIEWPORT_WIDTH).toBeCloseTo(1, 4)
  })

  it('publishes the applied mode, so the two surfaces can be checked against the DOM', () => {
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', zoomPan: true }))
    })
    expect(viewportBox().getAttribute('data-mermaid-fit-mode')).toBe('fitWidth')
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', zoomPan: false }))
    })
    // The degradation is visible, not silent.
    expect(viewportBox().getAttribute('data-mermaid-fit-mode')).toBe('fitBoth')
    expect(viewportBox().getAttribute('data-mermaid-zoom-pan')).toBe('false')
  })

  it('does NOT change the overflow rule, which is what keeps the fit deterministic', () => {
    for (const fitMode of ['fitWidth', 'fitBoth', 'actual'] as const) {
      act(() => {
        root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode, maxHeightPx: 200 }))
      })
      // A fit-dependent overflow would put a scrollbar up whose width the fit is
      // then measured against — the t111/M1 bug. It stays `hidden` whatever the
      // mode, even where the diagram overflows the box.
      expect(innerBox().style.overflow).toBe('hidden')
    }
  })

  it('hides the zoom cluster and the grab cursor when pan/zoom is off', () => {
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, zoomPan: true }))
    })
    expect(controlsPill()).not.toBeNull()
    expect(innerBox().style.cursor).toBe('grab')
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, zoomPan: false }))
    })
    expect(controlsPill()).toBeNull()
    expect(innerBox().style.cursor).toBe('default')
  })

  it('paints the editor surface only for a themed background', () => {
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, background: 'transparent' }))
    })
    expect(viewportBox().getAttribute('data-mermaid-background')).toBe('transparent')
    expect(innerBox().style.background).toBe('')
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, background: 'themed' }))
    })
    expect(viewportBox().getAttribute('data-mermaid-background')).toBe('themed')
    expect(innerBox().style.background).toContain('--sn-stylekit-background-color')
  })

  it('grows the box past the old 480 ceiling when the cap allows it', () => {
    declaredHeight = VIEWPORT_HEIGHT
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', maxHeightPx: null }))
    })
    const uncapped = parseFloat(innerBox().style.height)
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', maxHeightPx: 480 }))
    })
    const capped = parseFloat(innerBox().style.height)
    expect(uncapped).toBeCloseTo(363 * (700 / 263), 2)
    expect(uncapped).toBeGreaterThan(480)
    expect(capped).toBe(480)
  })

  it('anchors the overflowing drawing at the top of the box, not above it', () => {
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg: TALL_SVG, fitMode: 'fitWidth', maxHeightPx: 300 }))
    })
    const { x, y } = translateOf(svgHost())
    expect(y).toBe(0)
    expect(x).toBeCloseTo(0, 4)
  })
})
