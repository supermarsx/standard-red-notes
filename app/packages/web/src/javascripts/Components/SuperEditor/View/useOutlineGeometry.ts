import { PointerEvent, useEffect, useRef, useState } from 'react'
import { EditorViewPreferences } from '@/View/editorViewPreferences'

export function useOutlineGeometry(
  value: EditorViewPreferences,
  update: (patch: Partial<EditorViewPreferences>) => void,
) {
  const panel = useRef<HTMLElement>(null)
  const [geometry, setGeometry] = useState(() => ({
    tocX: value.tocX,
    tocY: value.tocY,
    tocWidth: value.tocWidth,
    tocHeight: value.tocHeight,
  }))
  const gesture = useRef<{ id: number; x: number; y: number; start: typeof geometry; resizing: boolean } | null>(null)
  const latest = useRef(geometry)
  const set = (next: typeof geometry) => {
    latest.current = next
    setGeometry(next)
  }
  useEffect(() => {
    if (!gesture.current) {
      const next = { tocX: value.tocX, tocY: value.tocY, tocWidth: value.tocWidth, tocHeight: value.tocHeight }
      latest.current = next
      setGeometry(next)
    }
  }, [value.tocX, value.tocY, value.tocWidth, value.tocHeight])
  const down = (resizing: boolean) => (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (!resizing && (event.target as Element).closest('button, select'))) {
      return
    }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, start: latest.current, resizing }
  }
  const move = (event: PointerEvent<HTMLElement>) => {
    const active = gesture.current
    if (!active || active.id !== event.pointerId) {
      return
    }
    const parent = panel.current?.parentElement
    const width = parent?.clientWidth || window.innerWidth
    const height = parent?.clientHeight || window.innerHeight
    const dx = event.clientX - active.x,
      dy = event.clientY - active.y
    const next = active.resizing
      ? {
          ...active.start,
          tocWidth: Math.min(Math.max(200, width - active.start.tocX), 600, Math.max(200, active.start.tocWidth + dx)),
          tocHeight: Math.min(
            Math.max(160, height - active.start.tocY),
            900,
            Math.max(160, active.start.tocHeight + dy),
          ),
        }
      : {
          ...active.start,
          tocX: Math.max(0, Math.min(width - Math.min(active.start.tocWidth, width), active.start.tocX + dx)),
          tocY: Math.max(0, Math.min(height - 48, active.start.tocY + dy)),
        }
    set(next)
  }
  const end = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current?.id !== event.pointerId) {
      return
    }
    gesture.current = null
    update(latest.current)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }
  const cancel = () => {
    const active = gesture.current
    gesture.current = null
    if (active) {
      set(active.start)
    }
  }
  return {
    panel,
    geometry,
    drag: down(false),
    resize: down(true),
    pointer: { onPointerMove: move, onPointerUp: end, onPointerCancel: cancel, onLostPointerCapture: cancel },
  }
}
