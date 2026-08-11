import { applyVerticalWheelToHorizontalScroller } from './horizontalWheelScroll'

const scroller = (scrollLeft = 0) => ({ clientWidth: 300, scrollLeft, scrollWidth: 900 })

describe('applyVerticalWheelToHorizontalScroller', () => {
  it('moves an overflowing strip from vertical pixel-wheel input', () => {
    const target = scroller()

    expect(applyVerticalWheelToHorizontalScroller(target, { deltaX: 0, deltaY: 80, deltaMode: 0 })).toBe(true)
    expect(target.scrollLeft).toBe(80)
  })

  it('normalizes line and page wheel modes', () => {
    const lineTarget = scroller()
    const pageTarget = scroller()

    applyVerticalWheelToHorizontalScroller(lineTarget, { deltaX: 0, deltaY: 2, deltaMode: 1 })
    applyVerticalWheelToHorizontalScroller(pageTarget, { deltaX: 0, deltaY: 1, deltaMode: 2 })

    expect(lineTarget.scrollLeft).toBe(32)
    expect(pageTarget.scrollLeft).toBe(300)
  })

  it('does not hijack native horizontal gestures or page scrolling at an edge', () => {
    const target = scroller(600)

    expect(applyVerticalWheelToHorizontalScroller(target, { deltaX: 20, deltaY: 10, deltaMode: 0 })).toBe(false)
    expect(applyVerticalWheelToHorizontalScroller(target, { deltaX: 0, deltaY: 10, deltaMode: 0 })).toBe(false)
    expect(target.scrollLeft).toBe(600)
  })

  it('does nothing when the strip does not overflow', () => {
    const target = { clientWidth: 300, scrollLeft: 0, scrollWidth: 300 }

    expect(applyVerticalWheelToHorizontalScroller(target, { deltaX: 0, deltaY: 20, deltaMode: 0 })).toBe(false)
  })
})
