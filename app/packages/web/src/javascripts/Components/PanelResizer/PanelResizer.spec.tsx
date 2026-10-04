/**
 * @jest-environment jsdom
 *
 * REGRESSION GATE: "List unavailable" when the notes list is resized too small.
 *
 * THE BUG, NAMED. Dragging the notes list resizer below its 200px minimum made the
 * list pane read "List unavailable" — the custom fallback of the `regionName="Note
 * list"` ComponentErrorBoundary in `PanesSystemComponent`, which renders only when
 * the boundary has caught a real error. Captured live in headless Chrome against
 * the running app, the error that fallback was hiding is:
 *
 *   [ComponentErrorBoundary] Error rendering Note list:
 *   Error: Minified React error #185
 *     at Object.enqueueSetState
 *     at y.setState
 *     at kR.componentDidUpdate          <- PanelResizer.componentDidUpdate
 *
 * React #185 is "Maximum update depth exceeded. This can happen when a component
 * repeatedly calls setState inside componentWillUpdate or componentDidUpdate."
 * (`react-dom` throws it at `nestedUpdateCount > 50`.) The only `setState` in
 * `PanelResizer.componentDidUpdate` is the `{ collapsed }` one, so the oscillating
 * value is the collapsed flag.
 *
 * THE MECHANISM, MEASURED. `componentDidUpdate` set `lastWidth` from
 * `panel.scrollWidth` and `isCollapsed()` was `lastWidth <= minWidth`. scrollWidth
 * is the panel's CONTENT extent, and this component renders a child INTO the panel
 * that deliberately overflows it: the collapsed "Expand panel" chevron, absolutely
 * positioned to straddle the panel edge (`right-0 translate-x-1/2`, 16px wide).
 * Measured on the live notes column at a 400px panel:
 *
 *   | measurement                      | without chevron | with chevron |
 *   |----------------------------------|-----------------|--------------|
 *   | panel.scrollWidth                |             399 |          407 |
 *   | panel.getBoundingClientRect().w  |             400 |          400 |
 *
 * So the collapse predicate was a function of its own render output. Drag the list
 * to its clamped 200px minimum and scrollWidth is 199 against a minWidth of 200:
 * collapsed -> true, chevron mounts, scrollWidth -> 207, collapsed -> false,
 * chevron unmounts, scrollWidth -> 199, ... 50 nested setStates and React throws.
 * The flip window is scrollWidth in (minWidth - 8, minWidth], and the 200px clamp
 * lands the pane dead in the middle of it, which is why "resize it too small"
 * reproduced every single time.
 *
 * WHY THESE TESTS AND NOT AN E2E. jsdom has no layout engine, so the real numbers
 * had to come from Chrome — but once they are known the loop is reproducible here,
 * because it is entirely internal to PanelResizer. The fake panel below models the
 * two measured columns of that table exactly: a bounding-rect width that ignores
 * its children, and a `scrollWidth` that is `width - 1` and gains 8px while the
 * chevron is mounted. Every test here fails on the pre-fix source.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'

import PanelResizer, { clampPanelWidth, PanelResizeType, PanelSide } from './PanelResizer'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ITEMS_PANEL_MIN_WIDTH = 200
const EXPAND_BUTTON_SELECTOR = 'button[aria-label="Expand panel"]'

/** The overhang the collapsed chevron adds to the panel's scrollable extent. */
const CHEVRON_SCROLL_OVERHANG = 8

const domRect = (x: number, width: number): DOMRect => ({
  x,
  y: 0,
  width,
  height: 600,
  top: 0,
  left: x,
  right: x + width,
  bottom: 600,
  toJSON: () => ({}),
})

type Harness = {
  /** The panel element PanelResizer is given, and renders into. */
  panel: HTMLDivElement
  /** `#app` — the panel's parent, so it is both `appFrame` and `getParentRect()`. */
  appElement: HTMLDivElement
  root: Root
  /** The panel's live border-box width, as the parent grid would set it. */
  box: { width: number }
  widths: number[]
  finishes: Array<{ width: number; collapsed: boolean }>
  /** Re-render at `width`, with the panel's box already sized to it. */
  render: (width: number) => void
  resizer: () => HTMLDivElement
  expandButton: () => HTMLButtonElement | null
  teardown: () => void
}

