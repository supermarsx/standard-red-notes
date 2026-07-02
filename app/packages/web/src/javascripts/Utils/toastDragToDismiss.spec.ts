/**
 * Unit tests for the toast drag-right-to-dismiss decision logic
 * (@standardnotes/toast/src/dragToDismiss — pure, DOM-free).
 */
import {
  computeReleaseVelocity,
  dampenDx,
  DISMISS_DISTANCE_FRACTION,
  DRAG_ACTIVATION_SLOP_PX,
  dragOpacity,
  FLICK_MIN_DISTANCE_PX,
  FLICK_VELOCITY_PX_PER_MS,
  isDragActivated,
  LEFTWARD_RESISTANCE,
  shouldDismissOnRelease,
  VELOCITY_WINDOW_MS,
} from '@standardnotes/toast/src/dragToDismiss'

describe('isDragActivated', () => {
  it('does not activate below the slop threshold (clicks stay clicks)', () => {
    expect(isDragActivated(0)).toBe(false)
    expect(isDragActivated(DRAG_ACTIVATION_SLOP_PX - 1)).toBe(false)
  })

  it('activates at the slop threshold in either direction', () => {
    expect(isDragActivated(DRAG_ACTIVATION_SLOP_PX)).toBe(true)
    expect(isDragActivated(-DRAG_ACTIVATION_SLOP_PX)).toBe(true)
  })
})

describe('dampenDx', () => {
  it('follows rightward drags 1:1', () => {
    expect(dampenDx(120)).toBe(120)
    expect(dampenDx(0)).toBe(0)
  })

  it('resists leftward drags', () => {
    expect(dampenDx(-100)).toBeCloseTo(-100 * LEFTWARD_RESISTANCE)
  })
})

describe('dragOpacity', () => {
  it('is fully opaque at rest and for leftward positions', () => {
    expect(dragOpacity(0, 300)).toBe(1)
    expect(dragOpacity(-40, 300)).toBe(1)
  })

  it('fades as the toast is dragged right but never fully disappears', () => {
    const mid = dragOpacity(150, 300)
    expect(mid).toBeLessThan(1)
    expect(mid).toBeGreaterThan(0)
    expect(dragOpacity(10000, 300)).toBeGreaterThanOrEqual(0.2)
  })

  it('is safe for a zero width', () => {
    expect(dragOpacity(50, 0)).toBe(1)
  })
})

describe('shouldDismissOnRelease', () => {
  const width = 300

  it('dismisses past the distance threshold regardless of velocity', () => {
    expect(shouldDismissOnRelease(width * DISMISS_DISTANCE_FRACTION, width, 0)).toBe(true)
    expect(shouldDismissOnRelease(width, width, -1)).toBe(true)
  })

  it('springs back below the distance threshold without a flick', () => {
    expect(shouldDismissOnRelease(width * DISMISS_DISTANCE_FRACTION - 1, width, 0)).toBe(false)
  })

  it('dismisses a fast rightward flick even at short distance', () => {
    expect(shouldDismissOnRelease(FLICK_MIN_DISTANCE_PX, width, FLICK_VELOCITY_PX_PER_MS)).toBe(true)
  })

  it('ignores a flick that has not travelled the minimum distance', () => {
    expect(shouldDismissOnRelease(FLICK_MIN_DISTANCE_PX - 1, width, FLICK_VELOCITY_PX_PER_MS * 2)).toBe(false)
  })

  it('never dismisses leftward or zero positions', () => {
    expect(shouldDismissOnRelease(0, width, 10)).toBe(false)
    expect(shouldDismissOnRelease(-50, width, 10)).toBe(false)
  })

  it('still allows a flick dismissal when the width is unknown (0)', () => {
    expect(shouldDismissOnRelease(FLICK_MIN_DISTANCE_PX, 0, FLICK_VELOCITY_PX_PER_MS)).toBe(true)
  })
})

describe('computeReleaseVelocity', () => {
  it('returns 0 with fewer than two samples', () => {
    expect(computeReleaseVelocity([], 100)).toBe(0)
    expect(computeReleaseVelocity([{ x: 0, t: 0 }], 100)).toBe(0)
  })

  it('computes px/ms over the trailing window', () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 10, t: 950 },
      { x: 90, t: 1000 },
    ]
    // Only the last two samples are inside the window: 80px over 50ms.
    expect(computeReleaseVelocity(samples, 1000)).toBeCloseTo(80 / 50)
  })

  it('falls back to the last two samples when the window is sparse', () => {
    const samples = [
      { x: 0, t: 0 },
      { x: 200, t: 400 },
    ]
    expect(computeReleaseVelocity(samples, 400 + VELOCITY_WINDOW_MS + 500)).toBeCloseTo(200 / 400)
  })

  it('is negative for leftward motion', () => {
    const samples = [
      { x: 100, t: 0 },
      { x: 0, t: 50 },
    ]
    expect(computeReleaseVelocity(samples, 50)).toBeLessThan(0)
  })

  it('returns 0 when timestamps do not advance', () => {
    const samples = [
      { x: 0, t: 100 },
      { x: 50, t: 100 },
    ]
    expect(computeReleaseVelocity(samples, 100)).toBe(0)
  })
})
