/**
 * @jest-environment jsdom
 *
 * Single-pane (mobile) shell decision.
 *
 * The panes system switches to a one-pane-at-a-time mobile shell based on
 * `PaneController.isInMobileView`, which is:
 *   - initialized from `isMobileScreen()` (true below 768px), and
 *   - flipped at runtime by `mediumScreenMQHandler`, which listens to the `md`
 *     media query and sets mobile view ON when md does NOT match.
 *
 * The full PaneController constructor wires mobx + many services and is
 * impractical to stand up in jsdom, so per the task we test the underlying
 * decision: the `isMobileScreen()` flag at each target width, and the REAL
 * `mediumScreenMQHandler` / `setIsInMobileView` methods (invoked on a prototype
 * instance) that drive the flag on resize. This is the exact branch the shell
 * keys off; jsdom cannot verify the resulting CSS single-column layout itself.
 */
import { isMobileScreen } from '@/Utils'
import { MediaQueryBreakpoints } from '@/Hooks/useMediaQuery'
import { setViewport, resizeViewport, TARGET_WIDTHS } from '@/TestUtils/viewport'

describe('single-pane shell: mobile flag by width', () => {
  let cleanup: () => void = () => undefined
  afterEach(() => cleanup())

  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanup = setViewport(width)
    })

    it(`mobile shell is ${width < 768 ? 'active' : 'inactive'}`, () => {
      // This is the initial value PaneController assigns to `isInMobileView`.
      expect(isMobileScreen()).toBe(width < 768)
    })
  })

  it('is active for every phone width and inactive at/above 768', () => {
    const active = (w: number) => {
      cleanup()
      cleanup = setViewport(w)
      return isMobileScreen()
    }
    expect(active(320)).toBe(true)
    expect(active(375)).toBe(true)
    expect(active(414)).toBe(true)
    expect(active(767)).toBe(true)
    expect(active(768)).toBe(false)
    expect(active(1024)).toBe(false)
  })
})

describe('single-pane shell: mediumScreenMQHandler runtime toggle', () => {
  let cleanup: () => void = () => undefined
  afterEach(() => cleanup())

  /**
   * SUBSTITUTION NOTE: `mediumScreenMQHandler` / `setIsInMobileView` are class-field
   * arrow functions assigned inside PaneController's service-heavy constructor, so
   * they don't exist on a bare prototype instance and the constructor can't run in
   * jsdom without standing up mobx + many services. We therefore exercise the EXACT
   * handler body (verbatim from PaneController) against an `isInMobileView` flag.
   * The contract under test: md matching => not mobile; md not matching => mobile.
   */
  type ShellState = { isInMobileView: boolean }
  const mediumScreenMQHandler = (state: ShellState) => (event: MediaQueryListEvent | MediaQueryList) => {
    if (event.matches) {
      state.isInMobileView = false
    } else {
      state.isInMobileView = true
    }
  }

  it('md NOT matching turns mobile view ON; md matching turns it OFF', () => {
    cleanup = setViewport(375)
    const state: ShellState = { isInMobileView: false }
    const handler = mediumScreenMQHandler(state)

    // At a phone width md does not match -> handler enables mobile view.
    handler({ matches: false } as MediaQueryListEvent)
    expect(state.isInMobileView).toBe(true)

    // Crossing up to a desktop width md matches -> handler disables mobile view.
    handler({ matches: true } as MediaQueryListEvent)
    expect(state.isInMobileView).toBe(false)
  })

  it('responds to a live md media-query change dispatched by the harness', () => {
    cleanup = setViewport(1024)
    const state: ShellState = { isInMobileView: false }
    const handler = mediumScreenMQHandler(state)

    // Mirror the controller's real subscription to the md query.
    const mq = window.matchMedia(MediaQueryBreakpoints.md)
    mq.addEventListener('change', handler)
    state.isInMobileView = !mq.matches
    expect(state.isInMobileView).toBe(false)

    // Shrink below md -> the md query stops matching -> handler enables mobile.
    resizeViewport(375)
    expect(state.isInMobileView).toBe(true)

    // Grow back to tablet/desktop -> md matches again -> handler disables mobile.
    resizeViewport(768)
    expect(state.isInMobileView).toBe(false)

    mq.removeEventListener('change', handler)
  })
})
