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
  /**
   * Row height to assume BEFORE this list has measured anything at all. Once
   * even a handful of rows have been measured the list uses their running mean
   * instead (see `currentEstimate`), so this value only governs the very first
   * render — but that is the render that sizes the scrollbar, so a caller that
   * knows its row shape (e.g. whether the date/preview lines are hidden)
   * should still pass a matching value.
   */
  estimatedItemHeight?: number
  /** Extra rows to render above/below the visible window to avoid blank edges. */
  overscan?: number
  /** Render a single row. The returned element MUST carry id={item.uuid}. */
  renderItem: (item: T, index: number) => ReactNode
  /** Called when the user nears the end (parity with the old paginate-on-scroll). */
  onNearEnd?: () => void
}

/**
 * Last-resort row height for a caller that passes no `estimatedItemHeight` and
 * before this list has measured a single row.
 *
 * Standard Red Notes: this was 60, which was measurably wrong. Real notes-list
 * rows were measured in Chrome (real CSS, real Tailwind, 420px column, 300
 * notes with a realistic mix of titles/previews): 60.5px at the absolute floor
 * and 113.5px at the top, MEAN 79.3px. 60 is therefore not a central estimate
 * at all, it is the FLOOR, and it under-predicted the list's total height by
 * 23% — the scrollbar lied by that much, the list visibly grew during a scroll,
 * and a drag to the bottom landed 375px short. 79 is the measured mean of the
 * default configuration. `ContentList` passes a configuration-derived value
 * instead (the date and preview lines are optional and shift the mean by
 * ~32px), and the running mean below supersedes both as soon as rows are
 * measured — so this constant only has to be in the right neighbourhood.
 */
const DEFAULT_ESTIMATED_HEIGHT = 79
const DEFAULT_OVERSCAN = 6
const NEAR_END_THRESHOLD_PX = 400
// How close to the true bottom counts as "at the bottom" for pinning purposes.
const BOTTOM_PIN_EPSILON_PX = 1.5
/**
 * How many measured rows the running mean needs before it is trusted over the
 * caller's `estimatedItemHeight`. One rendered viewport is already ~8-12 rows,
 * so this is reached on the first measure pass; it exists only to stop a single
 * freak row (a 200px wrapping title) from becoming the estimate for 500k rows.
 */
const MIN_ESTIMATE_SAMPLES = 3
/** Re-estimate only when the running mean has actually moved. */
const ESTIMATE_EPSILON_PX = 0.5
/**
 * Cap on how many times one `scrollToUuid` request may re-aim itself from fresh
 * measurements. Each pass strictly improves (a row's height is corrected once),
 * so this converges in two or three; the cap is only there so a pathological
 * oscillation cannot keep writing scrollTop forever.
 */
const MAX_SCROLL_REFINEMENTS = 8

export type VirtualizedListInterface = {
  /** Scroll so the row with this uuid is brought into view (expanding the window). */
  scrollToUuid: (uuid: string, behavior?: ScrollBehavior, block?: 'center' | 'nearest') => void
  /** Whether a uuid currently exists in the backing item set. */
  hasUuid: (uuid: string) => boolean
}

/**
 * Fenwick tree (Binary Indexed Tree) over per-index row heights.
 *
 * Standard Red Notes: the tree deliberately does NOT bake the estimate into the
 * per-row values. It keeps TWO parallel Fenwick trees over the same index
 * space:
 *
 * - `heightTree` sums the MEASURED heights (0 contributed by a row that has
 *   never been measured), and
 * - `countTree` sums the NUMBER of rows still carried at the estimate.
 *
 * Every read combines them as `heightTree[k] + estimate * countTree[k]`, so the
 * estimate is a multiplier applied at read time rather than a value stored N
 * times. That is what makes `setEstimate` O(1): the list learns a better row
 * height from its own measurements and every not-yet-measured row picks the new
 * value up instantly, with no O(N) re-seed of the tree. (Baking the estimate in
 * would mean a full rebuild on every refinement — exactly the O(N)-per-scroll
 * cost this tree exists to avoid.)
 *
 * `prefix(i)` returns the sum of heights of rows [0, i) — i.e. the TOP of row i.
 * `prefix(n)` is the total height. `set(i, h)` records a real measurement for a
 * single row in O(log N). `findLargestPrefixLE(value)` returns the largest index
 * i such that prefix(i) <= value, via a Fenwick binary lift in O(log N).
 */
