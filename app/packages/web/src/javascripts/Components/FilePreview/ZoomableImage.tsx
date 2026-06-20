import { FunctionComponent, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '../StyledTooltip/StyledTooltip'
import {
  centerTransform,
  fitTransform,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  panBy,
  touchDistance,
  wheelDeltaToFactor,
  zoomByFactor,
  zoomToPoint,
  ZoomTransform,
} from './imageZoomTransform'

type Props = {
  objectUrl: string
}

const ZOOM_BUTTON_FACTOR = 1.25
const DOUBLE_CLICK_ZOOM = 2

/**
 * Full-screen image viewer with pan & zoom.
 *
 * - Mouse wheel zooms centred on the cursor.
 * - Drag pans the image (when it overflows the viewport).
 * - Double-click toggles between fit and a 2x zoom centred on the click.
 * - Two-finger pinch zooms on touch devices.
 * - +/- buttons, a Fit button and a 1:1 button mirror the PDF viewer's controls.
 */
const ZoomableImage: FunctionComponent<Props> = ({ objectUrl }) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const imageNaturalSize = useRef<{ width: number; height: number }>({ width: 0, height: 0 })

  const [transform, setTransform] = useState<ZoomTransform>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [isReady, setIsReady] = useState(false)
  const [isPanning, setIsPanning] = useState(false)

  // Pointer/touch gesture bookkeeping kept in refs so listeners stay stable.
  const panState = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const pinchState = useRef<{ lastDistance: number; centerX: number; centerY: number } | null>(null)
  // Becomes true once the user pans/zooms, so auto-fit-on-resize stops.
  const hasInteracted = useRef(false)

  const viewportSize = useCallback(() => {
    const el = viewportRef.current
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }, [])

  const fitToViewport = useCallback(() => {
    const { width: vw, height: vh } = viewportSize()
    const { width: iw, height: ih } = imageNaturalSize.current
    setTransform(fitTransform(vw, vh, iw, ih))
  }, [viewportSize])

  // Explicit "Fit" button: refit and resume auto-fit-on-resize.
  const fitAndResume = useCallback(() => {
    hasInteracted.current = false
    fitToViewport()
  }, [fitToViewport])

  const resetToActualSize = useCallback(() => {
    hasInteracted.current = true
    const { width: vw, height: vh } = viewportSize()
    const { width: iw, height: ih } = imageNaturalSize.current
    setTransform(centerTransform(vw, vh, iw, ih, 1))
  }, [viewportSize])

  // Load natural dimensions, then fit the image into the viewport.
  useEffect(() => {
    setIsReady(false)
    const image = new Image()
    image.src = objectUrl
    image.onload = () => {
      imageNaturalSize.current = { width: image.width, height: image.height }
      fitToViewport()
      setIsReady(true)
    }
  }, [objectUrl, fitToViewport])

  // Re-fit only while the user hasn't interacted yet, so that opening the modal
  // (which lays out / animates the viewport size) lands on a correct fit. Once
  // the user pans/zooms we leave their view alone on subsequent resizes.
  useLayoutEffect(() => {
    if (!isReady) {
      return
    }
    const el = viewportRef.current
    if (!el) {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!hasInteracted.current) {
        fitToViewport()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
    // We intentionally only re-create the observer when readiness flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady])

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }, [])

  // Wheel zoom centred on the cursor. Registered non-passively so we can
  // preventDefault and stop the modal/page from scrolling.
  useEffect(() => {
    const el = viewportRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      hasInteracted.current = true
      const { x, y } = localPoint(event.clientX, event.clientY)
      const factor = wheelDeltaToFactor(event.deltaY)
      setTransform((current) => zoomByFactor(current, factor, x, y))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [localPoint])

  const zoomAtCenter = useCallback(
    (factor: number) => {
      hasInteracted.current = true
      const { width: vw, height: vh } = viewportSize()
      setTransform((current) => zoomByFactor(current, factor, vw / 2, vh / 2))
    },
    [viewportSize],
  )

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      hasInteracted.current = true
      const { x, y } = localPoint(event.clientX, event.clientY)
      setTransform((current) => {
        // If already zoomed in past fit, double-click returns to fit; otherwise
        // zoom to 2x centred on the clicked point.
        const { width: vw, height: vh } = viewportSize()
        const { width: iw, height: ih } = imageNaturalSize.current
        const fit = fitTransform(vw, vh, iw, ih)
        const isZoomed = current.scale > fit.scale + 0.01
        if (isZoomed) {
          return fit
        }
        return zoomToPoint(current, DOUBLE_CLICK_ZOOM, x, y)
      })
    },
    [localPoint, viewportSize],
  )

  // --- Pointer-based panning ---
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return
    }
    // Pinch is handled separately via touch events.
    if (event.pointerType === 'touch' && pinchState.current) {
      return
    }
    ;(event.target as Element).setPointerCapture?.(event.pointerId)
    panState.current = { pointerId: event.pointerId, lastX: event.clientX, lastY: event.clientY }
    hasInteracted.current = true
    setIsPanning(true)
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent) => {
    const state = panState.current
    if (!state || state.pointerId !== event.pointerId || pinchState.current) {
      return
    }
    const deltaX = event.clientX - state.lastX
    const deltaY = event.clientY - state.lastY
    state.lastX = event.clientX
    state.lastY = event.clientY
    setTransform((current) => panBy(current, deltaX, deltaY))
  }, [])

  const endPan = useCallback((event: React.PointerEvent) => {
    if (panState.current?.pointerId === event.pointerId) {
      panState.current = null
      setIsPanning(false)
    }
  }, [])

  // --- Touch pinch-to-zoom ---
  const onTouchStart = useCallback(
    (event: React.TouchEvent) => {
      if (event.touches.length === 2) {
        // Two fingers: start a pinch and cancel any single-finger pan.
        hasInteracted.current = true
        panState.current = null
        setIsPanning(false)
        const [a, b] = [event.touches[0], event.touches[1]]
        const center = localPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
        pinchState.current = {
          lastDistance: touchDistance(a.clientX, a.clientY, b.clientX, b.clientY),
          centerX: center.x,
          centerY: center.y,
        }
      }
    },
    [localPoint],
  )

  const onTouchMove = useCallback(
    (event: React.TouchEvent) => {
      const pinch = pinchState.current
      if (pinch && event.touches.length === 2) {
        event.preventDefault()
        const [a, b] = [event.touches[0], event.touches[1]]
        const distance = touchDistance(a.clientX, a.clientY, b.clientX, b.clientY)
        const center = localPoint((a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2)
        if (pinch.lastDistance > 0) {
          const factor = distance / pinch.lastDistance
          setTransform((current) => zoomByFactor(current, factor, center.x, center.y))
        }
        pinch.lastDistance = distance
        pinch.centerX = center.x
        pinch.centerY = center.y
      }
    },
    [localPoint],
  )

  const onTouchEnd = useCallback((event: React.TouchEvent) => {
    if (event.touches.length < 2) {
      pinchState.current = null
    }
  }, [])

  const percent = Math.round(transform.scale * 100)

  return (
    <div className="relative flex h-full w-full flex-col">
      <div
        ref={viewportRef}
        className="relative flex-grow touch-none select-none overflow-hidden bg-passive-5"
        style={{ cursor: isPanning ? 'grabbing' : 'grab' }}
        onDoubleClick={onDoubleClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onPointerLeave={endPan}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {isReady && (
          <img
            src={objectUrl}
            alt=""
            draggable={false}
            className="absolute left-0 top-0 max-w-none origin-top-left"
            style={{
              width: `${imageNaturalSize.current.width}px`,
              height: `${imageNaturalSize.current.height}px`,
              transform: `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`,
            }}
          />
        )}
      </div>

      {/* Controls */}
      <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded border border-solid border-border bg-default px-2 py-1 shadow-main">
        <StyledTooltip label="Zoom out" className="!z-modal">
          <button
            className="pointer-events-auto flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
            onClick={() => zoomAtCenter(1 / ZOOM_BUTTON_FACTOR)}
            disabled={transform.scale <= MIN_IMAGE_SCALE}
            aria-label="Zoom out"
          >
            <Icon type="subtract" className="text-neutral" />
          </button>
        </StyledTooltip>
        <button
          className="pointer-events-auto min-w-[3.5rem] rounded px-1.5 py-1 text-center text-sm text-neutral hover:bg-contrast"
          onClick={resetToActualSize}
          aria-label="Reset to actual size"
          title="Reset to 100%"
        >
          {percent}%
        </button>
        <StyledTooltip label="Zoom in" className="!z-modal">
          <button
            className="pointer-events-auto flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast disabled:opacity-40"
            onClick={() => zoomAtCenter(ZOOM_BUTTON_FACTOR)}
            disabled={transform.scale >= MAX_IMAGE_SCALE}
            aria-label="Zoom in"
          >
            <Icon type="add" className="text-neutral" />
          </button>
        </StyledTooltip>
        <div className="mx-1 h-5 w-px bg-border" />
        <StyledTooltip label="Fit to screen" className="!z-modal">
          <button
            className="pointer-events-auto flex cursor-pointer rounded border-0 bg-transparent p-1.5 hover:bg-contrast"
            onClick={fitAndResume}
            aria-label="Fit to screen"
          >
            <Icon type="arrows-vertical" className="rotate-45 text-neutral" />
          </button>
        </StyledTooltip>
      </div>
    </div>
  )
}

export default ZoomableImage
