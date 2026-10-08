/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useAutoElementRect, useElementResize } from './useElementRect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DebounceTimeInMs = 100

type ObserverRecord = { observed: HTMLElement[]; unobserved: HTMLElement[] }

const observers: ObserverRecord[] = []

class ResizeObserverStub {
  private record: ObserverRecord = { observed: [], unobserved: [] }

  constructor(_callback: () => void) {
    observers.push(this.record)
  }

  observe(element: HTMLElement) {
    this.record.observed.push(element)
  }

  unobserve(element: HTMLElement) {
    this.record.unobserved.push(element)
  }

  disconnect() {}
}

describe('useElementRect window-resize debounce', () => {
  let container: HTMLElement
  let root: Root
  let mounted: boolean
  let element: HTMLElement
  let reads: number
  let width: number

  beforeEach(() => {
    jest.useFakeTimers()
    observers.length = 0
    reads = 0
    width = 400
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = ResizeObserverStub
    container = document.createElement('div')
    document.body.appendChild(container)
    element = document.createElement('div')
    document.body.appendChild(element)
    jest.spyOn(element, 'getBoundingClientRect').mockImplementation(() => {
      reads++
      return { width, height: 50, top: 0, left: 0, right: width, bottom: 50, x: 0, y: 0 } as DOMRect
    })
    root = createRoot(container)
    mounted = false
  })

  afterEach(() => {
    unmount()
    container.remove()
    element.remove()
    jest.useRealTimers()
  })

  const unmount = () => {
    if (!mounted) {
      return
    }
    mounted = false
    act(() => {
      root.unmount()
    })
  }

  const render = (node: ReturnType<typeof createElement>) => {
    act(() => {
      root.render(node)
    })
    mounted = true
  }

  const dispatchResizes = (count: number) => {
    act(() => {
      for (let index = 0; index < count; index++) {
        window.dispatchEvent(new Event('resize'))
      }
    })
  }

  describe('useAutoElementRect', () => {
    const Harness = ({ target, onRect }: { target: HTMLElement; onRect: (rect?: DOMRect) => void }) => {
      const rect = useAutoElementRect(target, { updateOnWindowResize: true })
      onRect(rect)
      return createElement('div', null, String(rect?.width ?? 'none'))
    }

    it('reads layout ONCE for a burst of window-resize events, not once per event', () => {
      const rects: (DOMRect | undefined)[] = []
      render(createElement(Harness, { target: element, onRect: (rect) => rects.push(rect) }))

      // Nothing is read on mount: the hook starts with an undefined rect and
      // waits for the ResizeObserver or a window resize.
      expect(reads).toBe(0)

      width = 777
      dispatchResizes(10)

      // All 10 events sit behind ONE pending timer.
      expect(reads).toBe(0)
      expect(jest.getTimerCount()).toBe(1)

      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs)
      })

      // Before the fix the handle was never captured, so clearTimeout cleared
      // nothing, all 10 timers survived, and this was 10.
      expect(reads).toBe(1)
      expect(rects[rects.length - 1]?.width).toBe(777)
    })

    it('clears the pending timer on unmount and still unobserves the element', () => {
      render(createElement(Harness, { target: element, onRect: () => undefined }))

      dispatchResizes(6)
      expect(jest.getTimerCount()).toBe(1)

      unmount()

      expect(jest.getTimerCount()).toBe(0)
      expect(observers[0].unobserved).toEqual([element])

      const readsAtUnmount = reads
      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs * 10)
      })
      expect(reads).toBe(readsAtUnmount)
    })

    it('does not listen for window resizes when updateOnWindowResize is off', () => {
      const OffHarness = ({ target }: { target: HTMLElement }) => {
        const rect = useAutoElementRect(target)
        return createElement('div', null, String(rect?.width ?? 'none'))
      }
      render(createElement(OffHarness, { target: element }))

      dispatchResizes(4)
      expect(jest.getTimerCount()).toBe(0)
      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs * 2)
      })
      expect(reads).toBe(0)
    })
  })

  describe('useElementResize', () => {
    const Harness = ({ target, callback }: { target: HTMLElement; callback: () => void }) => {
      useElementResize(target, callback)
      return createElement('div', null, 'resize-target')
    }

    it('invokes the callback ONCE for a burst of window-resize events', () => {
      const callback = jest.fn()
      render(createElement(Harness, { target: element, callback }))

      dispatchResizes(9)

      expect(callback).not.toHaveBeenCalled()
      expect(jest.getTimerCount()).toBe(1)

      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs)
      })

      // Before the fix this was 9: one surviving timer per resize event.
      expect(callback).toHaveBeenCalledTimes(1)
    })

    it('clears the pending timer on unmount so the callback never runs late', () => {
      const callback = jest.fn()
      render(createElement(Harness, { target: element, callback }))

      dispatchResizes(3)
      expect(jest.getTimerCount()).toBe(1)

      unmount()

      expect(jest.getTimerCount()).toBe(0)
      expect(observers[0].unobserved).toEqual([element])

      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs * 10)
      })
      expect(callback).not.toHaveBeenCalled()
    })

    it('does not carry a pending deadline across a callback change', () => {
      const first = jest.fn()
      const second = jest.fn()
      render(createElement(Harness, { target: element, callback: first }))

      dispatchResizes(2)
      expect(jest.getTimerCount()).toBe(1)

      render(createElement(Harness, { target: element, callback: second }))

      // The effect re-ran for the new callback, so the old deadline is gone.
      expect(jest.getTimerCount()).toBe(0)
      act(() => {
        jest.advanceTimersByTime(DebounceTimeInMs * 10)
      })
      expect(first).not.toHaveBeenCalled()
      expect(second).not.toHaveBeenCalled()
    })
  })
})
