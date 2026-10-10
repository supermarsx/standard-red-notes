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
  computeFitScale,
  diagramFitTransform,
  AUTO_FIT_MAX_UPSCALE,
  fitUpscaleCeiling,
  MAX_FIT_UPSCALE,
  MAX_PREVIEW_HEIGHT,
  MIN_PREVIEW_HEIGHT,
  parseSvgNaturalSize,
  pinSvgToNaturalSize,
  resolveViewportOverflowBeforeMeasuring,
  viewportOverflowFor,
} from './MermaidSvgViewport'
import { type MermaidFitMode } from './MermaidSettings'

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

// The editor's own DEFAULT diagram, at the size mermaid@11.16.1 really renders
// it (measured in headless Chrome): narrower than any note column, which is why
// it used to sit in the middle of its box as a speck.
const DEFAULT_DIAGRAM_SVG =
  '<svg id="mermaid-default" width="100%" style="max-width: 263.375px;" viewBox="0 0 263.375 363.359375" xmlns="http://www.w3.org/2000/svg"><g><rect width="40" height="20"/></g></svg>'

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

const render = (svg: string, props: { fitMode?: MermaidFitMode } = {}) => {
  act(() => {
    root.render(createElement(MermaidSvgViewport, { svg, ...props }))
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

/**
 * t113: the two measured reasons a diagram did not fill its box. Neither is a
 * geometry claim — jsdom reports 0 for every rect — they are claims about the
 * arithmetic and about the attributes written onto the <svg>. The on-screen
 * numbers were taken in headless Chrome; see the header of MermaidSvgViewport.tsx.
 */
describe('computeFitScale (pure) — WHO is allowed to scale a diagram UP', () => {
  it('upscales for an explicit fitWidth, which is what that mode means', () => {
    // 700/263.375 = 2.6578, under the 3x ceiling.
    expect(computeFitScale(700, 480, 263.375, 363.359375, 'fitWidth')).toBeCloseTo(700 / 263.375, 6)
    expect(computeFitScale(700, 480, 263.375, 363.359375, 'fitWidth')).toBeGreaterThan(1)
  })

  it('does NOT upscale for the default fit — the chart was rendered way too wide', () => {
    // The regression this pins: with `fitWidth` as the default AND the box cap
    // coming from 0.9 x window.innerHeight, this 263x363 diagram was drawn
    // 650x897 in a 668px note column, at 247%. The default must stop at 1:1.
    expect(computeFitScale(700, 480, 263.375, 363.359375)).toBe(1)
    expect(computeFitScale(700, 480, 263.375, 363.359375, 'fitBoth')).toBe(1)
    // And it is bounded there however much room the box offers, which is the
    // property that stops ANY container — a window-derived one included — from
    // setting an un-configured diagram's scale.
    expect(computeFitScale(4000, 4000, 263.375, 363.359375)).toBe(1)
  })

  it('still scales a too-wide diagram DOWN, exactly as before', () => {
    expect(computeFitScale(400, 200, 800, 400)).toBe(0.5)
    // ...in both fitting modes: shrinking to fit is never the thing in dispute.
    expect(computeFitScale(400, 200, 800, 400, 'fitWidth')).toBe(0.5)
  })

  it('is bounded by MAX_FIT_UPSCALE so a two-box fitWidth cannot fill a screen', () => {
    expect(computeFitScale(700, 480, 10, 10, 'fitWidth')).toBe(MAX_FIT_UPSCALE)
    // The default's ceiling is the tighter one, and they are different numbers.
    expect(computeFitScale(700, 480, 10, 10)).toBe(AUTO_FIT_MAX_UPSCALE)
    expect(AUTO_FIT_MAX_UPSCALE).toBeLessThan(MAX_FIT_UPSCALE)
  })

  it('reports its ceiling per mode, so the scale and the box height agree', () => {
    expect(fitUpscaleCeiling('fitWidth')).toBe(MAX_FIT_UPSCALE)
    expect(fitUpscaleCeiling('fitBoth')).toBe(AUTO_FIT_MAX_UPSCALE)
    expect(fitUpscaleCeiling('actual')).toBe(AUTO_FIT_MAX_UPSCALE)
  })

  it('fits the more constrained axis', () => {
    // Width-bound: 400/800 = 0.5 is smaller than 600/400 = 1.5.
    expect(computeFitScale(400, 600, 800, 400)).toBe(0.5)
    // Height-bound: 300/400 = 0.75 is smaller than 900/800 = 1.125.
    expect(computeFitScale(900, 300, 800, 400)).toBe(0.75)
  })

  it('returns 1 for degenerate inputs rather than NaN or Infinity', () => {
    expect(computeFitScale(0, 480, 263, 363)).toBe(1)
    expect(computeFitScale(700, 0, 263, 363)).toBe(1)
    expect(computeFitScale(700, 480, 0, 363)).toBe(1)
    expect(computeFitScale(700, 480, 263, 0)).toBe(1)
  })
})

describe('diagramFitTransform (pure)', () => {
  it('centres the fitted diagram in the box', () => {
    const { scale, offsetX, offsetY } = diagramFitTransform(400, 200, 800, 400)
    expect(scale).toBe(0.5)
    expect(offsetX).toBe(0)
    expect(offsetY).toBe(0)
  })

  it('centres an upscaled diagram too', () => {
    // Upscaling is fitWidth's job now, so this asks for it explicitly. 100x50 in
    // a 400x400 box wants 4x and gets the 3x ceiling: drawn 300x150, with real
    // slack on both axes.
    const { scale, offsetX, offsetY } = diagramFitTransform(400, 400, 100, 50, 'fitWidth')
    expect(scale).toBe(3)
    expect(offsetX).toBe(50)
    expect(offsetY).toBe(125)
  })

  it('centres a diagram the DEFAULT fit leaves at its natural size', () => {
    // 100x200 in a 400x400 box: no upscale, so it is centred with real slack on
    // both axes — this is what a small diagram now looks like in a wide column.
    const { scale, offsetX, offsetY } = diagramFitTransform(400, 400, 100, 200)
    expect(scale).toBe(1)
    expect(offsetX).toBe(150)
    expect(offsetY).toBe(100)
  })

  it('degrades to the identity transform rather than dividing by zero', () => {
    expect(diagramFitTransform(0, 0, 0, 0)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 })
  })
})

describe('computeFitBoxHeight — the box is allowed to grow for an upscaled diagram', () => {
  it('sizes the box for the upscaled width-fit of a narrow diagram', () => {
    // 200 wide in a 400 box doubles; 100 tall therefore needs 200.
    expect(computeFitBoxHeight(400, 200, 100, MAX_PREVIEW_HEIGHT, 'fitWidth')).toBe(200)
  })

  it('does not let the upscale cap be exceeded when sizing the box', () => {
    // 10 wide in a 700 box would be 70x, capped at MAX_FIT_UPSCALE.
    expect(computeFitBoxHeight(700, 10, 10, MAX_PREVIEW_HEIGHT, 'fitWidth')).toBe(MIN_PREVIEW_HEIGHT)
    expect(computeFitBoxHeight(700, 10, 100, MAX_PREVIEW_HEIGHT, 'fitWidth')).toBe(100 * MAX_FIT_UPSCALE)
  })

  it('sizes the DEFAULT box to the diagram, not to the room on offer', () => {
    // The other half of the "gigantic container" fix: the box must be exactly
    // as tall as the diagram drawn in it. When the height was computed from an
    // upscale the default fit would then refuse, a 263x363 flowchart sat in an
    // 897px box with 534px of empty space under it.
    expect(computeFitBoxHeight(400, 200, 100)).toBe(100)
    expect(computeFitBoxHeight(650, 263, 363, 900)).toBe(363)
    // ...and no cap at all cannot change that, because nothing is upscaling.
    expect(computeFitBoxHeight(650, 263, 363, null)).toBe(363)
    expect(computeFitBoxHeight(4000, 263, 363, null)).toBe(363)
  })

  it('still shrinks the box for a diagram WIDER than the viewport', () => {
    // Shrink-to-fit is untouched by the ceiling: 1339x94 at 650 wide.
    expect(computeFitBoxHeight(650, 1339, 94, 900)).toBe(MIN_PREVIEW_HEIGHT)
    expect(computeFitBoxHeight(650, 1339, 940, 900)).toBeCloseTo(940 * (650 / 1339), 4)
  })
})

describe('pinSvgToNaturalSize — mermaid’s width="100%" is replaced by a definite size', () => {
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
  })

  afterEach(() => host.remove())

  it('replaces the percentage width and clears mermaid’s max-width', () => {
    host.innerHTML = WIDE_MERMAID_SVG
    const before = host.firstElementChild as SVGElement
    expect(before.getAttribute('width')).toBe('100%')
    expect(before.getAttribute('style')).toContain('max-width: 800px')

    pinSvgToNaturalSize(host, 800, 400)

    const svg = host.firstElementChild as SVGElement
    expect(svg.getAttribute('width')).toBe('800')
    expect(svg.getAttribute('height')).toBe('400')
    expect(svg.style.width).toBe('800px')
    expect(svg.style.height).toBe('400px')
    // Without this, mermaid's own max-width would still cap the element.
    expect(svg.style.maxWidth).toBe('none')
  })

  it('does nothing — and does not throw — when there is no svg to pin', () => {
    host.innerHTML = '<p>not a diagram</p>'
    expect(() => pinSvgToNaturalSize(host, 800, 400)).not.toThrow()
    expect(host.innerHTML).toBe('<p>not a diagram</p>')
  })

  it('does nothing for a degenerate natural size', () => {
    host.innerHTML = WIDE_MERMAID_SVG
    pinSvgToNaturalSize(host, 0, 400)
    expect((host.firstElementChild as SVGElement).getAttribute('width')).toBe('100%')
  })
})

