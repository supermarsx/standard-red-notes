type HorizontalScroller = Pick<HTMLElement, 'clientWidth' | 'scrollLeft' | 'scrollWidth'>

type WheelDelta = {
  deltaX: number
  deltaY: number
  deltaMode: number
}

const WHEEL_DELTA_LINE = 1
const WHEEL_DELTA_PAGE = 2
const LINE_HEIGHT_PX = 16

/**
 * Translate a predominantly vertical wheel gesture into bounded horizontal
 * movement. Returns false at either edge so normal page scrolling can continue.
 */
export function applyVerticalWheelToHorizontalScroller(
  scroller: HorizontalScroller,
  { deltaX, deltaY, deltaMode }: WheelDelta,
): boolean {
  if (deltaY === 0 || Math.abs(deltaY) <= Math.abs(deltaX)) {
    return false
  }

  const maxScrollLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth)
  if (maxScrollLeft === 0) {
    return false
  }

  const pixelDelta =
    deltaMode === WHEEL_DELTA_LINE
      ? deltaY * LINE_HEIGHT_PX
      : deltaMode === WHEEL_DELTA_PAGE
        ? deltaY * scroller.clientWidth
        : deltaY
  const nextScrollLeft = Math.min(maxScrollLeft, Math.max(0, scroller.scrollLeft + pixelDelta))
  if (nextScrollLeft === scroller.scrollLeft) {
    return false
  }

  scroller.scrollLeft = nextScrollLeft
  return true
}
