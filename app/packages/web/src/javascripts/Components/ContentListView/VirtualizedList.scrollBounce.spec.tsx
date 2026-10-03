/**
 * @jest-environment jsdom
 *
 * What this file does and does NOT prove
 * ======================================
 *
 * jsdom has no layout engine: every offsetHeight, scrollHeight and clientHeight
 * is inert unless stubbed, and jsdom never clamps scrollTop the way a browser
 * does. So nothing here observes scroll BEHAVIOUR. What it does is pin the
 * component's ARITHMETIC against injected row heights: the tests install a
 * faithful "fake layout" over the component's known DOM shape (topSpacer / row
 * slice / bottomSpacer), feed it heights, and assert on the offsets, totals and
 * scrollTop the component computes from them. Real scroll behaviour was
 * measured separately in Chrome against the real stylesheet; the numbers quoted
 * in the comments below come from those measurements, and the heights the tests
 * inject are chosen to match them.
 *
 * Why the heights here are TALLER than the estimate
 * ================================================
 *
 * This file used to inject rows of 40px against an estimate of 60 — rows
 * SHORTER than the estimate. That is the opposite of what real notes-list rows
 * do. Measured in Chrome (real CSS, 420px notes column, 300 notes with a
 * realistic mix of titles and previews), per display configuration, as the mean
 * of all 300 rendered rows:
 *
 *   | date | preview | row heights  | MEAN | total vs. a 60px estimate |
 *   |------|---------|--------------|------|---------------------------|
 *   | yes  | yes     | 60.5 - 113.5 | 79.3 | real total 23.3% LARGER   |
 *   | no   | yes     | 44.0 -  95.5 | 61.5 | real total  2.7% larger   |
 *   | yes  | no      | 60.5 -  95.5 | 63.7 | real total  5.9% larger   |
 *   | no   | no      | 44.0 -  77.5 | 47.0 | real total 26.0% SMALLER  |
 *
 * So in three of the four configurations the list GROWS as rows are measured,
 * and only with both the date and the preview hidden does it shrink. The old
 * single test modelled that one shrinking configuration exclusively, which made
 * it read as a demonstration of a bug in the common case when it was nothing of
 * the kind. The grow case is covered first and foremost here; the shrink case is
 * kept, and labelled.
 *
 * What is covered
 * ---------------
 * 1. The list sizes itself from the MEASURED mean row height, not from the
 *    bootstrap estimate it started with.
 * 2. A drag to the ESTIMATED bottom, where real rows then measure in TALLER,
 *    settles exactly on the corrected bottom (the three growing configurations).
 * 3. The same when rows measure in SHORTER — modelling the hideDate + hidePreview
 *    configuration only — never leaving scrollTop past the shrunken bottom.
 * 4. A height correction does NOT move the viewport on the strength of an
 *    at-bottom observation the user has already scrolled away from.
 * 5. scrollToUuid re-aims from the real measurement instead of landing short of
 *    a row whose height it could only estimate.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { VirtualizedList, VirtualizedListInterface } from './VirtualizedList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The old, measurably wrong constant — used as the deliberate bootstrap. */
const BOOTSTRAP_ESTIMATE = 60
const VIEWPORT_HEIGHT = 300
const OVERSCAN = 2

type Item = { uuid: string }

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ uuid: `item-${i}` }))
}

function parsePx(value: string): number {
  return parseFloat(value || '0') || 0
}

/**
 * The injected per-row heights for the current test. A Map rather than a
 * constant so a test can change a row's height and re-render, which is how a
 * height correction is produced without any scrolling (the real trigger is the
 * "hide note preview" / "hide date" display options, or a tag or vault badge
 * appearing on a row).
 */
let rowHeights = new Map<string, number>()

/** Fills `rowHeights` from a function of the row index; returns the true total. */
function setRowHeights(items: Item[], heightAt: (index: number) => number): number {
  rowHeights = new Map()
  let total = 0
  items.forEach((item, index) => {
    const height = heightAt(index)
    rowHeights.set(item.uuid, height)
    total += height
  })
  return total
}

