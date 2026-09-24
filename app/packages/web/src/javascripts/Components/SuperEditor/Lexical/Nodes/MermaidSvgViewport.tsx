import { FunctionComponent, useCallback, useLayoutEffect, useRef, useState } from 'react'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import {
  fitTransform,
  MAX_IMAGE_SCALE,
  MIN_IMAGE_SCALE,
  panBy,
  touchDistance,
  wheelDeltaToFactor,
  zoomByFactor,
  zoomToPoint,
  ZoomTransform,
} from '@/Components/FilePreview/imageZoomTransform'

/**
 * Standard Red Notes — bug fix: rendered mermaid/gantt/timing diagrams did not
 * fit their container (a wide diagram just ran past the note's width, with
 * only a bare scrollbar to see the rest) and had no way to zoom or pan.
 *
 * This reuses the exact pan/zoom/fit MATH already shipped for the full-screen
 * image lightbox (`imageZoomTransform.ts`, driving `ZoomableImage.tsx` — see
 * `FileComponent.tsx` -> `FilePreview.tsx` -> `ImagePreview.tsx` for how that's
 * wired for images) rather than inventing a new interaction language: mouse
 * wheel zooms centred on the cursor, pointer-drag pans (touch included, since
 * Pointer Events unify mouse/touch/pen), two-finger pinch zooms on touch, and
 * +/- / percentage-reset / fit buttons mirror the lightbox's control row.
 *
 * The one addition ZoomableImage's full-screen viewer doesn't need: this is an
 * INLINE embed, so on mount (and on every new render / viewport resize, until
 * the user takes over by panning or zooming) it auto-fits to the container's
 * width and sizes itself to the diagram's fitted height, capped at
 * MAX_PREVIEW_HEIGHT so one huge diagram can't push the rest of the note off
 * screen — see `computeFitBoxHeight`.
 */

type Props = {
  /** Raw SVG markup produced by `mermaid.render()`. */
  svg: string
}

const ZOOM_BUTTON_FACTOR = 1.25
const DOUBLE_CLICK_ZOOM = 2

/** Ceiling on the inline preview's height; taller diagrams are fit to BOTH
 * dimensions instead (via fitTransform) so they stay fully visible and the
 * user can zoom in via the controls for detail. */
export const MAX_PREVIEW_HEIGHT = 480
export const MIN_PREVIEW_HEIGHT = 80

/**
 * Parse the natural (unscaled) pixel size of a rendered mermaid SVG from its
 * markup string. Mermaid's `configureSvgSize` (src/setupGraphViewbox.js)
 * stamps `width="100%"` plus a `max-width` style on the root <svg> for most
 * diagrams — so the raw `width`/`height` attributes are rarely a plain pixel
 * number — but every diagram type sets a `viewBox="0 0 W H"`, which is the
 * diagram's true unscaled size and the primary source here. The width/height
 * attributes are a fallback for a diagram type that only sets those.
 *
 * Returns null when neither is found/parseable, so the caller can fall back to
 * the pre-fix behaviour (render at intrinsic size, scrollable, no controls)
 * rather than guess and risk clipping the diagram.
 */