function mountHarness(
  options: { width?: number; minWidth?: number; appWidth?: number; panelX?: number } = {},
): Harness {
  const { width = 400, minWidth = ITEMS_PANEL_MIN_WIDTH, appWidth = 1400, panelX = 220 } = options

  // PanelResizer skips its layout reads until the page has loaded; the whole point
  // of these tests is the loaded behaviour.
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })

  const appElement = document.createElement('div')
  appElement.id = 'app'
  const panel = document.createElement('div')
  appElement.appendChild(panel)
  document.body.appendChild(appElement)

  const box = { width }

  Object.defineProperty(appElement, 'getBoundingClientRect', {
    value: () => domRect(0, appWidth),
    configurable: true,
  })
  Object.defineProperty(panel, 'getBoundingClientRect', {
    // The border box. Immune to what the panel's children do — which is the whole
    // invariant under test.
    value: () => domRect(panelX, box.width),
    configurable: true,
  })
  Object.defineProperty(panel, 'scrollWidth', {
    // The CONTENT extent, modelled from the Chrome measurements in the header: one
    // pixel of border short of the box, plus the collapsed chevron's overhang
    // while that chevron is mounted.
    get: () => Math.round(box.width) - 1 + (panel.querySelector(EXPAND_BUTTON_SELECTOR) ? CHEVRON_SCROLL_OVERHANG : 0),
    configurable: true,
  })
  Object.defineProperty(panel, 'offsetLeft', { value: panelX, configurable: true })

  // PanelResizer renders INTO the panel in the real app (it is a child of
  // ContentListView's root element, which is the panel), so the chevron really is
  // a descendant of the element whose width is being measured.
  const root = createRoot(panel)

  const widths: number[] = []
  const finishes: Array<{ width: number; collapsed: boolean }> = []

  const render = (nextWidth: number) => {
    // The parent grid decides the panel's column width from this value and the
    // browser has it applied before the child's commit hooks force their layout
    // read, so the box is sized first.
    box.width = nextWidth
    act(() => {
      root.render(
        createElement(PanelResizer, {
          collapsable: true,
          defaultWidth: 400,
          hoverable: true,
          left: 0,
          minWidth,
          modifyElementWidth: false,
          panel,
          side: PanelSide.Right,
          type: PanelResizeType.WidthOnly,
          width: nextWidth,
          widthEventCallback: (reported: number) => {
            widths.push(reported)
            // The parent's only response to this callback is to set the pane's
            // grid column to the reported width (`setItemsPanelWidth`), and that
            // lands in the same React batch — so the panel's box follows it
            // synchronously, exactly as it does in the app.
            box.width = reported
          },
          resizeFinishCallback: (reported: number, _left: number, _max: boolean, collapsed: boolean) => {
            finishes.push({ width: reported, collapsed })
          },
        }),
      )
    })
  }

  render(width)

  return {
    panel,
    appElement,
    root,
    box,
    widths,
    finishes,
    render,
    resizer: () => panel.querySelector('.panel-resizer') as HTMLDivElement,
    expandButton: () => panel.querySelector(EXPAND_BUTTON_SELECTOR) as HTMLButtonElement | null,
    teardown: () => {
      act(() => root.unmount())
      appElement.remove()
    },
  }
}

const mouseEvent = (type: string, clientX: number) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 300 })