describe('MermaidSvgViewport — the mounted component applies both fixes', () => {
  it('leaves the default diagram at 100% rather than inflating it to fill the box', () => {
    render(DEFAULT_DIAGRAM_SVG)
    // Stub viewport is 400x300. This used to read 132%, because the box height
    // was sized for a 1.519x width-fit and the scale then followed it; the
    // window-derived cap turned the same arithmetic into 247% on a real screen.
    // The default fit now stops at 1:1, so the box is the diagram's own 363px.
    expect(percentButton().textContent).toBe('100%')
    expect(svgHost().style.transform).toContain('scale(1)')
  })

  it('still upscales when the user asks for fitWidth', () => {
    render(DEFAULT_DIAGRAM_SVG, { fitMode: 'fitWidth' })
    // 400/263.375 = 1.519 — the same box, the same diagram, an explicit choice.
    expect(percentButton().textContent).toBe('152%')
    expect(svgHost().style.transform).toContain('scale(1.51')
  })

  it('pins the rendered svg to its natural size, so the fit scale means what it says', () => {
    render(DEFAULT_DIAGRAM_SVG)
    const svg = svgHost().querySelector('svg') as SVGElement
    expect(svg.getAttribute('width')).toBe('263.375')
    expect(svg.style.maxWidth).toBe('none')
  })

  it('gives the svg host a definite size rather than leaving it shrink-to-fit', () => {
    render(DEFAULT_DIAGRAM_SVG)
    expect(svgHost().style.width).toBe('263.375px')
    expect(svgHost().style.height).toBe('363.359375px')
  })

  it('leaves the host unsized when the diagram’s size is unknown', () => {
    render(UNSIZED_SVG)
    expect(svgHost().style.width).toBe('')
  })
})

