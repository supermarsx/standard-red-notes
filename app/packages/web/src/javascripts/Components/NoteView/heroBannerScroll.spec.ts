import { shouldShowHeroBanner } from './heroBannerScroll'

const at = (overrides: Partial<Parameters<typeof shouldShowHeroBanner>[0]>) =>
  shouldShowHeroBanner({
    scrollTop: 0,
    scrollHeight: 4000,
    clientHeight: 600,
    bannerHeight: 200,
    currentlyVisible: true,
    ...overrides,
  })

describe('shouldShowHeroBanner', () => {
  describe('at the absolute top', () => {
    it('shows the banner', () => {
      expect(at({ scrollTop: 0 })).toBe(true)
    })

    it('brings the banner back once the reader scrolls all the way up again', () => {
      expect(at({ scrollTop: 0, currentlyVisible: false })).toBe(true)
    })

    it('treats an elastic overscroll past the top as the top', () => {
      expect(at({ scrollTop: -40, currentlyVisible: false })).toBe(true)
    })
  })

  describe('away from the top', () => {
    it('hides the banner as soon as the reader scrolls at all', () => {
      expect(at({ scrollTop: 1 })).toBe(false)
    })

    it('stays hidden while the reader is anywhere below the top', () => {
      expect(at({ scrollTop: 1200, currentlyVisible: false })).toBe(false)
    })
  })

  describe('the flicker boundary', () => {
    // Hiding the banner hands its height back to the scroller. When the note is
    // barely taller than the viewport that is enough to make it unscrollable,
    // the browser clamps scrollTop to 0, and the banner would come straight back
    // — blinking once per wheel tick. These notes keep their banner instead.
    it('keeps the banner when the note has less scroll range than the banner is worth', () => {
      expect(at({ scrollTop: 5, scrollHeight: 700, clientHeight: 600, bannerHeight: 200 })).toBe(true)
    })

    it('keeps the banner when the scroll range exactly equals the banner height', () => {
      expect(at({ scrollTop: 5, scrollHeight: 800, clientHeight: 600, bannerHeight: 200 })).toBe(true)
    })

    it('hides the banner as soon as there is more scroll range than the banner is worth', () => {
      expect(at({ scrollTop: 5, scrollHeight: 801, clientHeight: 600, bannerHeight: 200 })).toBe(false)
    })

    it('does not let a short note re-show a banner that is already hidden', () => {
      // The guard only protects against hiding; nothing may drag the banner back
      // while the reader is still scrolled away from the top.
      expect(at({ scrollTop: 5, scrollHeight: 700, clientHeight: 600, currentlyVisible: false })).toBe(false)
    })

    it('hides a zero-height banner rather than treating it as unhideable', () => {
      expect(at({ scrollTop: 5, scrollHeight: 601, clientHeight: 600, bannerHeight: 0 })).toBe(false)
    })
  })

  it('never oscillates: re-applying the rule to its own outcome is stable', () => {
    // Guards the property that actually matters at the boundary — one scroll
    // event must not be able to start a show/hide loop.
    const cases = [
      { scrollTop: 0, scrollHeight: 4000, clientHeight: 600, bannerHeight: 200 },
      { scrollTop: 1, scrollHeight: 4000, clientHeight: 600, bannerHeight: 200 },
      { scrollTop: 1, scrollHeight: 700, clientHeight: 600, bannerHeight: 200 },
      { scrollTop: 900, scrollHeight: 4000, clientHeight: 600, bannerHeight: 200 },
    ]

    for (const scrollCase of cases) {
      const first = shouldShowHeroBanner({ ...scrollCase, currentlyVisible: true })
      const second = shouldShowHeroBanner({ ...scrollCase, currentlyVisible: first })
      expect(second).toBe(first)
    }
  })
})
