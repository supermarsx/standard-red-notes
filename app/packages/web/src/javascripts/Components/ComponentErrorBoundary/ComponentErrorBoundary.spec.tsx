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
 * The repo has no @testing-library, so we drive React directly with
 * react-dom/client's createRoot + act (mirroring __tests__/responsive/*).
 * React itself logs caught render errors to console.error; we spy/mock it for
 * the throwing cases so the suite output stays clean, then restore + assert.
 */
import { act, createElement, ReactNode } from 'react'
import { createRoot, Root } from 'react-dom/client'

// The repo maps `@standardnotes/toast` to identity-obj-proxy, which turns
// `addToast` into a string rather than a callable — the boundary's one-time
// toast would throw. Provide a real no-op mock so componentDidCatch runs.
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Loading: 'loading', Info: 'info', Regular: 'regular' },
}))

import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'

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
