import { useCallback, useEffect, useRef, type RefObject, type UIEvent } from 'react'

/** Follow the answer only in a visible, bottom-pinned conversation. */
export function useAssistantAutoScroll(
  containerRef: RefObject<HTMLDivElement | null>,
  isActive: boolean,
  messages: unknown,
  preparingPrompt: unknown,
) {
  const pinned = useRef(true)
  const onScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const element = event.currentTarget
    pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 48
  }, [])
  useEffect(() => {
    if (!isActive || !pinned.current) {
      return
    }
    const scroll = () => {
      const element = containerRef.current
      if (element && pinned.current) {
        element.scrollTo({ top: element.scrollHeight })
      }
    }
    if (typeof requestAnimationFrame === 'undefined') {
      scroll()
      return
    }
    const frame = requestAnimationFrame(scroll)
    return () => cancelAnimationFrame(frame)
  }, [containerRef, isActive, messages, preparingPrompt])
  return onScroll
}
