/**
 * @jest-environment jsdom
 *
 * Bug report: "scrolling to the bottom causes it bounce back on the last item
 * on the list" in the notes/files list.
 *
 * Root cause: VirtualizedList renders rows at an ESTIMATED height
 * (DEFAULT_ESTIMATED_HEIGHT) until they are first mounted and measured via
 * `offsetHeight`. Because the list is windowed, tail rows are only ever
 * rendered (and thus only ever measured) once the user scrolls into them — so
 * the very scroll gesture that lands the user at what looks like the bottom
 * is also what corrects a whole batch of previously-estimated tail rows for
 * the first time. When the real row heights are shorter than the estimate,
 * that correction shrinks the Fenwick-tracked total height (and therefore the
 * container's real scrollHeight) out from under the user's current scrollTop.
 * Nothing in the unfixed component compensates, so `scrollTop` is left
 * pointing PAST the newly-shrunk scrollable range — the exact invalid state a
 * real browser resolves by snapping (bouncing) the viewport back to the new,
 * smaller max, landing on the last item.
 *
 * jsdom does not do real layout (offsetHeight/scrollHeight/clientHeight are
 * inert unless stubbed, and jsdom never auto-clamps scrollTop the way a
 * browser does), so this harness builds a small, faithful "fake layout" over
 * the component's known DOM shape (topSpacer / row slice / bottomSpacer) to
 * make the estimate-vs-real-height correction — and its effect on scroll
 * position — observable and deterministic. The assertion is the invariant a
 * browser enforces and the fix restores: scrollTop must never exceed
 * scrollHeight - clientHeight. On the unfixed component that invariant is
 * violated the instant the tail is first measured; the fix re-pins the
 * container to the corrected bottom in the same commit, so it never is.
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { VirtualizedList } from './VirtualizedList'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const ESTIMATED_HEIGHT = 60
const REAL_ROW_HEIGHT = 40
const VIEWPORT_HEIGHT = 300
const ITEM_COUNT = 40

type Item = { uuid: string }

function makeItems(count: number): Item[] {
  return Array.from({ length: count }, (_, i) => ({ uuid: `item-${i}` }))
}

function parsePx(value: string): number {
  return parseFloat(value || '0') || 0
}

/**
 * Mirrors a real browser's block-flow box height for the component's known
 * DOM shape: a position:relative wrapper holding [topSpacer, rowSlice,
 * bottomSpacer]. Spacer heights come from their own inline style (set by the
 * component from its Fenwick totals); the row slice's height is the sum of
 * its children's (mocked) offsetHeight, exactly like a real layout engine.
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

/** Installs a live, settable fake layout on `container` for this test only. */
function installFakeLayout(container: HTMLDivElement) {
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
}

describe('VirtualizedList scroll-to-bottom', () => {
  let container: HTMLDivElement
  let root: Root
  let restoreOffsetHeight: () => void
  let restoreReadyState: () => void

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    installFakeLayout(container)
    root = createRoot(container)

    // Every mounted row reports its TRUE height the instant it exists in the
    // DOM (as a real browser would), which is exactly what lets a
    // never-before-rendered tail row's measurement differ from the
    // DEFAULT_ESTIMATED_HEIGHT used for it while off-screen.
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.id ? REAL_ROW_HEIGHT : 0
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

  it('never leaves scrollTop past the true (measurement-corrected) bottom after scrolling to the estimated bottom', () => {
    const items = makeItems(ITEM_COUNT)
    const scrollContainerRef = { current: container as HTMLElement | null }

    act(() => {
      root.render(
        createElement(VirtualizedList, {
          items,
          scrollContainerRef,
          estimatedItemHeight: ESTIMATED_HEIGHT,
          overscan: 2,
          renderItem: (item: Item) => createElement('div', { id: item.uuid, key: item.uuid }, item.uuid),
        }),
      )
    })

    // Scroll to what the browser currently believes is the bottom, per the
    // list's still mostly-ESTIMATED total height (only the first viewport's
    // worth of rows has been measured so far). This mirrors a user dragging
    // the scrollbar, or pressing End, straight to the bottom of a long list
    // whose tail has never been rendered.
    act(() => {
      container.scrollTop = container.scrollHeight - container.clientHeight
    })

    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)

    // The invariant a real browser enforces (and that the fix restores):
    // scrollTop can never point past the true scrollable range. Before the
    // fix, the tail rows measuring in at REAL_ROW_HEIGHT (40) < the estimate
    // (60) shrinks scrollHeight after the user is already "at the bottom",
    // and scrollTop is left overshooting the new max — the exact state a
    // browser resolves as a visible bounce back onto the last item.
    expect(container.scrollTop).toBeLessThanOrEqual(maxScrollTop + 0.5)
    // And it should be resting exactly there, not merely somewhere legal.
    expect(container.scrollTop).toBeCloseTo(maxScrollTop, 0)

    // Confirm we are genuinely settled through to the very last row, not
    // just numerically close: the bottom spacer should have collapsed to 0.
    const wrapper = container.firstElementChild as HTMLElement
    const bottomSpacer = wrapper.children[2] as HTMLElement
    expect(parsePx(bottomSpacer.style.height)).toBeLessThanOrEqual(0.5)

    const lastRow = container.querySelector(`#${items[items.length - 1].uuid}`)
    expect(lastRow).not.toBeNull()
  })
})
