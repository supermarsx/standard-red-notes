/**
 * @jest-environment jsdom
 *
 * Preferences drill-in (phone single-column menu <-> content).
 *
 * Below the `sm` breakpoint PreferencesView collapses its two-column
 * menu+content layout into a single column and uses `mobileShowContent` to track
 * whether the menu list or a selected pane's content is showing. Selecting a
 * pane drills in (`mobileShowContent = true`); an effect resets it to false
 * whenever the viewport is NOT a phone (so the desktop two-column layout never
 * gets stuck in the drilled-in state).
 *
 * The full PreferencesView mounts a session controller + Modal and is heavy, so
 * per the task we verify (a) the `useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)`
 * decision the view keys off, at each target width, and (b) the EXACT drill-in
 * state machine (the same hook + reset effect + back-action selection that
 * PreferencesView uses) inside a minimal harness component. jsdom cannot verify
 * the resulting single- vs two-column CSS.
 */
import { createElement, useCallback, useEffect, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import { MutuallyExclusiveMediaQueryBreakpoints, useMediaQuery } from '@/Hooks/useMediaQuery'
import { setViewport, resizeViewport, TARGET_WIDTHS } from '@/TestUtils/viewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLElement
let root: Root
let cleanupViewport: () => void = () => undefined

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  cleanupViewport()
})

// Replicates PreferencesView's phone single-column state machine exactly.
const DrillInHarness = ({ onState }: { onState: (s: { isMobile: boolean; showContent: boolean; backTo: string }) => void }) => {
  const isMobileScreen = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
  const [mobileShowContent, setMobileShowContent] = useState(false)

  useEffect(() => {
    if (!isMobileScreen) {
      setMobileShowContent(false)
    }
  }, [isMobileScreen])

  const showContent = useCallback(() => setMobileShowContent(true), [])
  const showMenu = useCallback(() => setMobileShowContent(false), [])

  // Mirrors `mobileBackAction = mobileShowContent ? showMenu : closePreferences`.
  const backTo = mobileShowContent ? 'menu' : 'close'

  onState({ isMobile: isMobileScreen, showContent: mobileShowContent, backTo })

  return createElement('div', null, [
    createElement('button', { key: 'drill', 'data-testid': 'drill', onClick: showContent }, 'select pane'),
    createElement('button', { key: 'menu', 'data-testid': 'menu', onClick: showMenu }, 'back to menu'),
  ])
}

describe('preferences drill-in: phone detection by width', () => {
  const Probe = ({ onMatch }: { onMatch: (m: boolean) => void }) => {
    const isMobile = useMediaQuery(MutuallyExclusiveMediaQueryBreakpoints.sm)
    onMatch(isMobile)
    return null
  }

  describe.each(TARGET_WIDTHS)('at %ipx', (width) => {
    beforeEach(() => {
      cleanupViewport = setViewport(width)
    })

    it(`single-column drill-in flow is ${width < 768 ? 'enabled' : 'disabled'}`, () => {
      let isMobile = false
      act(() => {
        root.render(createElement(Probe, { onMatch: (m) => (isMobile = m) }))
      })
      expect(isMobile).toBe(width < 768)
    })
  })
})

describe('preferences drill-in: state machine', () => {
  it('toggles into content on pane select when on a phone', () => {
    cleanupViewport = setViewport(375)
    let state = { isMobile: false, showContent: false, backTo: '' }
    act(() => {
      root.render(createElement(DrillInHarness, { onState: (s) => (state = s) }))
    })
    expect(state).toMatchObject({ isMobile: true, showContent: false, backTo: 'close' })

    // Selecting a pane drills into content; back action now returns to the menu.
    act(() => {
      ;(container.querySelector('[data-testid="drill"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(state).toMatchObject({ showContent: true, backTo: 'menu' })

    // Going back to the menu resets the drill-in state.
    act(() => {
      ;(container.querySelector('[data-testid="menu"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(state).toMatchObject({ showContent: false, backTo: 'close' })
  })

  it('resets drilled-in content when crossing up from phone to >= md', () => {
    cleanupViewport = setViewport(375)
    let state = { isMobile: false, showContent: false, backTo: '' }
    act(() => {
      root.render(createElement(DrillInHarness, { onState: (s) => (state = s) }))
    })

    // Drill into content on the phone.
    act(() => {
      ;(container.querySelector('[data-testid="drill"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(state).toMatchObject({ isMobile: true, showContent: true })

    // Resize up to tablet/desktop: the effect must reset the single-column state.
    act(() => {
      resizeViewport(1024)
    })
    expect(state).toMatchObject({ isMobile: false, showContent: false, backTo: 'close' })
  })

  it('reports non-phone at desktop so the two-column layout is used', () => {
    cleanupViewport = setViewport(1024)
    let state = { isMobile: true, showContent: false, backTo: '' }
    act(() => {
      root.render(createElement(DrillInHarness, { onState: (s) => (state = s) }))
    })
    // On desktop the view is in two-column mode (`isMobile === false`); the
    // `mobileShowContent` flag is irrelevant there (PreferencesView only consults
    // it on phones). Initial drilled-in state is cleared by the reset effect.
    expect(state).toMatchObject({ isMobile: false, showContent: false })

    // A "select pane" click may flip the (unused-on-desktop) flag, but the layout
    // decision `isMobile` stays false — desktop never becomes single-column.
    act(() => {
      ;(container.querySelector('[data-testid="drill"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
    })
    expect(state.isMobile).toBe(false)
  })
})
