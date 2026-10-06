/**
 * @jest-environment jsdom
 *
 * `lazyWithRetry` guards every code-split chunk in the app (the Super editor,
 * the PDF preview, Excalidraw, the Clipper/Assistant/Constellation views...), so
 * its failure behaviour is what a user sees when a chunk does not arrive. These
 * tests drive the real `React.lazy` + `Suspense` + `ComponentErrorBoundary`
 * pipeline rather than asserting that a function returned a function.
 *
 * The cases that matter:
 *  (a) a healthy import is loaded once, with no speculative second request;
 *  (b) a transient failure is recovered by exactly one retry;
 *  (c) a permanent failure costs exactly TWO attempts - never zero, never a loop;
 *  (d) the error that reaches the boundary is the one that ENDED the load, so a
 *      chunk failure reliably gets the chunk-specific "Reload" fallback;
 *  (e) nginx `try_files $uri /index.html` answers a missing `.js` with 200
 *      text/html, so a missing chunk arrives as a SyntaxError, not a 404 - and
 *      the wrapper must not re-fetch that HTML forever;
 *  (f) a synchronous throw from the factory is retried like a rejection instead
 *      of escaping as a render-phase crash;
 *  (g) React caches a lazy rejection permanently, so a boundary reset cannot
 *      re-run the import. This is pinned as a characterisation test because the
 *      wrapper's documentation depends on it being true.
 */
import { act, ComponentType, Suspense } from 'react'
import { createRoot, Root } from 'react-dom/client'

// `@standardnotes/toast` is mapped to identity-obj-proxy, which makes `addToast`
// a string rather than a callable; the boundary's one-time toast would throw.
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  ToastType: { Error: 'error', Success: 'success', Loading: 'loading', Info: 'info', Regular: 'regular' },
}))

import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LoadedComponent = () => <div data-testid="lazy-ok">lazy loaded</div>

type LoadedModule = { default: typeof LoadedComponent }

const CHUNK_URL = '/app-42.js'

let container: HTMLElement
let root: Root
let consoleError: jest.SpyInstance

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  // React logs every error a boundary catches; these tests provoke them on
  // purpose, so keep the suite output readable.
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  consoleError.mockRestore()
})

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Let React settle the lazy payload, its retry timer, and the resulting render. */
const settle = async (budgetMs = 400) => {
  const deadline = Date.now() + budgetMs
  let elapsed = 0
  while (elapsed === 0 || (Date.now() < deadline && container.textContent === 'loading chunk')) {
    await act(async () => {
      await sleep(5)
    })
    elapsed += 1
  }
}

const mount = (Lazy: ComponentType) => {
  act(() => {
    root.render(
      <ComponentErrorBoundary regionName="the editor">
        <Suspense fallback="loading chunk">
          <Lazy />
        </Suspense>
      </ComponentErrorBoundary>,
    )
  })
}

const buttonLabels = () => Array.from(container.querySelectorAll('button')).map((b) => (b.textContent ?? '').trim())

