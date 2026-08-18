import { RefObject, useCallback, useEffect } from 'react'
import { useLongPressEvent } from './useLongPress'
import { isIOS } from '@standardnotes/ui-services'

export const useContextMenuEvent = (
  elementRef: RefObject<HTMLElement | null>,
  listener: (x: number, y: number, trigger?: HTMLElement) => void,
) => {
  const { attachEvents, cleanupEvents } = useLongPressEvent(
    elementRef,
    (x, y) => listener(x, y, elementRef.current ?? undefined),
    true,
  )

  const handleContextMenuEvent = useCallback(
    (event: MouseEvent) => {
      event.preventDefault()
      event.stopPropagation()
      listener(
        event.clientX,
        event.clientY,
        event.target instanceof HTMLElement ? event.target : (elementRef.current ?? undefined),
      )
    },
    [elementRef, listener],
  )

  useEffect(() => {
    const element = elementRef.current

    if (!element) {
      return
    }

    const shouldUseLongPress = isIOS()

    element.addEventListener('contextmenu', handleContextMenuEvent)

    if (shouldUseLongPress) {
      attachEvents()
    }

    return () => {
      element.removeEventListener('contextmenu', handleContextMenuEvent)
      if (shouldUseLongPress) {
        cleanupEvents()
      }
    }
  }, [attachEvents, cleanupEvents, elementRef, handleContextMenuEvent, listener])
}