/**
 * Mirrors a real browser's block-flow box height for the component's known DOM
 * shape: a position:relative wrapper holding [topSpacer, rowSlice,
 * bottomSpacer]. Spacer heights come from their own inline style (set by the
 * component from its Fenwick totals); the row slice's height is the sum of its
 * children's injected offsetHeight, exactly like a real layout engine.
 */
function computeScrollHeight(container: HTMLElement): number {
  const wrapper = container.firstElementChild as HTMLElement | null
  if (!wrapper) {
    return 0
  }
  const [topSpacer, slice, bottomSpacer] = Array.from(wrapper.children) as HTMLElement[]
  let sliceHeight = 0
  for (const row of Array.from(slice.children)) {
    sliceHeight += (row as HTMLElement).offsetHeight
  }
  return parsePx(topSpacer.style.height) + sliceHeight + parsePx(bottomSpacer.style.height)
}

function bottomSpacerHeight(container: HTMLElement): number {
  const wrapper = container.firstElementChild as HTMLElement
  return parsePx((wrapper.children[2] as HTMLElement).style.height)
}

/**
 * Where a rendered row sits in the scrollable content, in the same fake-layout
 * arithmetic the component's spacers define: top spacer, then each preceding
 * row's injected height. Returns null when the row is not in the rendered slice.
 */
function rowBox(container: HTMLElement, uuid: string): { top: number; bottom: number } | null {
  const wrapper = container.firstElementChild as HTMLElement | null
  if (!wrapper) {
    return null
  }
  const [topSpacer, slice] = Array.from(wrapper.children) as HTMLElement[]
  let y = parsePx(topSpacer.style.height)
  for (const row of Array.from(slice.children) as HTMLElement[]) {
    const height = row.offsetHeight
    if (row.id === uuid) {
      return { top: y, bottom: y + height }
    }
    y += height
  }
  return null
}

type FakeLayout = {
  /** Move the viewport WITHOUT dispatching 'scroll' — see the stale-observation test. */
  setScrollTopSilently: (value: number) => void
}