describe('MermaidSvgViewport — an explicit height overrides the auto-fit box', () => {
  const renderWithHeight = (svg: string, heightOverride?: number) => {
    act(() => {
      root.render(createElement(MermaidSvgViewport, { svg, heightOverride }))
    })
  }
  const viewportBox = () => container.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement

  it('uses the stored height instead of the computed one', () => {
    renderWithHeight(WIDE_MERMAID_SVG, 150)
    expect(viewportBox().style.height).toBe('150px')
  })

  it('re-fits the diagram inside that resized box', () => {
    renderWithHeight(WIDE_MERMAID_SVG, 150)
    // min(400/800 = 0.5, 150/400 = 0.375) = 0.375.
    expect(percentButton().textContent).toBe('38%')
  })

  it('returns to the auto-fit height when the override is cleared', () => {
    renderWithHeight(WIDE_MERMAID_SVG, 150)
    expect(viewportBox().style.height).toBe('150px')
    renderWithHeight(WIDE_MERMAID_SVG, undefined)
    expect(viewportBox().style.height).toBe('200px')
  })

  it('renders controls passed as children, outside the clipping box', () => {
    act(() => {
      root.render(
        createElement(
          MermaidSvgViewport,
          { svg: WIDE_MERMAID_SVG },
          createElement('span', { 'data-test-child': 'true' }),
        ),
      )
    })
    const child = container.querySelector('[data-test-child="true"]')
    expect(child).not.toBeNull()
    // A sibling of the overflow:hidden box, not a descendant of it.
    expect(viewportBox().contains(child)).toBe(false)
  })
})

/**
 * t111/M1: the fit was measured one scrollbar short of the box.
 *
 * jsdom has no layout engine and no scrollbars, so the scrollbar here is
 * DECLARED, never measured: `clientWidth` is stubbed to subtract a 15px gutter
 * exactly when the element it is read from is currently scrollable
 * (`overflow: auto`), which is what Chrome really reports for a classic
 * scrollbar. That models the one fact the bug turned on — the component read
 * `clientWidth` while the box still carried the pre-measurement `overflow:
 * auto` and the just-pinned SVG was overflowing it.
 *
 * The real numbers are in headless Chrome: over 10 fresh-browser runs per case,
 * the first fit read 685 of a 700px column (and 319 of 334) in 10 of 10 runs
 * before this fix, and a frame-dependent ResizeObserver delivery corrected it in
 * only 5-8 of them; afterwards every run of every case agreed. See the header of
 * MermaidSvgViewport.tsx.
 */
