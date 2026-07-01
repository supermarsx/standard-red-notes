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
    let debounceTimeout: number | undefined

    const handleWindowResize = () => {
      window.clearTimeout(debounceTimeout)

      window.setTimeout(() => {
        setDocumentRect(getBoundingClientRect())
      }, DebounceTimeInMs)
    }

    window.addEventListener('resize', handleWindowResize)

    return () => window.removeEventListener('resize', handleWindowResize)
  }, [])

  return documentRect
}
