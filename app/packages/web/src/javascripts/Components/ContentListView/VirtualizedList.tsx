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
 * elements' offsetHeight.
 *
 * Offsets (top-of-row prefix sums) are stored in a hand-rolled Fenwick tree
 * (Binary Indexed Tree) over per-row heights rather than a plain prefix-sum
 * array. The reason: when a freshly-revealed row's measured height differs from
 * the estimate (which happens on essentially every scroll into new territory),
 * a plain prefix-sum array must be fully recomputed — O(N), i.e. ~500k
 * iterations per scroll step at large note counts. With a BIT, a single row's
 * height change is an O(log N) POINT UPDATE, `offsetForIndex(i)` (top of row i)
 * is an O(log N) prefix query, `totalHeight` is O(log N), and `findStartIndex`
 * (largest index whose prefix-sum <= scrollTop) is an O(log N) Fenwick walk.
 * The full O(N) BIT rebuild only happens when the `items` set itself changes,
 * never on scroll/measure. This keeps scrolling responsive at 500k notes.
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

/**
 * Fenwick tree (Binary Indexed Tree) over per-index row heights.
 *
 * - `heights[i]` is the current height contributing to row i (the source of
 *   truth for what is currently in the tree, so measure-bumps can compute the
 *   delta for a point update without re-deriving it).
 * - `tree` is 1-indexed; `tree[k]` holds the partial sum of a range ending at k.
 *
 * `prefix(i)` returns the sum of heights of rows [0, i) — i.e. the TOP of row i.
 * `prefix(n)` is the total height. `update(i, delta)` adjusts a single row's
 * height in O(log N). `findLargestPrefixLE(value)` returns the largest index i
 * such that prefix(i) <= value, via a Fenwick binary lift in O(log N).
 */
class HeightFenwick {
  readonly size: number
  private readonly heights: Float64Array
  private readonly tree: Float64Array
  // Highest power of two <= size, used by the binary-lift query.
  private readonly logHi: number

  constructor(initial: number[]) {
    const n = initial.length
    this.size = n
    this.heights = new Float64Array(n)
    this.tree = new Float64Array(n + 1)

    // O(N) build: seed heights and accumulate into the tree using the standard
    // parent-propagation build (each tree[i] gets its own value, then pushes to
    // its Fenwick parent). This runs ONLY on a real items change.
    for (let i = 0; i < n; i++) {
      const h = initial[i]
      this.heights[i] = h
      this.tree[i + 1] += h
      const parent = i + 1 + ((i + 1) & -(i + 1))
      if (parent <= n) {
        this.tree[parent] += this.tree[i + 1]
      }
    }

    let p = 1
    while (p << 1 <= (n || 1)) {
      p <<= 1
    }
    this.logHi = p
  }

  /** Current height stored for row `index`. */
  heightAt(index: number): number {
    return this.heights[index]
  }

  /** O(log N) point update: set row `index` to `value`. */
  set(index: number, value: number): void {
    const delta = value - this.heights[index]
    if (delta === 0) {
      return
    }
    this.heights[index] = value
    for (let i = index + 1; i <= this.size; i += i & -i) {
      this.tree[i] += delta
    }
  }

  /** O(log N) prefix sum of rows [0, count) — i.e. the top offset of row `count`. */
  prefix(count: number): number {
    let sum = 0
    for (let i = count; i > 0; i -= i & -i) {
      sum += this.tree[i]
    }
    return sum
  }

  /** Total height of all rows. */
  total(): number {
    return this.prefix(this.size)
  }

  /**
   * Largest index `i` in [0, size] such that prefix(i) <= value.
   *
   * Equivalent to the old binary search "first row whose bottom is below top":
   * the old search returned the first index `lo` with offsets[lo+1] > top, i.e.
   * the largest `lo` with offsets[lo] <= top among in-range rows. prefix(i) is
   * offsets[i], so the largest i with prefix(i) <= value is exactly that index
   * (clamped to a valid row below by the caller). O(log N) Fenwick binary lift.
   */
  findLargestPrefixLE(value: number): number {
    let pos = 0
    let remaining = value
    for (let step = this.logHi; step > 0; step >>= 1) {
      const next = pos + step
      if (next <= this.size && this.tree[next] <= remaining) {
        pos = next
        remaining -= this.tree[next]
      }
    }
    return pos
  }
}

