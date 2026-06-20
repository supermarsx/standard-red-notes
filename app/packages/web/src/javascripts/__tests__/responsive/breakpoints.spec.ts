/**
 * @jest-environment jsdom
 *
 * Breakpoint UTIL contracts. These are the lowest-level responsive decisions in
 * the app: every higher-level layout (single-pane shell, tiling, footer chips)
 * ultimately keys off `window.matchMedia(...)` through these helpers / the
 * `MediaQueryBreakpoints` strings. jsdom can't evaluate the CSS the same tokens
 * also drive, so we verify the JS-observable matchMedia decision at each target
 * width.
 */
import { isMobileScreen, isTabletScreen, isTabletOrMobileScreen } from '@/Utils'
import { MediaQueryBreakpoints, MutuallyExclusiveMediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { evaluateMediaQuery, setViewport, TARGET_WIDTHS } from '@/TestUtils/viewport'

describe('responsive breakpoint utils', () => {
  let cleanup: () => void = () => undefined

  afterEach(() => {
    cleanup()
  })

  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanup = setViewport(width)
    })

    const expectMobile = width < 768
    const expectTablet = width >= 768 && width <= 1023
    const expectDesktop = width >= 1024

    it(`isMobileScreen() is ${width < 768}`, () => {
      expect(isMobileScreen()).toBe(expectMobile)
    })

    it(`isTabletScreen() is ${expectTablet}`, () => {
      expect(isTabletScreen()).toBe(expectTablet)
    })

    it(`isTabletOrMobileScreen() is ${expectMobile || expectTablet}`, () => {
      expect(isTabletOrMobileScreen()).toBe(expectMobile || expectTablet)
    })

    it(`desktop (>=1024) detection is ${expectDesktop}`, () => {
      // Desktop is "neither mobile nor tablet".
      expect(!isMobileScreen() && !isTabletScreen()).toBe(expectDesktop)
    })
  })

  it('classifies each target width into exactly one mutually-exclusive band', () => {
    const classify = (width: number) => {
      cleanup()
      cleanup = setViewport(width)
      return {
        mobile: isMobileScreen(),
        tablet: isTabletScreen(),
        desktop: !isMobileScreen() && !isTabletScreen(),
      }
    }

    expect(classify(320)).toEqual({ mobile: true, tablet: false, desktop: false })
    expect(classify(375)).toEqual({ mobile: true, tablet: false, desktop: false })
    expect(classify(414)).toEqual({ mobile: true, tablet: false, desktop: false })
    expect(classify(767)).toEqual({ mobile: true, tablet: false, desktop: false })
    expect(classify(768)).toEqual({ mobile: false, tablet: true, desktop: false })
    expect(classify(1023)).toEqual({ mobile: false, tablet: true, desktop: false })
    expect(classify(1024)).toEqual({ mobile: false, tablet: false, desktop: true })
  })
})

describe('media query string contracts (harness vs app breakpoints)', () => {
  // Verifies the harness answers the EXACT query strings the app uses the same
  // way the util helpers expect, so the breakpoint assertions above are testing
  // the real contract and not a harness artifact.
  it.each([
    [320, false, false],
    [375, false, false],
    [414, false, false],
    [767, false, false],
    [768, true, false],
    [1023, true, false],
    [1024, true, true],
  ])('at %ipx: md=%s lg=%s', (width, md, lg) => {
    expect(evaluateMediaQuery(MediaQueryBreakpoints.md, width, 'no-preference')).toBe(md)
    expect(evaluateMediaQuery(MediaQueryBreakpoints.lg, width, 'no-preference')).toBe(lg)
  })

  it('mutually-exclusive sm band is the phone range only', () => {
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm, 320, 'no-preference')).toBe(true)
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm, 767, 'no-preference')).toBe(true)
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm, 768, 'no-preference')).toBe(false)
  })

  it('mutually-exclusive md band is the tablet range only', () => {
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md, 767, 'no-preference')).toBe(false)
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md, 768, 'no-preference')).toBe(true)
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md, 1023, 'no-preference')).toBe(true)
    expect(evaluateMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.md, 1024, 'no-preference')).toBe(false)
  })

  it('answers prefers-color-scheme deterministically', () => {
    expect(evaluateMediaQuery('(prefers-color-scheme: dark)', 375, 'dark')).toBe(true)
    expect(evaluateMediaQuery('(prefers-color-scheme: dark)', 375, 'light')).toBe(false)
    expect(evaluateMediaQuery('(prefers-color-scheme: light)', 375, 'light')).toBe(true)
    expect(evaluateMediaQuery('(prefers-color-scheme: light)', 375, 'no-preference')).toBe(false)
  })
})