describe('PanelResizer — "List unavailable" at the narrowest width', () => {
  let harness: Harness | undefined

  afterEach(() => {
    harness?.teardown()
    harness = undefined
  })

  it("does not blow React's nested-update limit when dragged below its minimum", () => {
    harness = mountHarness({ width: 400 })
    const { resizer, render, widths, expandButton } = harness

    // Drag the resizer far left: a requested width of 80 against a 200 minimum.
    act(() => {
      resizer().dispatchEvent(mouseEvent('mousedown', 620))
    })
    act(() => {
      document.dispatchEvent(mouseEvent('mousemove', 300))
    })

    expect(widths[widths.length - 1]).toBe(ITEMS_PANEL_MIN_WIDTH)

    // The parent applies the clamped width — this is the commit that used to
    // oscillate. `act` rethrows React's "Maximum update depth exceeded", so this
    // line IS the assertion that the loop is gone.
    render(ITEMS_PANEL_MIN_WIDTH)

    act(() => {
      document.dispatchEvent(mouseEvent('mouseup', 300))
    })

    // A 200px notes list is narrow, not collapsed: no expand affordance over it.
    expect(expandButton()).toBeNull()
    expect(harness.finishes[harness.finishes.length - 1]).toEqual({
      width: ITEMS_PANEL_MIN_WIDTH,
      collapsed: false,
    })
  })

  it("reports the panel's box width, not its content extent, as the resized width", () => {
    harness = mountHarness({ width: 400 })

    harness.render(260)
    act(() => {
      harness?.resizer().dispatchEvent(mouseEvent('mousedown', 480))
    })
    act(() => {
      document.dispatchEvent(mouseEvent('mouseup', 480))
    })

    // scrollWidth would say 259 and persist a pane that creeps 1px narrower on
    // every single resize.
    expect(harness.finishes[harness.finishes.length - 1].width).toBe(260)
  })

  it('stays collapsed once collapsed — the chevron must not move the measured width', () => {
    harness = mountHarness({ width: 400 })
    const { resizer, render, expandButton } = harness

    act(() => {
      resizer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })

    // Collapsed to the sliver, NOT to the 200px drag minimum.
    expect(harness.widths[harness.widths.length - 1]).toBe(8)
    expect(expandButton()).not.toBeNull()

    // The parent applies the collapsed width. With the chevron mounted the panel's
    // CONTENT extent is 7 + 8 = 15, which is above the collapsed threshold — so a
    // predicate reading scrollWidth flips collapsed off, unmounts the chevron,
    // reads 7, flips it back on... and React throws here. The bounding-rect width
    // is 8 either way.
    render(8)

    expect(expandButton()).not.toBeNull()
  })

  it('expands back out of the collapsed state and floors at the minimum again', () => {
    harness = mountHarness({ width: 400 })
    const { resizer, render, expandButton } = harness

    act(() => {
      resizer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    render(8)
    expect(expandButton()).not.toBeNull()

    act(() => {
      expandButton()?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(harness.widths[harness.widths.length - 1]).toBe(400)
    render(400)
    expect(expandButton()).toBeNull()
  })

  it('survives #app being absent instead of dereferencing a typed-away undefined', () => {
    harness = mountHarness({ width: 400 })
    harness.appElement.remove()

    // `appFrame` was `getElementById('app')?.getBoundingClientRect() as DOMRect`:
    // the cast asserted away exactly this case, so setWidth's `appFrame.width`
    // threw a TypeError out of componentDidUpdate. `act` rethrows it.
    harness.render(300)

    expect(harness.widths[harness.widths.length - 1]).toBe(300)
  })

  it('never reports a width below the floor, even when the app frame is narrower', () => {
    // An app frame no wider than the panel's own offset makes the max-width clamp
    // `appFrame.width - panel.x` zero, and narrower still makes it NEGATIVE. A
    // negative width reaches the parent grid as an invalid track, the browser
    // drops the whole `grid-template-columns`, the panel moves, and it re-clamps.
    harness = mountHarness({ width: 300, appWidth: 220, panelX: 220 })

    expect(harness.widths.length).toBeGreaterThan(0)
    for (const reported of harness.widths) {
      expect(reported).toBeGreaterThanOrEqual(ITEMS_PANEL_MIN_WIDTH)
    }
  })
})

describe('clampPanelWidth', () => {
  it('raises a restored width that is below the pane minimum', () => {
    expect(clampPanelWidth(5, 200, 400)).toBe(200)
    expect(clampPanelWidth(199.5, 200, 400)).toBe(200)
  })

  it('leaves a restored width at or above the minimum alone', () => {
    expect(clampPanelWidth(200, 200, 400)).toBe(200)
    expect(clampPanelWidth(640, 200, 400)).toBe(640)
  })

  it('falls back to the pane DEFAULT, not the minimum, for an unusable value', () => {
    // "never configured" and "dragged as narrow as it goes" are different facts
    // and must not restore identically.
    expect(clampPanelWidth(undefined, 200, 400)).toBe(400)
    expect(clampPanelWidth(null, 200, 400)).toBe(400)
    expect(clampPanelWidth(0, 200, 400)).toBe(400)
    expect(clampPanelWidth(-20, 200, 400)).toBe(400)
    expect(clampPanelWidth(Number.NaN, 200, 400)).toBe(400)
    expect(clampPanelWidth(Number.POSITIVE_INFINITY, 200, 400)).toBe(400)
  })
})
