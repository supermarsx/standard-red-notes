import { isIOS } from '@standardnotes/ui-services'
import { useEffect, useState } from 'react'

const DebounceTimeInMs = 100

const getBoundingClientRect = () => {
  return isIOS() ? document.body.getBoundingClientRect() : document.documentElement.getBoundingClientRect()
}

export const useDocumentRect = (): DOMRect => {
  // Lazy initializer: run the layout-forcing getBoundingClientRect() ONCE on
  // mount instead of on every render. Passing the value directly
  // (useState(getBoundingClientRect())) re-invokes it — and forces a synchronous
  // reflow — on each render even though React only uses it the first time.
  const [documentRect, setDocumentRect] = useState<DOMRect>(() => getBoundingClientRect())

  useEffect(() => {
    // The handle MUST be captured: `clearTimeout` of an unassigned variable
    // clears nothing, so every resize event of a window drag would queue its own
    // layout read and re-render instead of one read after the burst settles.
    let debounceTimeout: number | undefined

    const handleWindowResize = () => {
      window.clearTimeout(debounceTimeout)

      debounceTimeout = window.setTimeout(() => {
        setDocumentRect(getBoundingClientRect())
      }, DebounceTimeInMs)
    }

    window.addEventListener('resize', handleWindowResize)

    return () => {
      window.removeEventListener('resize', handleWindowResize)
      // Unmounting between the last resize and the deadline must not leave a
      // timer that reads layout and sets state on a gone component.
      window.clearTimeout(debounceTimeout)
    }
  }, [])

  return documentRect
}
