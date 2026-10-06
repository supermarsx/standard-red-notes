/**
 * @jest-environment jsdom
 *
 * ComponentErrorBoundary — behavioral guarantees:
 *  (a) renders children untouched when nothing throws;
 *  (b) a throwing child yields the graceful fallback card (the app does NOT
 *      unmount to a blank screen) — "Something went wrong" is shown;
 *  (c) the fallback surfaces the failure details (error message + stacks) inside
 *      the collapsible <details>/<pre>;
 *  (d) "Try again" resets the boundary, re-renders children (now that they no
 *      longer throw) AND fires the onReset callback.
 *
 * The second describe covers the remedy the fallback offers, which is the part a
 * stranded user actually depends on. React caches a lazy rejection permanently
 * (`lazyInitializer` only calls the factory while the payload status is
 * Uninitialized, and the Pending transition overwrites the stored factory), so a
 * boundary reset can never re-run a failed `import()`. These tests drive REAL
 * failing lazy imports through a REAL boundary and assert which buttons exist
 * and what each one does when clicked:
 *  (e) a cached lazy rejection leads with Reload, and the demoted "Try again"
 *      removes itself the instant it is proven futile — the screen is no longer
 *      pixel-identical after the click;
 *  (f) nginx `try_files $uri /index.html` answers a missing chunk with 200
 *      text/html, so the chunk arrives as a SyntaxError that no ChunkLoadError
 *      pattern matches — the user must still be offered Reload;
 *  (g) "Reload" really triggers a page load;
 *  (h) a genuinely resettable failure keeps a "Try again" that really works, and
 *      gains Reload as an escape hatch;
 *  (i) when the lazy is not statically reachable the first classification falls
 *      back to generic, and one proven-futile reset still withdraws the button;
 *  (j) the cached-rejection check demands object identity, so it cannot mistake
 *      an unrelated failure for an un-resettable one.
 *
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring __tests__/responsive/*).
 * React itself logs caught render errors to console.error; we spy/mock it for
 * the throwing cases so the suite output stays clean, then restore + assert.
 */
import { act, ComponentType, createElement, lazy, ReactNode, Suspense } from 'react'
import { createRoot, Root } from 'react-dom/client'

// The repo maps `@standardnotes/toast` to identity-obj-proxy, which turns
// `addToast` into a string rather than a callable — the boundary's one-time
// toast would throw. Provide a real no-op mock so componentDidCatch runs.
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Loading: 'loading', Info: 'info', Regular: 'regular' },
}))

import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import { isCachedLazyRejection } from '@/Components/ComponentErrorBoundary/isCachedLazyRejection'
import * as ReloadPageModule from '@/Components/ComponentErrorBoundary/reloadPage'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BOOM_MESSAGE = 'Boom from child'

/**
 * A child that throws on render while `shouldThrow.value` is true. Toggling the
 * ref to false and resetting the boundary lets it render successfully, which is
 * how the "Try again re-renders children" case is exercised.
 */
const Thrower = ({ shouldThrow }: { shouldThrow: { value: boolean } }): ReactNode => {
  if (shouldThrow.value) {
    throw new Error(BOOM_MESSAGE)
  }
  return createElement('div', { 'data-testid': 'child-ok' }, 'child rendered')
}

let container: HTMLElement
let root: Root

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
})

/** Silence the expected React "caught error" console noise for a throwing render. */
const withSilencedConsole = (fn: () => void) => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
}