describe('viewportOverflowFor (pure)', () => {
  it('clips once the diagram can be fitted, and scrolls while it cannot', () => {
    expect(viewportOverflowFor(true)).toBe('hidden')
    expect(viewportOverflowFor(false)).toBe('auto')
  })
})

describe('resolveViewportOverflowBeforeMeasuring', () => {
  it('writes the clipping overflow onto the box so a later clientWidth read has no gutter in it', () => {
    const box = document.createElement('div')
    box.style.overflow = 'auto'
    resolveViewportOverflowBeforeMeasuring(box, true)
    expect(box.style.overflow).toBe('hidden')
  })

  it('leaves the scrollable fallback in place when the diagram cannot be sized', () => {
    const box = document.createElement('div')
    box.style.overflow = 'hidden'
    resolveViewportOverflowBeforeMeasuring(box, false)
    expect(box.style.overflow).toBe('auto')
  })

  it('does nothing — and does not throw — before the box exists', () => {
    expect(() => resolveViewportOverflowBeforeMeasuring(null, true)).not.toThrow()
  })
})

describe('MermaidSvgViewport — the fit does not lose a scrollbar’s width', () => {
  const SCROLLBAR_WIDTH = 15
  // Every clientWidth read taken from the viewport box, with the box's own
  // inline overflow AT THAT MOMENT. A read taken at `auto` is a read taken
  // through a scrollbar gutter.
  let overflowAtRead: string[]

  beforeEach(() => {
    overflowAtRead = []
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLElement) {
        // The box itself, identified by the SVG host it wraps — not the
        // controls pill, which is its sibling under the same wrapper.
        const isViewportBox = this.firstElementChild?.getAttribute('data-mermaid-svg-host') === 'true'
        const scrollable = this.style.overflow === 'auto' || this.style.overflow === 'scroll'
        if (isViewportBox) {
          overflowAtRead.push(this.style.overflow || 'none')
        }
        return scrollable ? STUB_VIEWPORT_WIDTH - SCROLLBAR_WIDTH : STUB_VIEWPORT_WIDTH
      },
    })
  })

  const fitScale = () => {
    const match = /scale\(([\d.]+)\)/.exec(svgHost().style.transform)
    expect(match).not.toBeNull()
    return parseFloat((match as RegExpExecArray)[1])
  }

  it('measures the box only after its overflow is the one this render commits', () => {
    render(WIDE_MERMAID_SVG)
    // Non-vacuous by construction: an empty log fails on the first read, and
    // `auto` anywhere in it is the defect.
    expect(overflowAtRead[0]).toBe('hidden')
    expect(overflowAtRead).not.toContain('auto')
  })

  it('fits the 800px diagram to the FULL 400px box, not to 385px of it', () => {
    render(WIDE_MERMAID_SVG)
    // 400/800 exactly. Through a 15px gutter this would be 385/800 = 0.48125,
    // and the diagram would be drawn 385px wide in a 400px box.
    expect(fitScale()).toBe(0.5)
    expect(fitScale() * 800).toBe(STUB_VIEWPORT_WIDTH)
    expect(percentButton().textContent).toBe('50%')
  })

  it('sizes the box from the full width too (400/800 * 400 = 200px, not 192.5px)', () => {
    render(WIDE_MERMAID_SVG)
    const viewport = container.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement
    expect(viewport.style.height).toBe('200px')
  })

  it('centres the diagram in the full box rather than in the box minus a scrollbar', () => {
    // 400 wide box, diagram fitted to 200px wide: a 100px left offset. Measured
    // through a gutter it would be (385 - 192.5) / 2 = 96.25.
    render(DEFAULT_DIAGRAM_SVG)
    const scale = fitScale()
    const drawnWidth = 263.375 * scale
    const expectedOffsetX = (STUB_VIEWPORT_WIDTH - drawnWidth) / 2
    expect(svgHost().style.transform).toContain(`translate(${expectedOffsetX}px`)
  })

  it('still leaves the box scrollable when the diagram’s size is unknown', () => {
    render(UNSIZED_SVG)
    const viewport = container.querySelector('[data-mermaid-viewport="true"]')?.firstElementChild as HTMLElement
    expect(viewport.style.overflow).toBe('auto')
  })

  it('re-resolves the overflow for a new diagram, so a re-fit is not measured through a gutter either', () => {
    render(UNSIZED_SVG)
    overflowAtRead = []
    render(WIDE_MERMAID_SVG)
    expect(overflowAtRead[0]).toBe('hidden')
    expect(overflowAtRead).not.toContain('auto')
    expect(fitScale()).toBe(0.5)
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
