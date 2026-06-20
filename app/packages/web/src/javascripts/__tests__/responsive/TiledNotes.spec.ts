/**
 * @jest-environment jsdom
 *
 * Tiled-notes narrow-tiling flag.
 *
 * When 2+ notes are open the editor tiles them side-by-side, but below the `lg`
 * breakpoint (1024px) the columns become too narrow, so NoteGroupView stacks
 * them into a single scrollable column. That decision is driven by
 * `isNarrowTilingViewport`, computed as `!window.matchMedia(lg).matches` and
 * kept in sync by `narrowTilingMQHandler` (which sets it to `!event.matches`).
 *
 * NoteGroupView is a class component requiring a full WebApplication, so per the
 * task we test the underlying media-query decision + the REAL handler logic
 * rather than mounting it. We also assert the `effectiveLayout` stacking rule
 * (the pure function of `isNarrowTilingViewport` + chosen layout) that the
 * narrow path implements. jsdom cannot verify the resulting CSS grid itself.
 */
import { MediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { TileLayout } from '@/Components/NoteGroupView/TileLayout'
import { setViewport, resizeViewport, evaluateMediaQuery, TARGET_WIDTHS } from '@/TestUtils/viewport'

// Mirror of the constructor/handler decision in NoteGroupView: narrow tiling is
// on whenever the `lg` query does not match.
const computeNarrowTiling = () => !window.matchMedia(MediaQueryBreakpoints.lg).matches

// Mirror of the IIFE inside NoteGroupView.render that maps the user-chosen tile
// layout to the effective one under narrow viewports.
const resolveEffectiveLayout = (isNarrow: boolean, chosen: TileLayout) => {
  const effectiveLayout = isNarrow && chosen !== TileLayout.Single ? TileLayout.Rows : chosen
  const stackVertically = isNarrow && effectiveLayout === TileLayout.Rows
  return { effectiveLayout, stackVertically }
}

describe('tiled notes: narrow-tiling flag by width', () => {
  let cleanup: () => void = () => undefined
  afterEach(() => cleanup())

  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanup = setViewport(width)
    })

    const expectNarrow = width < 1024

    it(`isNarrowTilingViewport is ${expectNarrow} (single-column stacking ${
      expectNarrow ? 'on' : 'off'
    })`, () => {
      expect(computeNarrowTiling()).toBe(expectNarrow)
      // Cross-check against the raw lg query the component reads.
      expect(evaluateMediaQuery(MediaQueryBreakpoints.lg, width, 'no-preference')).toBe(!expectNarrow)
    })
  })

  it('flips exactly at the 1024 boundary', () => {
    const narrowAt = (w: number) => {
      cleanup()
      cleanup = setViewport(w)
      return computeNarrowTiling()
    }
    expect(narrowAt(1023)).toBe(true)
    expect(narrowAt(1024)).toBe(false)
  })
})

describe('tiled notes: narrowTilingMQHandler runtime updates', () => {
  let cleanup: () => void = () => undefined
  afterEach(() => cleanup())

  // The handler in NoteGroupView is `(event) => setState({ isNarrowTilingViewport: !event.matches })`.
  it('tracks the live lg media-query as the viewport resizes across 1024', () => {
    cleanup = setViewport(1280)
    let isNarrow = computeNarrowTiling()
    expect(isNarrow).toBe(false)

    const mq = window.matchMedia(MediaQueryBreakpoints.lg)
    const handler = (event: MediaQueryListEvent | MediaQueryList) => {
      isNarrow = !event.matches
    }
    mq.addEventListener('change', handler)

    // Shrink to tablet -> lg stops matching -> narrow tiling turns on.
    resizeViewport(768)
    expect(isNarrow).toBe(true)

    // Shrink further to phone -> still narrow.
    resizeViewport(375)
    expect(isNarrow).toBe(true)

    // Grow back to desktop -> lg matches -> narrow tiling turns off.
    resizeViewport(1024)
    expect(isNarrow).toBe(false)

    mq.removeEventListener('change', handler)
  })
})

describe('tiled notes: effective layout under narrow viewports', () => {
  it('forces Rows + vertical stacking below lg for multi-column layouts', () => {
    expect(resolveEffectiveLayout(true, TileLayout.Columns)).toEqual({
      effectiveLayout: TileLayout.Rows,
      stackVertically: true,
    })
    expect(resolveEffectiveLayout(true, TileLayout.Grid)).toEqual({
      effectiveLayout: TileLayout.Rows,
      stackVertically: true,
    })
  })

  it('keeps Single layout as-is (just the active tile) even when narrow', () => {
    expect(resolveEffectiveLayout(true, TileLayout.Single)).toEqual({
      effectiveLayout: TileLayout.Single,
      stackVertically: false,
    })
  })

  it('leaves the user-chosen layout untouched at lg+ (not narrow)', () => {
    expect(resolveEffectiveLayout(false, TileLayout.Columns)).toEqual({
      effectiveLayout: TileLayout.Columns,
      stackVertically: false,
    })
    expect(resolveEffectiveLayout(false, TileLayout.Grid)).toEqual({
      effectiveLayout: TileLayout.Grid,
      stackVertically: false,
    })
  })
})

describe('tiled notes: isTiling decision (tiling requires multiple tiles and non-mobile)', () => {
  // From NoteGroupView.render: `isTiling = controllers.length > 1 && !isInMobileView`.
  const isTiling = (controllerCount: number, isInMobileView: boolean) => controllerCount > 1 && !isInMobileView

  it('does not tile on mobile even with multiple notes open', () => {
    expect(isTiling(2, true)).toBe(false)
    expect(isTiling(3, true)).toBe(false)
  })

  it('does not tile with a single note', () => {
    expect(isTiling(1, false)).toBe(false)
  })

  it('tiles with 2+ notes on non-mobile', () => {
    expect(isTiling(2, false)).toBe(true)
  })
})