function VirtualizedListInner<T extends { uuid: string }>(
  { items, scrollContainerRef, estimatedItemHeight, overscan, renderItem, onNearEnd }: Props<T>,
  ref: React.ForwardedRef<VirtualizedListInterface>,
): ReactElement {
  const estimate = estimatedItemHeight ?? DEFAULT_ESTIMATED_HEIGHT
  const over = overscan ?? DEFAULT_OVERSCAN

  // Per-uuid measured heights (source of truth across item-set changes). A ref
  // (not state) so updating it during measure does not itself trigger a render
  // loop; we bump `measureVersion` (state) only when a height actually changed
  // AND we have applied the corresponding Fenwick point update.
  const heightCache = useRef<Map<string, number>>(new Map())
  const [measureVersion, setMeasureVersion] = useState(0)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  const heightFor = useCallback((uuid: string) => heightCache.current.get(uuid) ?? estimate, [estimate])

  // Fenwick tree over per-row heights. Rebuilt O(N) ONLY when the items set
  // changes (or the estimate prop changes); per-row measure corrections are
  // applied as O(log N) point updates in the layout effect below — never a full
  // re-sum on scroll. The same `estimate` fallback is used for unmeasured rows,
  // matching the previous array-based behavior byte-for-byte.
  const fenwick = useMemo(() => {
    const initial = new Array<number>(items.length)
    for (let i = 0; i < items.length; i++) {
      initial[i] = heightFor(items[i].uuid)
    }
    return new HeightFenwick(initial)
    // measureVersion is intentionally NOT a dependency: measure corrections are
    // applied as in-place point updates, so the tree must NOT be rebuilt on a
    // bump (that would re-introduce the O(N) cost we are eliminating).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, heightFor])

  // `measureVersion` is the render-invalidation token: when a measured height
  // is applied to the tree via an in-place point update (below), we bump it so
  // these offset reads recompute against the now-mutated `fenwick`. It is keyed
  // here so the dependency is explicit rather than relying on the state setter's
  // implicit re-render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const totalHeight = useMemo(() => fenwick.total(), [fenwick, measureVersion])

  // Top of row `index` (offsets[index] in the old prefix-sum array). O(log N).
  const offsetForIndex = useCallback(
    (index: number) => fenwick.prefix(index),
    // measureVersion: re-bind after a point update so callers read fresh offsets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fenwick, measureVersion],
  )

  // First row whose bottom is below `top`. Equivalent to the old binary search:
  // it returned the first `lo` with offsets[lo+1] > top, i.e. the largest index
  // whose top (prefix) is <= top. O(log N) Fenwick walk instead of O(log N)
  // binary search over an O(N)-rebuilt array.
  const findStartIndex = useCallback(
    (top: number): number => {
      if (items.length <= 0) {
        return 0
      }
      const idx = fenwick.findLargestPrefixLE(top)
      // Clamp to a valid row (the old search returned an index in [0, len-1]).
      return Math.min(idx, items.length - 1)
    },
    // measureVersion: re-bind after a point update so the visible range recomputes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items.length, fenwick, measureVersion],
  )

  const startIndex = Math.max(0, findStartIndex(scrollTop) - over)
  let endIndex = startIndex
  const viewportBottom = scrollTop + (viewportHeight || estimate)
  while (endIndex < items.length && offsetForIndex(endIndex) < viewportBottom) {
    endIndex++
  }
  endIndex = Math.min(items.length, endIndex + over)

  const visibleItems = items.slice(startIndex, endIndex)
  const topSpacer = offsetForIndex(startIndex)
  const bottomSpacer = Math.max(0, totalHeight - offsetForIndex(endIndex))

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
  // height changed materially, apply the change to the Fenwick tree as an
  // O(log N) POINT UPDATE (not a full rebuild) and bump the version so offsets
  // recompute. `startIndex` maps each rendered child back to its absolute row
  // index for the point update.
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
        const absoluteIndex = startIndex + i
        // Guard against a stale slice racing an items change; only point-update
        // when the index/uuid still line up with the current tree.
        if (absoluteIndex < items.length && items[absoluteIndex]?.uuid === uuid) {
          fenwick.set(absoluteIndex, measured)
        }
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
      const rowTop = offsetForIndex(index)
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
    [scrollContainerRef, items, offsetForIndex, heightFor],
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
