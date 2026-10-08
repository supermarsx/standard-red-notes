import { useEffect, useState } from 'react'

const DebounceTimeInMs = 100

type Options = {
  updateOnWindowResize: boolean
}

/**
 * Returns the bounding rect of an element, auto-updated when the element resizes.
 * Can optionally be auto-update on window resize.
 */
export const useAutoElementRect = (
  element: HTMLElement | null | undefined,
  { updateOnWindowResize }: Options = { updateOnWindowResize: false },
) => {
  const [rect, setRect] = useState<DOMRect>()

  useEffect(() => {
    // The handle MUST be captured: `clearTimeout` of an unassigned variable
    // clears nothing, so every resize event of a window drag would queue its own
    // getBoundingClientRect() and re-render instead of one read after the burst.
    let windowResizeDebounceTimeout: number | undefined
    let windowResizeHandler: () => void

    if (element) {
      const resizeObserver = new ResizeObserver(() => {
        setRect(element.getBoundingClientRect())
      })
      resizeObserver.observe(element)

      if (updateOnWindowResize) {
        windowResizeHandler = () => {
          window.clearTimeout(windowResizeDebounceTimeout)

          windowResizeDebounceTimeout = window.setTimeout(() => {
            setRect(element.getBoundingClientRect())
          }, DebounceTimeInMs)
        }
        window.addEventListener('resize', windowResizeHandler)
      }

      return () => {
        resizeObserver.unobserve(element)
        if (windowResizeHandler) {
          window.removeEventListener('resize', windowResizeHandler)
        }
        // A pending deadline must not outlive the effect: it would read layout
        // and set state after unmount, or against a replaced element.
        window.clearTimeout(windowResizeDebounceTimeout)
      }
    } else {
      setRect(undefined)
      return
    }
  }, [element, updateOnWindowResize])

  return rect
}

export const useElementResize = (element: HTMLElement | null | undefined, callback: () => void) => {
  useEffect(() => {
    // Same capture requirement as above: without the handle the window-resize
    // branch invokes `callback` once per resize event rather than once per burst.
    let windowResizeDebounceTimeout: number | undefined
    let windowResizeHandler: () => void

    if (element) {
      const resizeObserver = new ResizeObserver(() => {
        callback()
      })
      resizeObserver.observe(element)

      windowResizeHandler = () => {
        window.clearTimeout(windowResizeDebounceTimeout)

        windowResizeDebounceTimeout = window.setTimeout(() => {
          callback()
        }, DebounceTimeInMs)
      }
      window.addEventListener('resize', windowResizeHandler)

      return () => {
        resizeObserver.unobserve(element)
        window.removeEventListener('resize', windowResizeHandler)
        // A pending deadline must not outlive the effect and call a stale
        // callback after unmount or after the element/callback changed.
        window.clearTimeout(windowResizeDebounceTimeout)
      }
    } else {
      return
    }
  }, [element, callback])
}
