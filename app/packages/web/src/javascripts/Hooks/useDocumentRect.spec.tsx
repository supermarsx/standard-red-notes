/**
 * @jest-environment jsdom
 */
import { act, createElement } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { useDocumentRect } from './useDocumentRect'

jest.mock('@standardnotes/ui-services', () => ({
  isIOS: () => false,
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DebounceTimeInMs = 100

const Harness = ({ onRect }: { onRect: (rect: DOMRect) => void }) => {
  const rect = useDocumentRect()
  onRect(rect)
  return createElement('div', null, String(rect.width))
}

describe('useDocumentRect resize debounce', () => {
  let container: HTMLElement
  let root: Root
  let mounted: boolean
  let reads: number
  let width: number

  beforeEach(() => {
    jest.useFakeTimers()
    reads = 0
    width = 1000
    // Count every layout read the hook performs, and let a test move the
    // reported width so a re-render is observable.
    jest.spyOn(document.documentElement, 'getBoundingClientRect').mockImplementation(() => {
      reads++
      return { width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0 } as DOMRect
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    mounted = false
  })

  afterEach(() => {
    unmount()
    container.remove()
    jest.useRealTimers()
  })

  const render = () => {
    const rects: DOMRect[] = []
    act(() => {
      root.render(createElement(Harness, { onRect: (rect: DOMRect) => rects.push(rect) }))
    })
    mounted = true
    return rects
  }

  const unmount = () => {
    if (!mounted) {
      return
    }
    mounted = false
    act(() => {
      root.unmount()
    })
  }

  const dispatchResizes = (count: number) => {
    act(() => {
      for (let index = 0; index < count; index++) {
        window.dispatchEvent(new Event('resize'))
      }
    })
  }

  it('reads layout ONCE for a burst of resize events, not once per event', () => {
    const rects = render()

    // One mount read, via the lazy useState initializer.
    expect(reads).toBe(1)

    // A window drag: many resize events well inside the debounce window.
    width = 1234
    dispatchResizes(12)

    // Nothing has fired yet: all 12 events sit behind ONE pending timer.
    expect(reads).toBe(1)
    expect(jest.getTimerCount()).toBe(1)

    act(() => {
      jest.advanceTimersByTime(DebounceTimeInMs)
    })

    // Exactly one extra layout read for the whole burst. Before the fix the
    // setTimeout handle was never captured, so clearTimeout cleared nothing,
    // all 12 timers survived, and this was 13.
    expect(reads).toBe(2)
    expect(rects[rects.length - 1].width).toBe(1234)
  })

  it('restarts the deadline on each event instead of letting earlier ones fire', () => {
    render()
    expect(reads).toBe(1)

    dispatchResizes(3)
    act(() => {
      jest.advanceTimersByTime(DebounceTimeInMs - 1)
    })
    expect(reads).toBe(1)

    act(() => {
      jest.advanceTimersByTime(1)
    })
    expect(reads).toBe(2)
  })

  it('clears the pending timer on unmount so no layout read or state set survives', () => {
    render()

    dispatchResizes(4)
    expect(jest.getTimerCount()).toBe(1)

    unmount()

    expect(jest.getTimerCount()).toBe(0)

    const readsAtUnmount = reads
    act(() => {
      jest.advanceTimersByTime(DebounceTimeInMs * 10)
    })
    expect(reads).toBe(readsAtUnmount)
  })

  it('removes the resize listener on unmount', () => {
    render()
    const readsAtMount = reads

    unmount()

    dispatchResizes(5)
    act(() => {
      jest.advanceTimersByTime(DebounceTimeInMs * 2)
    })
    expect(reads).toBe(readsAtMount)
  })
})
