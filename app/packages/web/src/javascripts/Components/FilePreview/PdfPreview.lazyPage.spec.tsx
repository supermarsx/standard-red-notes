/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { PdfPage } from './PdfPreview'

jest.mock('@/Components/Spinner/Spinner', () => ({ __esModule: true, default: () => 'spinner' }))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('PdfPage viewport loading', () => {
  let container: HTMLElement
  let root: Root
  let originalIntersectionObserver: typeof IntersectionObserver | undefined
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext
  let renderPage: jest.Mock
  let page: import('pdfjs-dist').PDFPageProxy
  let pdfjs: { TextLayer: new () => { render: () => Promise<void>; cancel: () => void } }

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalIntersectionObserver = globalThis.IntersectionObserver
    originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = jest.fn(
      () => ({}),
    ) as unknown as typeof HTMLCanvasElement.prototype.getContext
    renderPage = jest.fn(() => ({ promise: Promise.resolve(), cancel: jest.fn() }))
    page = {
      getViewport: jest.fn(() => ({ width: 100, height: 120 })),
      render: renderPage,
      streamTextContent: jest.fn(() => ({})),
    } as unknown as import('pdfjs-dist').PDFPageProxy
    pdfjs = {
      TextLayer: class {
        render = jest.fn(async () => undefined)
        cancel = jest.fn()
      },
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    HTMLCanvasElement.prototype.getContext = originalGetContext
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      originalIntersectionObserver
  })

  const render = async () => {
    await act(async () => {
      root.render(
        createElement(PdfPage, {
          pdfjs,
          page,
          pageNumber: 1,
          scale: 1,
          searchQuery: '',
          matchCase: false,
          isActiveMatchPage: false,
          registerContainer: jest.fn(),
        }),
      )
      await Promise.resolve()
      await Promise.resolve()
    })
  }

  it('allows manual page loading and ignores a later observer callback', async () => {
    let intersectionCallback!: IntersectionObserverCallback
    const disconnect = jest.fn()
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = '800px 0px'
      readonly thresholds = [0]
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback
      }
      observe = jest.fn()
      disconnect = disconnect
      unobserve = jest.fn()
      takeRecords = jest.fn(() => [])
    } as unknown as typeof IntersectionObserver

    await render()
    expect(renderPage).not.toHaveBeenCalled()

    await act(async () => {
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Load PDF page 1')
        ?.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(renderPage).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)

    await act(async () => {
      intersectionCallback(
        [{ isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
      await Promise.resolve()
    })
    expect(renderPage).toHaveBeenCalledTimes(1)
  })

  it('fails open when IntersectionObserver is unavailable', async () => {
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = undefined

    await render()

    expect(renderPage).toHaveBeenCalledTimes(1)
  })
})