class HeightFenwick {
  readonly size: number
  /** Measured height per row; 0 for a row that has never been measured. */
  private readonly measured: Float64Array
  /** 1 while row i is still carried at the estimate, 0 once measured. */
  private readonly estimated: Uint8Array
  /** Fenwick over `measured`. */
  private readonly heightTree: Float64Array
  /** Fenwick over `estimated` — the COUNT of still-estimated rows in a range. */
  private readonly countTree: Float64Array
  // Highest power of two <= size, used by the binary-lift query.
  private readonly logHi: number
  private estimateValue: number

  constructor(measuredHeights: ArrayLike<number | undefined>, estimate: number) {
    const n = measuredHeights.length
    this.size = n
    this.estimateValue = estimate
    this.measured = new Float64Array(n)
    this.estimated = new Uint8Array(n)
    this.heightTree = new Float64Array(n + 1)
    this.countTree = new Float64Array(n + 1)

    // O(N) build: seed both trees and accumulate using the standard
    // parent-propagation build (each tree[i] gets its own value, then pushes to
    // its Fenwick parent). This runs ONLY on a real items change.
    for (let i = 0; i < n; i++) {
      const h = measuredHeights[i]
      const isMeasured = typeof h === 'number' && h > 0
      this.measured[i] = isMeasured ? (h as number) : 0
      this.estimated[i] = isMeasured ? 0 : 1
      this.heightTree[i + 1] += this.measured[i]
      this.countTree[i + 1] += this.estimated[i]
      const parent = i + 1 + ((i + 1) & -(i + 1))
      if (parent <= n) {
        this.heightTree[parent] += this.heightTree[i + 1]
        this.countTree[parent] += this.countTree[i + 1]
      }
    }

    let p = 1
    while (p << 1 <= (n || 1)) {
      p <<= 1
    }
    this.logHi = p
  }

  /** The height currently assumed for every not-yet-measured row. */
  get estimate(): number {
    return this.estimateValue
  }

  /**
   * O(1) re-estimate of EVERY not-yet-measured row. Cheap precisely because the
   * estimate is a read-time multiplier over `countTree`, never stored per row.
   */
  setEstimate(value: number): void {
    this.estimateValue = value
  }

  /** Whether row `index` is still carried at the estimate (never measured). */
  isEstimated(index: number): boolean {
    return this.estimated[index] === 1
  }

  /** Current height contributing to row `index` — measured, or the estimate. */
  heightAt(index: number): number {
    return this.estimated[index] === 1 ? this.estimateValue : this.measured[index]
  }

  /** O(log N) point update: record a real measurement for row `index`. */
  set(index: number, value: number): void {
    const wasEstimated = this.estimated[index] === 1
    const delta = value - this.measured[index]
    if (!wasEstimated && delta === 0) {
      return
    }
    this.measured[index] = value
    this.estimated[index] = 0
    for (let i = index + 1; i <= this.size; i += i & -i) {
      this.heightTree[i] += delta
      if (wasEstimated) {
        this.countTree[i] -= 1
      }
    }
  }

  /** Combined value of Fenwick node k: measured heights plus estimated rows. */
  private node(k: number): number {
    return this.heightTree[k] + this.estimateValue * this.countTree[k]
  }

