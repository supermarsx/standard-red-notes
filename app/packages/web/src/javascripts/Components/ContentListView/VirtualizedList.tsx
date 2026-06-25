import {
  forwardRef,
  ReactElement,
  ReactNode,
  RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

/**
 * Standard Red Notes: a manually-implemented windowed (virtualized) list.
 *
 * The notes/files list historically rendered EVERY displayed row into the DOM
 * (`items.map(...)`) and grew the displayed set as the user scrolled, never
 * unmounting rows above. At large note counts this accumulates tens of
 * thousands of DOM nodes, degrading scroll and growing heap linearly.
 *
 * This component renders ONLY the rows intersecting the scroll viewport (plus a
 * small overscan), wrapped in a top + bottom spacer so the scrollbar still
 * represents the full list. The live DOM row count therefore stays roughly
 * CONSTANT (~viewport rows + overscan) no matter how many items exist.
 *
 * Rows are VARIABLE height (with/without snippet, tags, metadata, vault info),
 * so we keep a per-uuid measured-height cache and start from an estimate,
 * correcting it from real measurements after each render via the rendered
 * elements' offsetHeight. Offsets are derived from a running prefix sum so the
 * visible range can be found by scanning measured/estimated heights.
 *
 * No external dependency is added — windowing is implemented by hand.
 */

type Props<T extends { uuid: string }> = {
  items: T[]
  /** The scroll container element that owns the scrollbar (id = notes-scrollable). */
  scrollContainerRef: RefObject<HTMLElement | null>
  /** Estimated row height used before a row has been measured. */
  estimatedItemHeight?: number
  /** Extra rows to render above/below the visible window to avoid blank edges. */
  overscan?: number
  /** Render a single row. The returned element MUST carry id={item.uuid}. */
  renderItem: (item: T, index: number) => ReactNode
  /** Called when the user nears the end (parity with the old paginate-on-scroll). */
  onNearEnd?: () => void
}

const DEFAULT_ESTIMATED_HEIGHT = 60
const DEFAULT_OVERSCAN = 6
const NEAR_END_THRESHOLD_PX = 400

export type VirtualizedListInterface = {
  /** Scroll so the row with this uuid is brought into view (expanding the window). */
  scrollToUuid: (uuid: string, behavior?: ScrollBehavior, block?: 'center' | 'nearest') => void
  /** Whether a uuid currently exists in the backing item set. */
  hasUuid: (uuid: string) => boolean
}

function VirtualizedListInner<T extends { uuid: string }>(
  { items, scrollContainerRef, estimatedItemHeight, overscan, renderItem, onNearEnd }: Props<T>,
  ref: React.ForwardedRef<VirtualizedListInterface>,
): ReactElement {
  const estimate = estimatedItemHeight ?? DEFAULT_ESTIMATED_HEIGHT
  const over = overscan ?? DEFAULT_OVERSCAN

  // Per-uuid measured heights. A ref (not state) so updating it during measure
  // does not itself trigger a render loop; we bump `measureVersion` (state) only
  // when a height actually changed, so offsets recompute.
  const heightCache = useRef<Map<string, number>>(new Map())
  const [measureVersion, setMeasureVersion] = useState(0)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const heightFor = useCallback((uuid: string) => heightCache.current.get(uuid) ?? estimate, [estimate])

  // Prefix-sum offsets: offsets[i] is the top of row i; offsets[length] is the
  // total height. Recomputed when items change or a measured height changed.
  const offsets = useMemo(() => {
    const result = new Array<number>(items.length + 1)
    let running = 0
    for (let i = 0; i < items.length; i++) {
      result[i] = running
      running += heightFor(items[i].uuid)
    }
    result[items.length] = running
    return result
    // measureVersion is an intentional invalidation trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, heightFor, measureVersion])

  const totalHeight = offsets[items.length] ?? 0

  // Binary search for the first row whose bottom is below `top`.
  const findStartIndex = useCallback(
    (top: number): number => {
      let lo = 0
      let hi = items.length - 1
      if (hi < 0) {
        return 0
      }
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (offsets[mid + 1] <= top) {
          lo = mid + 1
        } else {
          hi = mid
        }
      }
      return lo
    },
    [items.length, offsets],
  )

  const startIndex = Math.max(0, findStartIndex(scrollTop) - over)
  let endIndex = startIndex
  const viewportBottom = scrollTop + (viewportHeight || estimate)
  while (endIndex < items.length && offsets[endIndex] < viewportBottom) {
    endIndex++
  }
  endIndex = Math.min(items.length, endIndex + over)

  const visibleItems = items.slice(startIndex, endIndex)
  const topSpacer = offsets[startIndex] ?? 0
  const bottomSpacer = Math.max(0, totalHeight - (offsets[endIndex] ?? totalHeight))

  // Keep scrollTop/viewportHeight in sync with the container.
  useEffect(() => {
    const container = scrollContainerRef.current
    if (!container) {
      return
    }

    const onScroll = () => {
      setScrollTop(container.scrollTop)
      if (
        onNearEnd &&
        container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_END_THRESHOLD_PX
      ) {
        onNearEnd()
      }
    }

    const measureViewport = () => setViewportHeight(container.clientHeight)

    measureViewport()
    setScrollTop(container.scrollTop)

    container.addEventListener('scroll', onScroll, { passive: true })

    let resizeObserver: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(measureViewport)
      resizeObserver.observe(container)
    } else {
      window.addEventListener('resize', measureViewport)
    }

    return () => {
      container.removeEventListener('scroll', onScroll)
      if (resizeObserver) {
        resizeObserver.disconnect()
      } else {
        window.removeEventListener('resize', measureViewport)
      }
    }
  }, [scrollContainerRef, onNearEnd])

  // After render, measure the rendered rows and update the height cache. If any
  // height changed materially, bump the version so offsets recompute.
  const sliceRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const sliceEl = sliceRef.current
    if (!sliceEl) {
      return
    }
    let changed = false
    const children = sliceEl.children
    for (let i = 0; i < children.length; i++) {
      const el = children[i] as HTMLElement
      const uuid = el.id
      if (!uuid) {
        continue
      }
      const measured = el.offsetHeight
      if (measured > 0 && Math.abs((heightCache.current.get(uuid) ?? -1) - measured) > 0.5) {
        heightCache.current.set(uuid, measured)
        changed = true
      }
    }
    if (changed) {
      setMeasureVersion((v) => v + 1)
    }
  })

  // Scroll the container so the row at `index` is brought into view.
  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'auto', block: 'center' | 'nearest' = 'nearest') => {
      const container = scrollContainerRef.current
      if (!container || index < 0 || index >= items.length) {
        return
      }
      const rowTop = offsets[index] ?? 0
      const rowHeight = heightFor(items[index].uuid)
      let target: number
      if (block === 'center') {
        target = rowTop - container.clientHeight / 2 + rowHeight / 2
      } else {
        const viewTop = container.scrollTop
        const viewBottom = viewTop + container.clientHeight
        if (rowTop >= viewTop && rowTop + rowHeight <= viewBottom) {
          return
        }
        target = rowTop < viewTop ? rowTop : rowTop - container.clientHeight + rowHeight
      }
      container.scrollTo({ top: Math.max(0, target), behavior })
      // Update the slice immediately rather than waiting for the scroll event,
      // so the target row mounts and can then be focused by callers.
      setScrollTop(Math.max(0, target))
    },
    [scrollContainerRef, items, offsets, heightFor],
  )

  useImperativeHandle(
    ref,
    () => ({
      scrollToUuid: (uuid, behavior, block) => {
        const index = items.findIndex((item) => item.uuid === uuid)
        if (index >= 0) {
          scrollToIndex(index, behavior ?? 'auto', block ?? 'nearest')
        }
      },
      hasUuid: (uuid) => items.some((item) => item.uuid === uuid),
    }),
    [items, scrollToIndex],
  )

  return (
    <div style={{ position: 'relative' }}>
      <div style={{ height: topSpacer }} aria-hidden />
      <div ref={sliceRef}>{visibleItems.map((item, i) => renderItem(item, startIndex + i))}</div>
      <div style={{ height: bottomSpacer }} aria-hidden />
    </div>
  )
}

// React.forwardRef erases the generic type parameter; re-assert it so callers
// keep their item type T.
export const VirtualizedList = forwardRef(VirtualizedListInner) as <T extends { uuid: string }>(
  props: Props<T> & { ref?: React.Ref<VirtualizedListInterface> },
) => ReactElement
