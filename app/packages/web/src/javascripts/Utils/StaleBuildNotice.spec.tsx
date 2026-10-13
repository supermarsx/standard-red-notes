/**
 * @jest-environment jsdom
 */
import { act, Suspense } from 'react'
import { createRoot, Root } from 'react-dom/client'

type ToastRecord = { id: string; dismissed: boolean; [key: string]: unknown }
const mockToasts: ToastRecord[] = []

// A toast store that records what was shown, so "already on screen" and
// "dismissed" mean what they mean in the real one. The implementation is
// installed in beforeEach because this package's jest config resets mocks.
jest.mock('@standardnotes/toast', () => ({
  addToast: jest.fn(),
  toastStore: { get: () => mockToasts },
  ToastType: { Error: 'error', Success: 'success', Loading: 'loading', Regular: 'regular' },
}))

import { addToast } from '@standardnotes/toast'
import ComponentErrorBoundary from '@/Components/ComponentErrorBoundary/ComponentErrorBoundary'
import { lazyWithRetry } from '@/Utils/lazyWithRetry'
import {
  announceStaleBuild,
  installStaleBuildNotice,
  isChunkLoadFailure,
  OFFLINE_CHUNK_TITLE,
  reportIfStaleBuild,
  resetStaleBuildNoticeForTests,
  STALE_BUILD_TITLE,
} from './StaleBuildNotice'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const mockedAddToast = addToast as unknown as jest.Mock

/** What webpack 5's JSONP chunk loader rejects with. */
function webpackChunkLoadError(id = '5632'): Error {
  const error = new Error(`Loading chunk ${id} failed.\n(error: https://notes.example.test/${id}.app.js)`)
  error.name = 'ChunkLoadError'
  return error
}

beforeEach(() => {
  mockToasts.length = 0
  mockedAddToast.mockImplementation((options: Record<string, unknown>) => {
    const id = `toast-${mockToasts.length + 1}`
    mockToasts.push({ ...options, id, dismissed: false })
    return id
  })
  resetStaleBuildNoticeForTests()
})

describe('isChunkLoadFailure', () => {
  it('recognises every way a chunk can fail to arrive', () => {
    expect(isChunkLoadFailure(webpackChunkLoadError())).toBe(true)
    // The message alone, as when a ChunkLoadError crossed a realm and lost its name.
    expect(isChunkLoadFailure(new Error('Loading chunk 2499 failed.'))).toBe(true)
    const css = Object.assign(new Error('Loading CSS chunk 12 failed.\n(/12.app.css)'), {
      code: 'CSS_CHUNK_LOAD_FAILED',
    })
    expect(isChunkLoadFailure(css)).toBe(true)
    expect(isChunkLoadFailure(new TypeError('error loading dynamically imported module: /x.js'))).toBe(true)
    expect(isChunkLoadFailure(new TypeError('Failed to fetch dynamically imported module: /x.js'))).toBe(true)
  })

  it('does not claim errors that are not a missing chunk', () => {
    // The old symptom: a chunk from another build ran inside this one. That is
    // a TypeError anywhere in the app, so it is NOT matched by message.
    expect(isChunkLoadFailure(new TypeError('e[r] is undefined'))).toBe(false)
    expect(isChunkLoadFailure(new SyntaxError("expected expression, got '<'"))).toBe(false)
    expect(isChunkLoadFailure(new Error('Request failed with status 500'))).toBe(false)
    expect(isChunkLoadFailure(undefined)).toBe(false)
    expect(isChunkLoadFailure('Loading chunk 1 failed')).toBe(false)
  })
})

describe('announceStaleBuild', () => {
  it('shows one persistent toast whose only remedy is a Reload the user presses', () => {
    const reload = jest.fn()
    announceStaleBuild({ isOnline: () => true, reload })
    announceStaleBuild({ isOnline: () => true, reload })

    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    const [options] = mockedAddToast.mock.calls[0]
    expect(options).toMatchObject({ type: 'error', title: STALE_BUILD_TITLE, autoClose: false })
    expect(options.actions.map((action: { label: string }) => action.label)).toEqual(['Reload'])
    // Nothing reloads by itself: not on announce, not on a repeat.
    expect(reload).not.toHaveBeenCalled()

    options.actions[0].handler(options.id)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('shows the notice again after the user dismissed it', () => {
    announceStaleBuild({ isOnline: () => true })
    mockToasts[0].dismissed = true
    announceStaleBuild({ isOnline: () => true })
    expect(mockedAddToast).toHaveBeenCalledTimes(2)
  })

  it('does not blame a new version while the browser is offline', () => {
    announceStaleBuild({ isOnline: () => false })
    expect(mockedAddToast.mock.calls[0][0].title).toBe(OFFLINE_CHUNK_TITLE)
  })
})

describe('reportIfStaleBuild and the global listeners', () => {
  it('announces for a chunk failure only', () => {
    expect(reportIfStaleBuild(new Error('boom'))).toBe(false)
    expect(mockedAddToast).not.toHaveBeenCalled()
    expect(reportIfStaleBuild(webpackChunkLoadError(), { isOnline: () => true })).toBe(true)
    expect(mockedAddToast).toHaveBeenCalledTimes(1)
  })

  it('catches an unhandled dynamic-import rejection and an uncaught chunk error', () => {
    const listeners = new Map<string, (event: unknown) => void>()
    const target = {
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    }
    installStaleBuildNotice(target as unknown as Window, { isOnline: () => true })

    listeners.get('unhandledrejection')?.({ reason: new Error('not a chunk') })
    expect(mockedAddToast).not.toHaveBeenCalled()
    listeners.get('unhandledrejection')?.({ reason: webpackChunkLoadError() })
    expect(mockedAddToast).toHaveBeenCalledTimes(1)

    mockToasts[0].dismissed = true
    listeners.get('error')?.({ error: webpackChunkLoadError('77') })
    expect(mockedAddToast).toHaveBeenCalledTimes(2)
  })
})

describe('a lazy component whose chunk is gone', () => {
  let container: HTMLElement
  let root: Root
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // React logs every error a boundary catches; this one is provoked.
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    consoleError.mockRestore()
  })

  it('ends in ONE app-wide notice, not a per-region toast as well', async () => {
    const factory = jest.fn(() => Promise.reject(webpackChunkLoadError()))
    const Lazy = lazyWithRetry(factory, 0)

    await act(async () => {
      root.render(
        <ComponentErrorBoundary regionName="Super editor">
          <Suspense fallback={null}>
            <Lazy />
          </Suspense>
        </ComponentErrorBoundary>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })

    expect(factory).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain("Super editor couldn't load")
    expect(mockedAddToast).toHaveBeenCalledTimes(1)
    expect(mockedAddToast.mock.calls[0][0].title).toBe(STALE_BUILD_TITLE)
  })
})