export function parseSvgNaturalSize(svgMarkup: string): { width: number; height: number } | null {
  const viewBoxMatch = svgMarkup.match(/\bviewBox=["']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)\s*["']/)
  if (viewBoxMatch) {
    const width = parseFloat(viewBoxMatch[1])
    const height = parseFloat(viewBoxMatch[2])
    if (width > 0 && height > 0) {
      return { width, height }
    }
  }
  const widthMatch = svgMarkup.match(/\bwidth=["']([\d.]+)(?:px)?["']/)
  const heightMatch = svgMarkup.match(/\bheight=["']([\d.]+)(?:px)?["']/)
  if (widthMatch && heightMatch) {
    const width = parseFloat(widthMatch[1])
    const height = parseFloat(heightMatch[1])
    if (width > 0 && height > 0) {
      return { width, height }
    }
  }
  return null
}

/**
 * The inline preview box's height: as tall as the diagram needs to be once
 * scaled to fit the viewport's width, capped at MAX_PREVIEW_HEIGHT.
 */
export function computeFitBoxHeight(viewportWidth: number, naturalWidth: number, naturalHeight: number): number {
  if (viewportWidth <= 0 || naturalWidth <= 0 || naturalHeight <= 0) {
    return MIN_PREVIEW_HEIGHT
  }
  const candidate = naturalHeight * (viewportWidth / naturalWidth)
  return Math.max(MIN_PREVIEW_HEIGHT, Math.min(candidate, MAX_PREVIEW_HEIGHT))
}

const MermaidSvgViewport: FunctionComponent<Props> = ({ svg }) => {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentHostRef = useRef<HTMLDivElement>(null)
  const naturalSize = useRef<{ width: number; height: number }>({ width: 0, height: 0 })

  const [transform, setTransform] = useState<ZoomTransform>({ scale: 1, offsetX: 0, offsetY: 0 })
  const [boxHeight, setBoxHeight] = useState(MIN_PREVIEW_HEIGHT)
  const [hasSize, setHasSize] = useState(false)
  const [isPanning, setIsPanning] = useState(false)

  const panState = useRef<{ pointerId: number; lastX: number; lastY: number } | null>(null)
  const pinchState = useRef<{ lastDistance: number } | null>(null)
  // Becomes true once the user pans/zooms, so auto-fit-on-resize/-on-reload stops.
  const hasInteracted = useRef(false)

  const viewportWidth = useCallback(() => viewportRef.current?.clientWidth ?? 0, [])
  const viewportHeight = useCallback(() => viewportRef.current?.clientHeight ?? 0, [])

  // Always resolves to a definite transform + box height (even the "can't
  // determine the diagram's size" case), so a state update — and re-render —
  // happens on every call. Without that, switching from a fittable diagram to
  // an unfittable one would leave the old (now stale) box height/transform on
  // screen after the SVG markup underneath had already changed.
  const fitToViewport = useCallback(() => {
    const vw = viewportWidth()
    const { width: nw, height: nh } = naturalSize.current
    if (nw <= 0 || nh <= 0 || vw <= 0) {
      setBoxHeight(MIN_PREVIEW_HEIGHT)
      setTransform({ scale: 1, offsetX: 0, offsetY: 0 })
      return
    }
    const vh = computeFitBoxHeight(vw, nw, nh)
    setBoxHeight(vh)
    setTransform(fitTransform(vw, vh, nw, nh))
  }, [viewportWidth])

  // Explicit "Fit" button: refit and resume auto-fit-on-resize.
  const fitAndResume = useCallback(() => {
    hasInteracted.current = false
    fitToViewport()
  }, [fitToViewport])

  // Insert the SVG markup imperatively (mirrors BlockZoomOverlay's DOM-clone
  // pattern) so we can measure its natural size and fit it synchronously,
  // before paint. Runs whenever the source markup changes (a new render from
  // the code/theme/reload).
  useLayoutEffect(() => {
    const host = contentHostRef.current
    if (!host) {
      return
    }
    host.innerHTML = svg
    const parsed = parseSvgNaturalSize(svg)
    naturalSize.current = parsed ?? { width: 0, height: 0 }
    setHasSize(parsed != null)
    hasInteracted.current = false
    fitToViewport()
    // fitToViewport is stable (memoized on viewportWidth, which never changes
    // identity); re-running only on `svg` is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg])

  // Re-fit on viewport resize while the user hasn't taken over the view. jsdom
  // (and older browsers) have no ResizeObserver — degrade to "no auto-refit on
  // resize" rather than throwing.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el || typeof ResizeObserver === 'undefined') {
      return
    }
    const observer = new ResizeObserver(() => {
      if (!hasInteracted.current) {
        fitToViewport()
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [fitToViewport])

  const localPoint = useCallback((clientX: number, clientY: number) => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }, [])

  // Wheel zoom centred on the cursor. Only wired once the diagram's size is
  // known (otherwise there is nothing meaningful to zoom); registered
  // non-passively so we can preventDefault and stop the note from scrolling
  // while zooming.
  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      if (naturalSize.current.width <= 0) {
        return
      }
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
      const vw = viewportWidth()
      const vh = viewportHeight()
      setTransform((current) => zoomByFactor(current, factor, vw / 2, vh / 2))
    },
    [viewportWidth, viewportHeight],
  )

  const resetToActualSize = useCallback(() => {
    hasInteracted.current = true
    const vw = viewportWidth()
    const vh = viewportHeight()
    const { width: nw, height: nh } = naturalSize.current
    setTransform({ scale: 1, offsetX: (vw - nw) / 2, offsetY: (vh - nh) / 2 })
  }, [viewportWidth, viewportHeight])

  const onDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (naturalSize.current.width <= 0) {
        return
      }
      hasInteracted.current = true
      const { x, y } = localPoint(event.clientX, event.clientY)
      setTransform((current) => {
        const vw = viewportWidth()
        const vh = viewportHeight()
        const { width: nw, height: nh } = naturalSize.current
        const fit = fitTransform(vw, vh, nw, nh)
        const isZoomed = current.scale > fit.scale + 0.01
        return isZoomed ? fit : zoomToPoint(current, DOUBLE_CLICK_ZOOM, x, y)
      })
    },
    [localPoint, viewportWidth, viewportHeight],
  )

  // --- Pointer-based panning (unifies mouse/touch/pen; the editor also runs on
  // touch devices, so drag-to-pan must not be a mouse-only handler). ---
  const onPointerDown = useCallback((event: React.PointerEvent) => {
    if (naturalSize.current.width <= 0) {
      return
    }
    if (event.button !== 0 && event.pointerType === 'mouse') {
      return
    }
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
  const onTouchStart = useCallback((event: React.TouchEvent) => {
    if (event.touches.length === 2) {
      hasInteracted.current = true
      panState.current = null
      setIsPanning(false)
      const [a, b] = [event.touches[0], event.touches[1]]
      pinchState.current = { lastDistance: touchDistance(a.clientX, a.clientY, b.clientX, b.clientY) }
    }
  }, [])

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
    <div className="group/mermaid-viewport relative" data-mermaid-viewport="true">
      <div
        ref={viewportRef}
        className="relative touch-none overflow-hidden select-none"
        style={{
          height: `${boxHeight}px`,
          overflow: hasSize ? 'hidden' : 'auto',
          cursor: hasSize ? (isPanning ? 'grabbing' : 'grab') : 'default',
        }}
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
        <div
          ref={contentHostRef}
          data-mermaid-svg-host="true"
          className="absolute top-0 left-0 origin-top-left"
          style={{
            transform: hasSize
              ? `translate(${transform.offsetX}px, ${transform.offsetY}px) scale(${transform.scale})`
              : 'none',
          }}
        />
      </div>

      {hasSize ? (
        <div
          className="border-border bg-default shadow-main invisible absolute right-2 bottom-2 flex items-center gap-1 rounded border border-solid px-1.5 py-1 group-focus-within/mermaid-viewport:visible group-hover/mermaid-viewport:visible"
          data-mermaid-viewport-controls="true"
        >
          <StyledTooltip label="Zoom out">
            <button
              type="button"
              className="hover:bg-contrast flex cursor-pointer rounded border-0 bg-transparent p-1 disabled:opacity-40"
              onClick={() => zoomAtCenter(1 / ZOOM_BUTTON_FACTOR)}
              disabled={transform.scale <= MIN_IMAGE_SCALE}
              aria-label="Zoom out"
            >
              <Icon type="subtract" className="text-neutral" size="small" />
            </button>
          </StyledTooltip>
          <button
            type="button"
            className="text-neutral hover:bg-contrast min-w-[3rem] rounded px-1 py-0.5 text-center text-xs"
            onClick={resetToActualSize}
            aria-label="Reset to actual size"
            title="Reset to 100%"
          >
            {percent}%
          </button>
          <StyledTooltip label="Zoom in">
            <button
              type="button"
              className="hover:bg-contrast flex cursor-pointer rounded border-0 bg-transparent p-1 disabled:opacity-40"
              onClick={() => zoomAtCenter(ZOOM_BUTTON_FACTOR)}
              disabled={transform.scale >= MAX_IMAGE_SCALE}
              aria-label="Zoom in"
            >
              <Icon type="add" className="text-neutral" size="small" />
            </button>
          </StyledTooltip>
          <div className="bg-border mx-0.5 h-4 w-px" />
          <StyledTooltip label="Fit to width">
            <button
              type="button"
              className="hover:bg-contrast flex cursor-pointer rounded border-0 bg-transparent p-1"
              onClick={fitAndResume}
              aria-label="Fit to width"
            >
              <Icon type="arrows-vertical" className="text-neutral rotate-45" size="small" />
            </button>
          </StyledTooltip>
        </div>
      ) : null}
    </div>
  )
}

export default MermaidSvgViewport
