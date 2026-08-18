import { useCallback, useEffect, useState } from 'react'

type Options = {
  rootMargin?: string
  threshold?: number
}

/**
 * Defers expensive preview work until its host is close to the viewport.
 *
 * The gate is intentionally one-way: once a user scrolls close enough, the
 * preview remains mounted so media playback and editor state are not destroyed
 * by a small scroll. Environments without IntersectionObserver (older WebViews,
 * SSR hydration, and tests) fail open so an attachment never becomes unusable.
 */
export function useNearViewport({ rootMargin = '400px 0px', threshold = 0.01 }: Options = {}): {
  isNearViewport: boolean
  loadNow: () => void
  setViewportTarget: (element: HTMLElement | null) => void
} {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  const [isNearViewport, setIsNearViewport] = useState(false)
  const setViewportTarget = useCallback((element: HTMLElement | null) => setTarget(element), [])
  const loadNow = useCallback(() => setIsNearViewport(true), [])

  useEffect(() => {
    if (isNearViewport || !target) {
      return
    }

    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setIsNearViewport(true)
        }
      },
      { rootMargin, threshold },
    )
    observer.observe(target)

    return () => observer.disconnect()
  }, [isNearViewport, rootMargin, target, threshold])

  return { isNearViewport, loadNow, setViewportTarget }
}