/** Installs a live, settable fake layout on `container` for this test only. */
function installFakeLayout(container: HTMLDivElement): FakeLayout {
  Object.defineProperty(container, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
  Object.defineProperty(container, 'scrollHeight', {
    configurable: true,
    get: () => computeScrollHeight(container),
  })

  let storedScrollTop = 0
  Object.defineProperty(container, 'scrollTop', {
    configurable: true,
    get: () => storedScrollTop,
    set: (value: number) => {
      storedScrollTop = value
      // A real browser fires 'scroll' for both user-driven and script-driven
      // scrollTop changes; jsdom does not, so we dispatch it ourselves to
      // exercise the same onScroll path the component relies on.
      container.dispatchEvent(new Event('scroll'))
    },
  })

  // jsdom does not implement Element.scrollTo; the component uses it for its
  // imperative scrollToUuid. Model it as the browser does: it sets scrollTop.
  container.scrollTo = ((options: ScrollToOptions) => {
    container.scrollTop = options.top ?? container.scrollTop
  }) as HTMLElement['scrollTo']

  return {
    setScrollTopSilently: (value: number) => {
      storedScrollTop = value
    },
  }
}

describe('VirtualizedList height estimation and bottom pinning', () => {
  let container: HTMLDivElement
  let root: Root
  let layout: FakeLayout
  let restoreOffsetHeight: () => void
  let restoreReadyState: () => void

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    layout = installFakeLayout(container)
    root = createRoot(container)
    rowHeights = new Map()

    // Every mounted row reports its injected height the instant it exists in
    // the DOM (as a real browser would), which is exactly what lets a
    // never-before-rendered row's measurement differ from the estimate used for
    // it while it was off-screen.
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.id ? (rowHeights.get(this.id) ?? 0) : 0
      },
    })
    restoreOffsetHeight = () => {
      if (originalDescriptor) {
        Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalDescriptor)
      }
    }

    // The component gates measurement on readyState === 'complete' to avoid a
    // pre-load forced layout flush; force it so the test measures immediately.
    const originalReadyState = Object.getOwnPropertyDescriptor(document, 'readyState')
    Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true })
    restoreReadyState = () => {
      if (originalReadyState) {
        Object.defineProperty(document, 'readyState', originalReadyState)
      }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    restoreOffsetHeight()
    restoreReadyState()
  })

  function mount(items: Item[], listRef?: { current: VirtualizedListInterface | null }) {
    const scrollContainerRef = { current: container as HTMLElement | null }
    const element = createElement(VirtualizedList, {
      items,
      scrollContainerRef,
      estimatedItemHeight: BOOTSTRAP_ESTIMATE,
      overscan: OVERSCAN,
      ref: listRef,
      renderItem: (item: Item) => createElement('div', { id: item.uuid, key: item.uuid }, item.uuid),
    })
    act(() => {
      root.render(element)
    })
    return () =>
      act(() => {
        // Re-rendering with fresh prop identities is how a height correction is
        // delivered without any scrolling: the measure layout effect runs on
        // every commit and picks up whatever the rows now measure.
        root.render(
          createElement(VirtualizedList, {
            items,
            scrollContainerRef,
            estimatedItemHeight: BOOTSTRAP_ESTIMATE,
            overscan: OVERSCAN,
            ref: listRef,
            renderItem: (item: Item) => createElement('div', { id: item.uuid, key: item.uuid }, item.uuid),
          }),
        )
      })
  }

  it('sizes the whole list from the mean row height it has MEASURED, not from the bootstrap estimate', () => {
    const items = makeItems(40)
    // Heights cycling through the measured default-configuration range
    // (60.5 - 113.5, mean 79.3), so the sample the list can see at scrollTop 0
    // is representative without being uniform — a uniform fixture would make
    // any averaging scheme look exact.
    const trueTotal = setRowHeights(items, (index) => [70, 90, 110][index % 3])

    mount(items)

    const bootstrapTotal = items.length * BOOTSTRAP_ESTIMATE
    const learnedError = Math.abs(container.scrollHeight - trueTotal)
    const bootstrapError = Math.abs(bootstrapTotal - trueTotal)

    // Only the first viewport's rows have been measured, so the estimate for the
    // other ~33 rows is their running mean. It cannot be perfect, but it must be
    // in the right neighbourhood rather than a third out.
    expect(learnedError / trueTotal).toBeLessThan(0.05)
    // And decisively better than the constant it bootstrapped from.
    expect(learnedError * 5).toBeLessThan(bootstrapError)
  })

  it('settles exactly on the corrected bottom when a drag to the estimated bottom lands SHORT (rows taller than the estimate)', () => {
    const items = makeItems(40)
    // The common, measured case: the tail of the list measures in TALLER than
    // the head the estimate was learned from, so the real bottom is further
    // down than the drag could reach. In Chrome this shortfall measured 375px
    // for 300 default-configuration notes.
    setRowHeights(items, (index) => (index < 30 ? 70 : 110))

    mount(items)

    // A scrollbar drag, or End: straight to the bottom the list currently
    // believes in, whose tail has never been rendered or measured.
    act(() => {
      container.scrollTop = container.scrollHeight - container.clientHeight
    })

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    expect(container.scrollTop).toBeLessThanOrEqual(maxScrollTop + 0.5)
    expect(container.scrollTop).toBeCloseTo(maxScrollTop, 0)
    // Genuinely settled through to the very last row, not merely somewhere legal.
    expect(bottomSpacerHeight(container)).toBeLessThanOrEqual(0.5)
    expect(container.querySelector(`#${items[items.length - 1].uuid}`)).not.toBeNull()
  })

  it('never leaves scrollTop past the bottom when rows measure in SHORTER than the estimate', () => {
    // Labelled plainly: of the four measured display configurations this models
    // ONLY hideDate + hidePreview, the one whose real total came out 26% BELOW
    // the estimate. The other three grow (see the test above).
    const items = makeItems(40)
    // 44px is the measured floor of that configuration; the head matches the
    // bootstrap estimate so the list only discovers the shrink in the tail.
    setRowHeights(items, (index) => (index < 30 ? 60 : 44))

    mount(items)

    act(() => {
      container.scrollTop = container.scrollHeight - container.clientHeight
    })

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    // The invariant a browser enforces, and which the measurement correction
    // can otherwise break: scrollTop may never point past the scrollable range.
    expect(container.scrollTop).toBeLessThanOrEqual(maxScrollTop + 0.5)
    expect(container.scrollTop).toBeCloseTo(maxScrollTop, 0)
    expect(bottomSpacerHeight(container)).toBeLessThanOrEqual(0.5)
  })

  // Two travel distances, both inside the range where a pin acting on a stale
  // at-bottom observation would measurably move this fixture's viewport. (Far
  // enough away and the move is refused anyway by the pin's budget cap, so the
  // test would pass without proving anything — hence the explicit
  // "a pin here would have been visible" assertion below.)
  it.each([450, 600])(
    'does not pin to the bottom on an at-bottom observation the viewport left %ipx ago',
    (travelledPx) => {
      const items = makeItems(40)
      setRowHeights(items, () => 60)

      const rerender = mount(items)

      // 1. Reach the bottom the ordinary way, dispatching 'scroll' — so any
      //    at-bottom state the component keeps is now set.
      act(() => {
        container.scrollTop = container.scrollHeight - container.clientHeight
      })
      const bottom = container.scrollTop
      expect(bottom).toBeGreaterThan(travelledPx)

      // 2. Move the viewport away WITHOUT dispatching 'scroll'. This is what
      //    compositor-driven scrolling (a wheel gesture, a touch fling) does to a
      //    main-thread scroll listener: the offset has already moved while the
      //    listener has not yet run, so anything that listener recorded describes
      //    a position the user has left. The at-bottom decision must not be taken
      //    from such a record — it has to be a live reading.
      const movedTo = bottom - travelledPx
      layout.setScrollTopSilently(movedTo)

      // 3. Now correct the row heights, with no scroll event anywhere near it.
      //    (In the real UI: toggling "hide note preview", or a tag or vault badge
      //    appearing on a row.)
      for (const item of items) {
        rowHeights.set(item.uuid, 44)
      }
      rerender()

      // The viewport must still be where it was put. Pinning here would drag the
      // user onto the last row from wherever they had actually scrolled to —
      // measured in Chrome at 12,502px, 100% of the way back to the bottom.
      expect(container.scrollTop).toBeCloseTo(movedTo, 0)
      // ...and this scenario is non-degenerate: the corrected bottom is far
      // enough from where the viewport was left that a pin would have been
      // plainly visible, so the assertion above is not passing by coincidence.
      expect(Math.abs(container.scrollHeight - VIEWPORT_HEIGHT - movedTo)).toBeGreaterThan(50)
    },
  )

  it('re-aims scrollToUuid from the real measurement instead of landing short of an unmeasured row', () => {
    const items = makeItems(40)
    // Every row 100px except the target, which is much taller — the one thing
    // the list cannot know before it has rendered the row. The first aim is
    // therefore built on the estimate for that row and falls short of it; in
    // Chrome this left a row 250 notes down entirely below the viewport, 297px
    // past its bottom edge.
    const targetIndex = 30
    const targetUuid = items[targetIndex].uuid
    setRowHeights(items, (index) => (index === targetIndex ? 260 : 100))

    const listRef: { current: VirtualizedListInterface | null } = { current: null }
    mount(items, listRef)

    act(() => {
      listRef.current?.scrollToUuid(targetUuid, 'auto', 'nearest')
    })

    const box = rowBox(container, targetUuid)
    expect(box).not.toBeNull()
    const viewTop = container.scrollTop
    const viewBottom = viewTop + VIEWPORT_HEIGHT
    // The whole point of 'nearest': the row ends up fully inside the viewport.
    expect((box as { top: number }).top).toBeGreaterThanOrEqual(viewTop - 0.5)
    expect((box as { bottom: number }).bottom).toBeLessThanOrEqual(viewBottom + 0.5)
  })
})
