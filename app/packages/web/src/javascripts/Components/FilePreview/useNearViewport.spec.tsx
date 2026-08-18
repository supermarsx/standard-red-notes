/** @jest-environment jsdom */

import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useNearViewport } from './useNearViewport'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const Harness = () => {
  const { isNearViewport, loadNow, setViewportTarget } = useNearViewport()
  return createElement(
    'div',
    { ref: setViewportTarget },
    isNearViewport
      ? createElement('span', { 'data-ready': 'true' }, 'Ready')
      : createElement('button', { onClick: loadNow, type: 'button' }, 'Load preview'),
  )
}

describe('useNearViewport', () => {
  let container: HTMLElement
  let root: Root
  let originalIntersectionObserver: typeof IntersectionObserver | undefined

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    originalIntersectionObserver = globalThis.IntersectionObserver
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver =
      originalIntersectionObserver
  })

  it('fails open when IntersectionObserver is unavailable', async () => {
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = undefined

    await act(async () => {
      root.render(createElement(Harness))
      await Promise.resolve()
    })

    expect(container.querySelector('[data-ready="true"]')).not.toBeNull()
  })

  it('provides a manual recovery control when an observer never reports', async () => {
    const disconnect = jest.fn()
    ;(globalThis as { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver = class {
      readonly root = null
      readonly rootMargin = '400px 0px'
      readonly thresholds = [0.01]
      observe = jest.fn()
      disconnect = disconnect
      unobserve = jest.fn()
      takeRecords = jest.fn(() => [])
    } as unknown as typeof IntersectionObserver

    await act(async () => root.render(createElement(Harness)))
    expect(container.querySelector('[data-ready="true"]')).toBeNull()

    act(() => container.querySelector('button')?.click())

    expect(container.querySelector('[data-ready="true"]')).not.toBeNull()
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
