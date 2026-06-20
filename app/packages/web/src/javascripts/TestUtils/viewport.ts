/**
 * Viewport test harness for responsive/breakpoint behavior.
 *
 * jsdom does NOT evaluate real CSS, so Tailwind responsive utilities such as
 * `md:hidden` cannot be verified by computed visibility. What CAN be verified
 * is JS-driven responsive behavior: the app makes layout decisions from
 * `window.matchMedia(...)` (via `useMediaQuery` / `MediaQueryBreakpoints` and
 * the `isMobileScreen` / `isTabletScreen` helpers in `Utils`). This harness
 * installs a deterministic `matchMedia` mock that answers the app's
 * `(max-width: ...)` / `(min-width: ...)` / `(prefers-color-scheme: ...)`
 * queries consistently for a chosen viewport width, so a component or hook
 * renders its real width-dependent branch under jsdom.
 *
 * It intentionally mirrors the SAME query strings used by the app
 * (`MediaQueryBreakpoints` / `MutuallyExclusiveMediaQueryBreakpoints`) by
 * parsing the `min-width` / `max-width` constraints out of the query rather
 * than hard-coding breakpoints, so it stays correct if the breakpoints move.
 */

export type ColorScheme = 'light' | 'dark' | 'no-preference'

type Listener = (event: MediaQueryListEvent) => void

interface MockMediaQueryList extends MediaQueryList {
  __setMatches: (matches: boolean) => void
}

const WIDTH_FEATURE = /\((min|max)-width:\s*([0-9.]+)px\)/g
const POINTER_FINE = /\(pointer:\s*fine\)/
const PREFERS_DARK = /\(prefers-color-scheme:\s*dark\)/
const PREFERS_LIGHT = /\(prefers-color-scheme:\s*light\)/

/**
 * Evaluate a media query string for a fixed viewport width + color scheme the
 * same way a browser would for the feature subset the app relies on.
 */
export const evaluateMediaQuery = (query: string, width: number, colorScheme: ColorScheme): boolean => {
  if (PREFERS_DARK.test(query)) {
    return colorScheme === 'dark'
  }
  if (PREFERS_LIGHT.test(query)) {
    return colorScheme === 'light'
  }
  // The app only uses `pointer: fine` to detect a precise pointer (desktop).
  // Treat the simulated mobile/tablet widths as coarse and desktop as fine so
  // pointer-gated branches behave plausibly; callers that care can assert width
  // branches instead.
  if (POINTER_FINE.test(query)) {
    return width >= 1024
  }

  let matches = true
  let matched = false
  WIDTH_FEATURE.lastIndex = 0
  let result: RegExpExecArray | null
  while ((result = WIDTH_FEATURE.exec(query)) !== null) {
    matched = true
    const kind = result[1]
    const value = parseFloat(result[2])
    if (kind === 'min') {
      matches = matches && width >= value
    } else {
      matches = matches && width <= value
    }
  }

  // A query we don't understand should not silently match.
  return matched ? matches : false
}

let activeLists: Set<MockMediaQueryList> | undefined

/**
 * Install a deterministic `window.matchMedia` mock and set the viewport to the
 * given width. Returns a cleanup function that restores the previous
 * `matchMedia` (jest's `restoreMocks` also clears this between tests, but
 * returning a disposer keeps callers explicit).
 */
export const setViewport = (
  width: number,
  options: { height?: number; colorScheme?: ColorScheme } = {},
): (() => void) => {
  const height = options.height ?? 800
  let colorScheme: ColorScheme = options.colorScheme ?? 'no-preference'

  const previousMatchMedia = window.matchMedia
  const previousWidth = window.innerWidth
  const previousHeight = window.innerHeight

  const lists = new Set<MockMediaQueryList>()
  activeLists = lists

  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })

  const matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<Listener>()
    let matches = evaluateMediaQuery(query, width, colorScheme)

    const list: MockMediaQueryList = {
      media: query,
      get matches() {
        return matches
      },
      onchange: null,
      addListener: (cb: Listener | null) => {
        if (cb) {
          listeners.add(cb)
        }
      },
      removeListener: (cb: Listener | null) => {
        if (cb) {
          listeners.delete(cb)
        }
      },
      addEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.add(cb as Listener)
      },
      removeEventListener: (_type: string, cb: EventListenerOrEventListenerObject) => {
        listeners.delete(cb as Listener)
      },
      dispatchEvent: () => true,
      __setMatches: (next: boolean) => {
        if (next === matches) {
          return
        }
        matches = next
        const event = { matches: next, media: query } as MediaQueryListEvent
        listeners.forEach((listener) => listener(event))
      },
    }

    lists.add(list)
    return list
  }

  window.matchMedia = matchMedia as typeof window.matchMedia

  return () => {
    window.matchMedia = previousMatchMedia
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: previousWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: previousHeight })
    if (activeLists === lists) {
      activeLists = undefined
    }
    void colorScheme
  }
}

/**
 * Simulate a viewport change by updating innerWidth/innerHeight and notifying
 * every live MediaQueryList created by the current mock with its newly computed
 * `matches`. Dispatches a `resize` event for code that listens to that instead.
 * Use inside `act(...)` when a React tree is mounted.
 */
export const resizeViewport = (width: number, options: { height?: number; colorScheme?: ColorScheme } = {}): void => {
  const height = options.height ?? window.innerHeight
  const colorScheme: ColorScheme = options.colorScheme ?? 'no-preference'

  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, writable: true, value: height })

  if (activeLists) {
    for (const list of activeLists) {
      list.__setMatches(evaluateMediaQuery(list.media, width, colorScheme))
    }
  }

  window.dispatchEvent(new Event('resize'))
}

/** The viewport widths the responsive suite targets. */
export const TARGET_WIDTHS = [320, 375, 414, 768, 1024] as const
export type TargetWidth = (typeof TARGET_WIDTHS)[number]