  /** O(log N) prefix sum of rows [0, count) — i.e. the top offset of row `count`. */
  prefix(count: number): number {
    let sum = 0
    for (let i = count; i > 0; i -= i & -i) {
      sum += this.node(i)
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
      if (next <= this.size) {
        const nodeValue = this.node(next)
        if (nodeValue <= remaining) {
          pos = next
          remaining -= nodeValue
        }
      }
    }
    return pos
  }
}

function VirtualizedListInner<T extends { uuid: string }>(
  { items, scrollContainerRef, estimatedItemHeight, overscan, renderItem, onNearEnd }: Props<T>,
  ref: React.ForwardedRef<VirtualizedListInterface>,
): ReactElement {
  const fallbackEstimate = estimatedItemHeight ?? DEFAULT_ESTIMATED_HEIGHT
  const over = overscan ?? DEFAULT_OVERSCAN

  // Per-uuid measured heights (source of truth across item-set changes). A ref
  // (not state) so updating it during measure does not itself trigger a render
  // loop; we bump `measureVersion` (state) only when a height actually changed
  // AND we have applied the corresponding Fenwick point update.
  const heightCache = useRef<Map<string, number>>(new Map())
  const [measureVersion, setMeasureVersion] = useState(0)

  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  /**
   * Standard Red Notes: a height correction waiting for the bottom-pin effect to
   * decide what to do about it. Written by the measure effect from LIVE DOM in
   * the same commit as the correction; consumed exactly once by the pin.
   */
  const pendingCorrectionRef = useRef<{ atBottom: boolean; budgetPx: number } | null>(null)

  /**
   * Standard Red Notes: an in-flight `scrollToUuid` whose target row had not
   * been measured when the scroll was aimed, so the aim has to be refined from
   * the real measurement once the row has rendered.
   */
  const pendingScrollRef = useRef<{
    uuid: string
    behavior: ScrollBehavior
    block: 'center' | 'nearest'
    attempts: number
  } | null>(null)

  /**
   * Standard Red Notes: the estimate for not-yet-measured rows is the RUNNING
   * MEAN of the rows this list has actually measured, not a constant.
   *
   * A constant cannot help going stale: it has to be chosen for one row shape
   * (date shown? preview shown? tags? how often do titles wrap?) and silently
   * mis-predicts every other one, and nothing in the build would ever notice. A
   * mean taken from the list's own measurements has no such failure mode —
   * whatever the rows actually are, after one rendered viewport the estimate is
   * their average. `measuredHeightSumRef` is kept in step with `heightCache`
   * (whose `size` is the sample count) so the mean is O(1) to read.
   */
  const measuredHeightSumRef = useRef(0)

  const currentEstimate = useCallback(() => {
    const samples = heightCache.current.size
    return samples >= MIN_ESTIMATE_SAMPLES ? measuredHeightSumRef.current / samples : fallbackEstimate
  }, [fallbackEstimate])

  const rememberMeasuredHeight = useCallback((uuid: string, height: number) => {
    const previous = heightCache.current.get(uuid)
    measuredHeightSumRef.current += height - (previous ?? 0)
    heightCache.current.set(uuid, height)
  }, [])

  // Fenwick tree over per-row heights. Rebuilt O(N) ONLY when the items set
  // changes (or the estimatedItemHeight prop changes); per-row measure
  // corrections are applied as O(log N) point updates in the layout effect
  // below — never a full re-sum on scroll — and a refined estimate is applied
  // with the O(1) setEstimate, not by re-seeding the tree.
  const fenwick = useMemo(() => {
    const measuredHeights = new Array<number | undefined>(items.length)
    for (let i = 0; i < items.length; i++) {
      measuredHeights[i] = heightCache.current.get(items[i].uuid)
    }
    return new HeightFenwick(measuredHeights, currentEstimate())
    // measureVersion is intentionally NOT a dependency: measure corrections are
    // applied as in-place point updates, so the tree must NOT be rebuilt on a
    // bump (that would re-introduce the O(N) cost we are eliminating). Neither
    // is the running mean: it is pushed into the existing tree with the O(1)
    // `setEstimate` instead. `currentEstimate` only changes identity when the
    // `estimatedItemHeight` PROP changes, which does warrant a rebuild.
  }, [items, currentEstimate])

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
  const viewportBottom = scrollTop + (viewportHeight || currentEstimate())
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
      if (onNearEnd && container.scrollHeight - container.scrollTop - container.clientHeight < NEAR_END_THRESHOLD_PX) {
        onNearEnd()
      }
    }

    const measureViewport = () => setViewportHeight(container.clientHeight)

    // Reading clientHeight/scrollTop forces a synchronous layout flush. The
    // app mounts on DOMContentLoaded, so during boot this effect can run
    // BEFORE the page has fully loaded — a pre-load flush triggers Firefox's
    // "Layout was forced before the page was fully loaded" FOUC warning and
    // would measure against possibly not-yet-final styling. Until the load
    // event, rows render from the height ESTIMATE (the list's designed
    // fallback for unmeasured rows); the load-triggered measure below then
    // updates state, re-rendering with real measurements. On every later
    // mount (readyState === 'complete') we measure immediately, as before.
    const initialMeasure = () => {
      measureViewport()
      setScrollTop(container.scrollTop)
    }
    if (document.readyState === 'complete') {
      initialMeasure()
    } else {
      window.addEventListener('load', initialMeasure, { once: true })
    }

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
      window.removeEventListener('load', initialMeasure)
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
    // Skip measuring while the page is still loading: offsetHeight forces a
    // synchronous layout flush (pre-load, that is exactly the forced-layout /
    // FOUC condition Firefox warns about) and could cache heights measured
    // against not-yet-final styling. Rows keep their estimates until the
    // load-triggered viewport measure (above) re-renders, which re-runs this
    // effect with readyState === 'complete' and full styling in place.
    if (document.readyState !== 'complete') {
      return
    }
    const sliceEl = sliceRef.current
    if (!sliceEl) {
      return
    }

    // Standard Red Notes: ask "is the viewport resting at the bottom?" HERE, at
    // the moment the correction is discovered, from the live scroll offset — not
    // from a ref written inside the async scroll listener, which is a record of
    // where the viewport was the last time that listener happened to run and so
    // can describe a position the user has already left (see the pin effect).
    //
    // `scrollTop` and `clientHeight` are read live. The bottom they are measured
    // against is the list's OWN pre-correction total, deliberately not
    // `container.scrollHeight`: between React's render and this layout effect the
    // container is a hybrid — the rendered rows already contribute their real
    // heights while the spacers around them still carry the pre-correction
    // estimate — so its scrollHeight is neither the geometry the user's gesture
    // was aimed at nor the corrected one. `totalBefore` is exactly the height the
    // current spacers were computed from, i.e. the list as the user found it.
    const container = scrollContainerRef.current
    const totalBefore = fenwick.total()
    const distanceFromBottomBefore = container
      ? totalBefore - container.scrollTop - container.clientHeight
      : Number.POSITIVE_INFINITY

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
        rememberMeasuredHeight(uuid, measured)
        const absoluteIndex = startIndex + i
        // Guard against a stale slice racing an items change; only point-update
        // when the index/uuid still line up with the current tree.
        if (absoluteIndex < items.length && items[absoluteIndex]?.uuid === uuid) {
          fenwick.set(absoluteIndex, measured)
        }
        changed = true
      }
    }

    // Feed what we just learned back into the estimate for every row still
    // unmeasured. O(1) — the estimate is a read-time multiplier in the tree, so
    // this is not a re-seed (see HeightFenwick).
    const nextEstimate = currentEstimate()
    if (Math.abs(nextEstimate - fenwick.estimate) > ESTIMATE_EPSILON_PX) {
      fenwick.setEstimate(nextEstimate)
      changed = true
    }

    if (changed) {
      // A correction normally cascades: applying it re-renders, the re-render
      // reveals rows that have never been measured either, and this effect runs
      // again. All of that happens inside ONE synchronous React flush (layout
      // effects' state updates are flushed before the browser is handed back
      // control), so the user cannot have scrolled in between — which is why the
      // first pass's live at-bottom reading is still the truth about where they
      // are, and why a later pass (whose DOM already carries the correction, and
      // therefore no longer looks "at the bottom") must not overwrite it. The
      // budget accumulates over the cascade for the same reason.
      const outstanding = pendingCorrectionRef.current
      pendingCorrectionRef.current = {
        atBottom: (outstanding ? outstanding.atBottom : false) || distanceFromBottomBefore < BOTTOM_PIN_EPSILON_PX,
        // How much height this correction actually moved. The pin below may not
        // move the viewport by more than this: a height correction is entitled
        // to compensate for itself and for nothing else.
        budgetPx: (outstanding ? outstanding.budgetPx : 0) + Math.abs(fenwick.total() - totalBefore),
      }
      setMeasureVersion((v) => v + 1)
    }
  })

  /**
   * Standard Red Notes: re-pins the viewport to the corrected bottom after a
   * measurement changes the list's height under a user who was resting there.
   *
   * Rows are carried at the estimate until they are first rendered and measured
   * above, and because the list is windowed the tail is only ever measured once
   * the user scrolls into it — so the very gesture that lands them at what looks
   * like the bottom is also what corrects a whole batch of tail rows for the
   * first time. That correction moves the container's real scrollHeight out from
   * under the current scrollTop: too short and the browser clamps the scroll
   * offset up (felt as a bounce); too long — which is what real rows measurably
   * do, see DEFAULT_ESTIMATED_HEIGHT — and the drag stops short of the end.
   * Either way this effect runs in the commit that applied the correction
   * (keyed on measureVersion, which only changes when something really changed)
   * and settles the container on the corrected bottom.
   *
   * It is deliberately narrow, because it moves the user's viewport:
   *
   * - The "was at the bottom" observation is taken in the measure effect above,
   *   in the same commit and immediately before the correction, from the LIVE
   *   scroll offset (against the list's own pre-correction total — see the note
   *   there on why not `container.scrollHeight`). It used to come from
   *   `atBottomRef`, written ONLY inside the async `scroll` listener — so with
   *   compositor-driven scrolling (a wheel or
   *   a touch fling, where the listener runs behind the actual scroll offset)
   *   the ref could still say "at the bottom" after the user had scrolled well
   *   away, and a height correction landing in that window would yank the
   *   viewport onto the last item. Measured in Chrome: with the stale ref, a
   *   correction arriving after the user had moved 12,502px away from the bottom
   *   pulled them 100% of the way back onto the last row.
   * - The observation is ONE-SHOT: it is consumed here and cleared, so no later
   *   commit can act on it a second time.
   * - The move is capped by how much height the correction actually changed. A
   *   height correction is entitled to compensate for itself and nothing else;
   *   a larger move means the premise no longer holds, and doing nothing is the
   *   safe answer.
   * - A pending `scrollToUuid` owns the viewport, so the pin stands down.
   */
  useLayoutEffect(() => {
    const correction = pendingCorrectionRef.current
    pendingCorrectionRef.current = null
    if (!correction || !correction.atBottom || pendingScrollRef.current) {
      return
    }
    const container = scrollContainerRef.current
    if (!container) {
      return
    }
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight)
    const move = maxScrollTop - container.scrollTop
    if (Math.abs(move) <= 0.5 || Math.abs(move) > correction.budgetPx + 1) {
      return
    }
    container.scrollTop = maxScrollTop
    setScrollTop(maxScrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureVersion])

  /**
   * The scrollTop that brings row `index` into view, or null if it is already
   * there and no scroll is needed.
   *
   * Heights come from the Fenwick tree, which is what the rendered spacers are
   * built from, so for rows the window has rendered this is exact. For a row it
   * has NOT rendered the row's own height is still the estimate — which is why
   * the caller must treat the result as a first approximation and let the
   * refinement effect below re-aim once the row has really been measured.
   */
  const targetScrollTopFor = useCallback(
    (index: number, block: 'center' | 'nearest', container: HTMLElement): number | null => {
      const rowTop = offsetForIndex(index)
      const rowHeight = fenwick.heightAt(index)
      if (block === 'center') {
        return Math.max(0, rowTop - container.clientHeight / 2 + rowHeight / 2)
      }
      const viewTop = container.scrollTop
      const viewBottom = viewTop + container.clientHeight
      // Only a MEASURED row may be declared already-visible. Concluding it from
      // the estimate is how a selection- or keyboard-driven scroll used to
      // decide no scroll was needed for a row that was nowhere near the screen.
      if (!fenwick.isEstimated(index) && rowTop >= viewTop - 0.5 && rowTop + rowHeight <= viewBottom + 0.5) {
        return null
      }
      return Math.max(0, rowTop < viewTop ? rowTop : rowTop - container.clientHeight + rowHeight)
    },
    // measureVersion, via offsetForIndex: re-bind so the aim uses fresh heights.
    [offsetForIndex, fenwick],
  )

  // Scroll the container so the row at `index` is brought into view.
  const scrollToIndex = useCallback(
    (index: number, behavior: ScrollBehavior = 'auto', block: 'center' | 'nearest' = 'nearest') => {
      const container = scrollContainerRef.current
      if (!container || index < 0 || index >= items.length) {
        return
      }
      const target = targetScrollTopFor(index, block, container)
      if (target === null) {
        pendingScrollRef.current = null
        return
      }
      // Standard Red Notes: an aim at a row the window has never rendered is
      // built on that row's ESTIMATED height, so it lands short of the row —
      // measured in Chrome at 297px short of a row 250 notes down, i.e. the
      // target row ended up entirely below the viewport. Record the request so
      // the refinement effect below can re-aim from the real measurement once
      // this scroll has actually rendered the row.
      pendingScrollRef.current = { uuid: items[index].uuid, behavior, block, attempts: 0 }
      container.scrollTo({ top: target, behavior })
      // Update the slice immediately rather than waiting for the scroll event,
      // so the target row mounts and can then be focused by callers.
      setScrollTop(target)
    },
    [scrollContainerRef, items, targetScrollTopFor],
  )

  /**
   * Re-aims an in-flight `scrollToUuid` once its target row has been measured.
   *
   * This is the structural half of the estimate problem: a better estimate
   * narrows the error but cannot remove it, because the aim is computed before
   * the row exists in the DOM and the row's real height is only knowable after.
   * Each pass here re-computes the target from the now-measured heights, and
   * stops as soon as the container is already where it should be.
   */
  useLayoutEffect(() => {
    const request = pendingScrollRef.current
    if (!request) {
      return
    }
    const container = scrollContainerRef.current
    const index = items.findIndex((item) => item.uuid === request.uuid)
    if (!container || index < 0) {
      pendingScrollRef.current = null
      return
    }
    if (request.attempts >= MAX_SCROLL_REFINEMENTS) {
      pendingScrollRef.current = null
      return
    }
    request.attempts++
    if (fenwick.isEstimated(index)) {
      // Not measured yet: re-aiming now would reuse the same estimate and land
      // in the same wrong place. Wait for the pass that renders and measures it.
      return
    }
    const target = targetScrollTopFor(index, request.block, container)
    if (target === null || Math.abs(target - container.scrollTop) <= 0.5) {
      pendingScrollRef.current = null
      return
    }
    container.scrollTo({ top: target, behavior: request.behavior })
    setScrollTop(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureVersion])

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
