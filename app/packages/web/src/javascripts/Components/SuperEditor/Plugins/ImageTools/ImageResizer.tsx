import { useCallback, useRef } from 'react'
import { clampImageWidth, getEditorContentWidth, MinImageWidth } from './ImageToolsTypes'

type Corner = 'nw' | 'ne' | 'sw' | 'se'

type Props = {
  /** Whether the handles should be shown (image is selected). */
  active: boolean
  /** The element wrapping the image whose width is being resized. */
  targetRef: React.RefObject<HTMLElement | null>
  /** Called continuously during a drag with the live width (for visual feedback). */
  onResize: (width: number) => void
  /** Called once on drag end with the final, clamped width to persist. */
  onResizeEnd: (width: number) => void
}

const Corners: { corner: Corner; className: string; cursor: string }[] = [
  { corner: 'nw', className: 'left-0 top-0 -translate-x-1/2 -translate-y-1/2', cursor: 'nwse-resize' },
  { corner: 'ne', className: 'right-0 top-0 translate-x-1/2 -translate-y-1/2', cursor: 'nesw-resize' },
  { corner: 'sw', className: 'bottom-0 left-0 -translate-x-1/2 translate-y-1/2', cursor: 'nesw-resize' },
  { corner: 'se', className: 'bottom-0 right-0 translate-x-1/2 translate-y-1/2', cursor: 'nwse-resize' },
]

/**
 * Renders four corner drag handles over a selected image. Dragging a handle
 * resizes the image by width while preserving aspect ratio (height follows via
 * CSS aspect-ratio / natural ratio of the <img>). The width is clamped to the
 * editor content column so the image can never overflow horizontally.
 *
 * Works with both mouse and touch (pointer events) so it's usable on the
 * mobile-responsive editor.
 */
export default function ImageResizer({ active, targetRef, onResize, onResizeEnd }: Props) {
  const dragState = useRef<{
    startX: number
    startWidth: number
    direction: number
    maxWidth: number
  } | null>(null)

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const state = dragState.current
      if (!state) {
        return
      }
      const delta = (event.clientX - state.startX) * state.direction
      const next = clampImageWidth(state.startWidth + delta, state.maxWidth)
      onResize(next)
    },
    [onResize],
  )

  const handlePointerUp = useCallback(
    (event: PointerEvent) => {
      const state = dragState.current
      if (!state) {
        return
      }
      const delta = (event.clientX - state.startX) * state.direction
      const next = clampImageWidth(state.startWidth + delta, state.maxWidth)
      dragState.current = null
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      onResizeEnd(next)
    },
    [handlePointerMove, onResizeEnd],
  )

  const beginDrag = useCallback(
    (corner: Corner) => (event: React.PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const target = targetRef.current
      if (!target) {
        return
      }
      const rect = target.getBoundingClientRect()
      // Dragging the east (right) handles grows with +x; west (left) handles grow with -x.
      const direction = corner === 'ne' || corner === 'se' ? 1 : -1
      dragState.current = {
        startX: event.clientX,
        startWidth: Math.max(rect.width, MinImageWidth),
        direction,
        maxWidth: getEditorContentWidth(),
      }
      window.addEventListener('pointermove', handlePointerMove)
      window.addEventListener('pointerup', handlePointerUp)
      window.addEventListener('pointercancel', handlePointerUp)
    },
    [handlePointerMove, handlePointerUp, targetRef],
  )

  if (!active) {
    return null
  }

  return (
    <>
      {Corners.map(({ corner, className, cursor }) => (
        <span
          key={corner}
          role="presentation"
          aria-label={`Resize image (${corner})`}
          className={`absolute z-20 h-3.5 w-3.5 rounded-full border-2 border-info bg-default ${className}`}
          style={{ cursor, touchAction: 'none' }}
          onPointerDown={beginDrag(corner)}
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
          }}
        />
      ))}
    </>
  )
}