describe('ComponentErrorBoundary', () => {
  it('(a) renders children normally when nothing throws', () => {
    const shouldThrow = { value: false }
    act(() => {
      root.render(
        createElement(ComponentErrorBoundary, {
          regionName: 'The editor',
          children: createElement(Thrower, { shouldThrow }),
        }),
      )
    })

    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Something went wrong')
  })

  it('(b) renders the fallback card instead of crashing when a child throws', () => {
    const shouldThrow = { value: true }
    withSilencedConsole(() => {
      act(() => {
        root.render(
          createElement(ComponentErrorBoundary, {
            regionName: 'The editor',
            children: createElement(Thrower, { shouldThrow }),
          }),
        )
      })
    })

    // The app is NOT blank: the boundary swapped in a fallback with the heading.
    expect(container.textContent).toContain('Something went wrong')
    expect(container.textContent).toContain('The editor')
    // Children are gone (they threw) but the container still has content.
    expect(container.querySelector('[data-testid="child-ok"]')).toBeNull()
    expect(container.textContent?.length).toBeGreaterThan(0)
  })

  it('(c) exposes the error + stacks inside the collapsible details', () => {
    const shouldThrow = { value: true }
    withSilencedConsole(() => {
      act(() => {
        root.render(
          createElement(ComponentErrorBoundary, {
            regionName: 'The editor',
            children: createElement(Thrower, { shouldThrow }),
          }),
        )
      })
    })

    const details = container.querySelector('details')
    expect(details).not.toBeNull()
    const pre = details?.querySelector('pre')
    expect(pre).not.toBeNull()

    const traceText = pre?.textContent ?? ''
    // error.message
    expect(traceText).toContain(BOOM_MESSAGE)
    // component stack — React names the throwing component in the stack.
    expect(traceText).toContain('Thrower')
  })

  it('(d) "Try again" resets the boundary, re-renders children, and fires onReset', () => {
    const shouldThrow = { value: true }
    const onReset = jest.fn()

    withSilencedConsole(() => {
      act(() => {
        root.render(
          createElement(ComponentErrorBoundary, {
            regionName: 'The editor',
            onReset,
            children: createElement(Thrower, { shouldThrow }),
          }),
        )
      })
    })

    // Fallback is shown, child not rendered.
    expect(container.querySelector('[data-testid="child-ok"]')).toBeNull()

    // The child will no longer throw once the boundary resets and re-renders it.
    shouldThrow.value = false

    const tryAgain = Array.from(container.querySelectorAll('button')).find((b) =>
      (b.textContent ?? '').includes('Try again'),
    )
    expect(tryAgain).toBeDefined()

    act(() => {
      tryAgain?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onReset).toHaveBeenCalledTimes(1)
    // Children re-rendered successfully; fallback is gone.
    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Something went wrong')
  })
})

/* ------------------------------------------------------------------------- *
 * The remedy the fallback offers
 * ------------------------------------------------------------------------- */

const LoadedComponent = () => createElement('div', { 'data-testid': 'lazy-ok' }, 'lazy loaded')
type LoadedModule = { default: typeof LoadedComponent }

const CHUNK_URL = '/app-42.js'

const chunkLoadError = (chunkId: string, url: string) => {
  const error = new Error('Loading chunk ' + chunkId + ' failed.\n(load: ' + url + ')')
  error.name = 'ChunkLoadError'
  return error
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Let React settle the lazy payload, any retry timer, and the resulting render. */
const settle = async (budgetMs = 600) => {
  const deadline = Date.now() + budgetMs
  let iterations = 0
  while (iterations === 0 || (Date.now() < deadline && container.textContent === 'loading chunk')) {
    await act(async () => {
      await sleep(5)
    })
    iterations += 1
  }
}

const buttons = () => Array.from(container.querySelectorAll('button'))
const buttonLabels = () => buttons().map((b) => (b.textContent ?? '').trim())
/** The Button component drops the border for `primary`, so this is the lead action. */
const primaryButtonLabel = () =>
  buttons()
    .filter((b) => b.classList.contains('no-border'))
    .map((b) => (b.textContent ?? '').trim())[0]

const clickButton = (label: string) => {
  const button = buttons().find((b) => (b.textContent ?? '').trim() === label)
  expect(button).toBeDefined()
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const mountLazy = (Lazy: ComponentType, children?: (lazyElement: ReactNode) => ReactNode) => {
  const lazyElement = createElement(Suspense, { fallback: 'loading chunk' }, createElement(Lazy))
  act(() => {
    root.render(
      createElement(ComponentErrorBoundary, {
        regionName: 'the editor',
        children: children ? children(lazyElement) : lazyElement,
      }),
    )
  })
}

describe('ComponentErrorBoundary — the remedy it offers', () => {
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    // These tests provoke caught render errors on purpose.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    consoleError.mockRestore()
  })

  /** The error the boundary logged, which is also the one it classified on. */
  const reportedError = () => consoleError.mock.calls.flat().find((arg): arg is Error => arg instanceof Error)

  /**
   * jsdom 29 makes `window.location.reload` a non-writable, non-configurable own
   * property and then does nothing when it is called, so it can be neither
   * stubbed nor observed. The reload is therefore pinned in two halves that meet
   * in the middle: this spy proves the button is wired to the page-reload
   * routine, and (g2) proves that routine really calls `location.reload()`.
   */
  const spyOnReload = () => jest.spyOn(ReloadPageModule, 'reloadPage').mockImplementation(() => undefined)

  it('(e) a cached lazy rejection leads with Reload, and withdraws "Try again" once it is proven futile', async () => {
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))

    // React's own `lazy`, so the behaviour under test is React's cache and not
    // anything `lazyWithRetry` adds: exactly one attempt is expected here.
    mountLazy(lazy(factory as () => Promise<LoadedModule>))
    await settle()

    expect(factory).toHaveBeenCalledTimes(1)
    // What the user sees first: the remedy that works, in the lead position.
    expect(buttonLabels()).toEqual(['Reload', 'Try again'])
    expect(primaryButtonLabel()).toBe('Reload')
    expect(container.textContent).toContain("the editor couldn't load")

    clickButton('Try again')
    await settle()

    // The import is NOT re-run: React re-throws the cached rejection without
    // ever consulting the factory again.
    expect(factory).toHaveBeenCalledTimes(1)

    // Before this fix the screen was pixel-identical here, with the same dead
    // button still inviting another pointless click. Now the button is gone and
    // the user is told what actually works.
    expect(buttonLabels()).toEqual(['Reload'])
    expect(primaryButtonLabel()).toBe('Reload')
    expect(container.textContent).toContain("Trying again didn't help")
    expect(container.textContent).toContain('Reloading the page is the only thing that can fix this')
  })

  it('(f) a chunk served as index.html fails as a SyntaxError and still gets Reload, not a lone "Try again"', async () => {
    const INDEX_HTML = [
      '<!doctype html>',
      '<html lang="en">',
      '  <head><title>Standard Red Notes</title></head>',
      '  <body><div id="app"></div></body>',
      '</html>',
    ].join('\n')

    // nginx `try_files $uri /index.html` answers a missing `.js` with 200
    // text/html. Under a native ESM import there is no webpack jsonp runtime to
    // translate that into a ChunkLoadError: the parse failure propagates raw.
    const factory = jest.fn(async (): Promise<LoadedModule> => {
      new Function(INDEX_HTML)
      return { default: LoadedComponent }
    })

    mountLazy(lazyWithRetry(factory, 1))
    await settle()

    const reported = reportedError()
    // The error really is a SyntaxError, and it is invisible to every
    // ChunkLoadError pattern — classification by message would send this down
    // the generic "you can try again" path, which can never recover it.
    expect(reported?.name).toBe('SyntaxError')
    expect(reported?.name).not.toBe('ChunkLoadError')
    expect(/Loading chunk [\w-]+ failed/i.test(reported?.message ?? '')).toBe(false)

    // Classified by what it IS — a rejected lazy payload — rather than by what
    // it is called, so the user is still offered the only working remedy.
    expect(container.textContent).toContain("the editor couldn't load")
    expect(buttonLabels()).toEqual(['Reload', 'Try again'])
    expect(primaryButtonLabel()).toBe('Reload')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('(g) "Reload" fetches the whole document again, which is the only thing that can re-fetch the chunk', async () => {
    const reload = spyOnReload()
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))

    mountLazy(lazy(factory as () => Promise<LoadedModule>))
    await settle()

    expect(reload).not.toHaveBeenCalled()
    clickButton('Reload')

    expect(reload).toHaveBeenCalledTimes(1)
    // It reloads rather than resetting: the fallback is untouched and the dead
    // retry path was not taken behind the label.
    expect(factory).toHaveBeenCalledTimes(1)
    expect(buttonLabels()).toEqual(['Reload', 'Try again'])
    expect(container.textContent).not.toContain("Trying again didn't help")
  })

  it('(g2) the page-reload routine calls location.reload() on the window it is given', () => {
    const reload = jest.fn()
    ReloadPageModule.reloadPage({ location: { reload } } as unknown as Window)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('(h) a resettable failure keeps a "Try again" that really works, and gains Reload as an escape hatch', () => {
    const reload = spyOnReload()
    const shouldThrow = { value: true }

    act(() => {
      root.render(
        createElement(ComponentErrorBoundary, {
          regionName: 'the editor',
          children: createElement(Thrower, { shouldThrow }),
        }),
      )
    })

    // A plain render failure can genuinely be re-attempted, so it leads with it.
    expect(buttonLabels()).toEqual(['Try again', 'Reload'])
    expect(primaryButtonLabel()).toBe('Try again')
    expect(container.textContent).toContain('You can try again, or reload the page')

    shouldThrow.value = false
    clickButton('Try again')

    // It actually recovered — no reload needed, and none was triggered.
    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('(i) a lazy the boundary cannot see is still proven un-resettable by the first failed reset', async () => {
    // The lazy is rendered BY an intermediate component instead of being handed
    // to the boundary, so the structural check cannot reach it; and the error is
    // not chunk-shaped, so the heuristic misses it too. This is the worst case.
    const notAChunkError = new TypeError("Cannot read properties of undefined (reading 'default')")
    const factory = jest.fn(() => Promise.reject(notAChunkError))
    const Lazy = lazy(factory as () => Promise<LoadedModule>)
    const LazyHost = () => createElement(Suspense, { fallback: 'loading chunk' }, createElement(Lazy))

    act(() => {
      root.render(
        createElement(ComponentErrorBoundary, {
          regionName: 'the editor',
          children: createElement(LazyHost),
        }),
      )
    })
    await settle()

    // Classified generic, and crucially NOT left as a single dead button.
    expect(buttonLabels()).toEqual(['Try again', 'Reload'])
    expect(primaryButtonLabel()).toBe('Try again')

    clickButton('Try again')
    await settle()

    // One attempt is all it takes to prove the reset changes nothing.
    expect(factory).toHaveBeenCalledTimes(1)
    expect(buttonLabels()).toEqual(['Reload'])
    expect(container.textContent).toContain("Trying again didn't help")
  })

  it('(i2) a reset that worked is not held against a component that reuses one error object', () => {
    // "The identical error came back" is proof only when the reset in between
    // failed. A component throwing a module-level error constant would otherwise
    // be told to reload the page over a failure it had already recovered from.
    const recycled = new Error('recycled error instance')
    const failing = { value: true }
    const Recycler = (): ReactNode => {
      if (failing.value) {
        throw recycled
      }
      return createElement('div', { 'data-testid': 'child-ok' }, 'child rendered')
    }
    const renderBoundary = () =>
      act(() => {
        root.render(
          createElement(ComponentErrorBoundary, {
            regionName: 'the editor',
            children: createElement(Recycler),
          }),
        )
      })

    renderBoundary()
    expect(buttonLabels()).toEqual(['Try again', 'Reload'])

    failing.value = false
    clickButton('Try again')
    expect(container.querySelector('[data-testid="child-ok"]')).not.toBeNull()

    // The very same object throws again, but this time nothing has been
    // disproved, so the working remedy is still offered.
    failing.value = true
    renderBoundary()

    expect(buttonLabels()).toEqual(['Try again', 'Reload'])
    expect(container.textContent).not.toContain("Trying again didn't help")
  })

  it('(j) the cached-rejection check demands object identity', async () => {
    const cached = chunkLoadError('42', CHUNK_URL)
    const factory = jest.fn(() => Promise.reject(cached))
    const Lazy = lazy(factory as () => Promise<LoadedModule>)

    mountLazy(Lazy)
    await settle()

    const nested = createElement(
      'div',
      null,
      createElement('div', null, createElement(Suspense, { fallback: null }, createElement(Lazy))),
    )

    // The payload really is parked at Rejected, and the walk reaches it through
    // several levels of markup.
    expect(isCachedLazyRejection(nested, cached)).toBe(true)
    // A different failure in the same subtree proves nothing about that failure.
    expect(isCachedLazyRejection(nested, new Error('something else'))).toBe(false)
    // No lazy in reach at all.
    expect(isCachedLazyRejection(createElement('div', null, 'plain'), cached)).toBe(false)
    expect(isCachedLazyRejection(null, cached)).toBe(false)
  })
})