const clickButton = (label: string) => {
  const button = Array.from(container.querySelectorAll('button')).find((b) => (b.textContent ?? '').includes(label))
  expect(button).toBeDefined()
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const chunkLoadError = (chunkId: string, url: string) => {
  const error = new Error('Loading chunk ' + chunkId + ' failed.\n(load: ' + url + ')')
  error.name = 'ChunkLoadError'
  return error
}

/** The error the boundary logged, which is also the one it classified on. */
const reportedError = () => consoleError.mock.calls.flat().find((arg): arg is Error => arg instanceof Error)

describe('lazyWithRetry', () => {
  it('(a) loads a healthy chunk once and makes no speculative second request', async () => {
    const factory = jest.fn(async () => ({ default: LoadedComponent }))

    mount(lazyWithRetry(factory, 1))
    await settle()

    expect(container.querySelector('[data-testid="lazy-ok"]')).not.toBeNull()
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('(b) recovers a transient failure with exactly one retry', async () => {
    const factory = jest
      .fn<Promise<LoadedModule>, []>()
      .mockRejectedValueOnce(chunkLoadError('42', CHUNK_URL))
      .mockResolvedValueOnce({ default: LoadedComponent })

    mount(lazyWithRetry(factory, 1))
    await settle()

    expect(container.querySelector('[data-testid="lazy-ok"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Reload')
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('(c) gives up after exactly two attempts - no loop, and never zero retries', async () => {
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))

    mount(lazyWithRetry(factory, 1))
    await settle()

    expect(factory).toHaveBeenCalledTimes(2)

    // Nothing is scheduled behind our back: waiting longer adds no attempts.
    await act(async () => {
      await sleep(80)
    })
    expect(factory).toHaveBeenCalledTimes(2)
    expect(buttonLabels()).toContain('Reload')
  })

  it('(d) surfaces the error that ended the load, so a chunk failure gets the Reload fallback', async () => {
    const networkBlip = new Error('Network request failed')
    const factory = jest
      .fn<Promise<LoadedModule>, []>()
      .mockRejectedValueOnce(networkBlip)
      .mockRejectedValueOnce(chunkLoadError('42', CHUNK_URL))

    mount(lazyWithRetry(factory, 1))
    await settle()

    // Reporting the FIRST error here would classify a genuine chunk failure as a
    // generic one and offer only "Try again" - which React can never satisfy.
    expect(container.textContent).toContain('it may have just been updated')
    expect(buttonLabels()).toContain('Reload')

    // The first failure is kept reachable rather than discarded.
    expect(reportedError()?.name).toBe('ChunkLoadError')
    expect(reportedError()?.cause).toBe(networkBlip)
  })

  it('(d2) does not overwrite a cause the retry error already carries', async () => {
    const original = new Error('original')
    const retryError = new Error('retry', { cause: original })
    const factory = jest
      .fn<Promise<LoadedModule>, []>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(retryError)

    mount(lazyWithRetry(factory, 1))
    await settle()

    expect(retryError.cause).toBe(original)
  })

  it('(e) a chunk served as index.html fails as a SyntaxError and is fetched exactly twice', async () => {
    const INDEX_HTML = [
      '<!doctype html>',
      '<html lang="en">',
      '  <head><title>Standard Red Notes</title></head>',
      '  <body><div id="app"></div></body>',
      '</html>',
    ].join('\n')

    const served: string[] = []
    const syntaxErrors: string[] = []

    // Reproduces webpack's jsonp loader against an nginx `try_files` origin: the
    // request succeeds with 200 text/html, the browser parses the body as JS and
    // raises a SyntaxError, the chunk therefore never registers itself, and the
    // runtime reports a ChunkLoadError. There is no 404 anywhere in this path.
    const factory = jest.fn(async (): Promise<LoadedModule> => {
      served.push(CHUNK_URL)
      let registered = false
      try {
        new Function(INDEX_HTML)
        registered = true
      } catch (error) {
        syntaxErrors.push((error as Error).name)
      }
      if (!registered) {
        throw chunkLoadError('42', CHUNK_URL)
      }
      return { default: LoadedComponent }
    })

    mount(lazyWithRetry(factory, 1))
    await settle()

    // The HTML really is a syntax error, on both attempts.
    expect(syntaxErrors).toEqual(['SyntaxError', 'SyntaxError'])
    // Bounded: the same unchanging HTML is re-fetched once, not forever.
    expect(served).toEqual([CHUNK_URL, CHUNK_URL])

    await act(async () => {
      await sleep(80)
    })
    expect(served).toHaveLength(2)

    // The user is offered the only remedy that can work: a full reload.
    expect(reportedError()?.name).toBe('ChunkLoadError')
    expect(buttonLabels()).toContain('Reload')
  })

  it('(f) converts a synchronous throw into a rejection, so it suspends and is retried', async () => {
    const factory = jest.fn((() => {
      throw chunkLoadError('42', CHUNK_URL)
    }) as () => Promise<LoadedModule>)

    mount(lazyWithRetry(factory, 120))

    // The discriminator is WHEN the failure lands. A synchronous throw out of the
    // lazy initialiser is a render-phase crash: the boundary's fallback would
    // already be on screen here and the retry would never happen. Converting it
    // to a rejection makes the subtree suspend first, exactly as an async failure
    // does, which is what gives the retry a chance to run at all.
    expect(container.textContent).toBe('loading chunk')

    await settle(900)

    expect(factory).toHaveBeenCalledTimes(2)
    // The boundary caught it: the app is not blank and the fallback is shown.
    expect(buttonLabels()).toContain('Reload')
  })

  it('(g) React caches the rejection, so resetting the boundary cannot re-run the import', async () => {
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))

    mount(lazyWithRetry(factory, 1))
    await settle()
    expect(factory).toHaveBeenCalledTimes(2)

    clickButton('Try again')
    await settle()

    // The factory is NOT consulted again: React re-throws the stored rejection.
    expect(factory).toHaveBeenCalledTimes(2)
    expect(buttonLabels()).toContain('Reload')
  })

  it('(h) waits the configured delay before retrying', async () => {
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))
    const startedAt = Date.now()

    mount(lazyWithRetry(factory, 120))
    await settle(900)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
  })

  it('(i) defaults to a 600 ms delay when none is given', async () => {
    const factory = jest.fn(() => Promise.reject(chunkLoadError('42', CHUNK_URL)))
    const startedAt = Date.now()

    mount(lazyWithRetry(factory))
    await settle(2000)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500)
  })
})
