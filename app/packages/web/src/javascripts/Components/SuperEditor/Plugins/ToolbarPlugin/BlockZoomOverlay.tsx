/**
 * Standard Red Notes — Feature #287: zoom into a single block.
 *
 * A focus mode that isolates one top-level block (table, diagram, image, or any
 * block) enlarged in a full-screen overlay for focused viewing, with a clear
 * way to zoom back out (an explicit "Zoom out" button + Escape).
 *
 * Implementation notes / tradeoffs:
 *  - Overlay (not in-place CSS transform on the live editor): isolating the
 *    block by transforming it inside the scrolling ContentEditable fights the
 *    editor's own layout/caret math and bleeds into sibling blocks. A separate
 *    fixed overlay cleanly hides everything else and lets us scale freely.
 *  - READ-ONLY while zoomed: we render a *clone* of the block's live DOM rather
 *    than re-parenting the real editor node. Re-parenting the real Lexical DOM
 *    would desync the editor's reconciler (it owns those elements) and is unsafe
 *    for complex decorator blocks (kanban, timeline, excalidraw, …). A static,
 *    enlarged snapshot is the safe, predictable focus view; the user zooms out
 *    to edit. This is intentional and called out in the report.
 *  - The clone is kept in sync: while open we observe asynchronous decorator DOM rendering as well as editor updates so
 *    edits made before zooming (or via undo/redo keyboard) stay reflected.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Icon from '@/Components/Icon/Icon'
import StyledTooltip from '@/Components/StyledTooltip/StyledTooltip'
import { classNames } from '@standardnotes/snjs'

export type BlockZoomOverlayProps = {
  /** Lexical node key of the top-level block to isolate, or null when closed. */
  blockKey: string | null
  /** Friendly label for the block kind (e.g. "Table", "Math"). */
  label: string
  onClose: () => void
  /** Where the overlay portal mounts (the Super editor root). */
  portalElement: HTMLElement
}

const ZOOM_STEPS = [1, 1.25, 1.5, 2, 2.5, 3]

export default function BlockZoomOverlay({ blockKey, label, onClose, portalElement }: BlockZoomOverlayProps) {
  const [editor] = useLexicalComposerContext()
  const cloneHostRef = useRef<HTMLDivElement>(null)
  // Default to the 1.5x step (index 2 in ZOOM_STEPS).
  const [zoomIndex, setZoomIndex] = useState(2)
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    if (!blockKey) {
      return
    }
    let frame: number | undefined
    let observed: HTMLElement | null = null
    let disposed = false
    const schedule = () => {
      if (!disposed && frame === undefined) {
        frame = requestAnimationFrame(refresh)
      }
    }
    const mutations = new MutationObserver(schedule)
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
    const refresh = () => {
      frame = undefined
      if (disposed) {
        return
      }
      const host = cloneHostRef.current
      if (!host) {
        return
      }
      const live = editor.getElementByKey(blockKey)
      if (live !== observed) {
        mutations.disconnect()
        resize?.disconnect()
        observed = live
        if (live) {
          mutations.observe(live, { subtree: true, childList: true, characterData: true, attributes: true })
          resize?.observe(live)
        }
      }
      host.replaceChildren()
      setMissing(!live)
      if (!live) {
        return
      }
      // Absolute-positioned diagram canvases have no intrinsic width. Give the
      // snapshot the live block's layout width instead of shrinking it to zero.
      const width = live.offsetWidth || live.getBoundingClientRect().width
      host.style.width = width > 0 ? `${width}px` : '100%'
      const clone = live.cloneNode(true) as HTMLElement
      clone.removeAttribute('contenteditable')
      clone.querySelectorAll('[contenteditable]').forEach((element) => element.removeAttribute('contenteditable'))
      clone.style.margin = '0'
      clone.style.width = '100%'
      host.appendChild(clone)
    }
    refresh()
    const unregister = editor.registerUpdateListener(schedule)
    return () => {
      disposed = true
      unregister()
      mutations.disconnect()
      resize?.disconnect()
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
    }
  }, [editor, blockKey])

  // Escape closes; +/- adjust zoom.
  useEffect(() => {
    if (!blockKey) {
      return
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        onClose()
      } else if (event.key === '+' || event.key === '=') {
        setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))
      } else if (event.key === '-' || event.key === '_') {
        setZoomIndex((i) => Math.max(0, i - 1))
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [blockKey, onClose])

  if (!blockKey) {
    return null
  }

  const zoom = ZOOM_STEPS[zoomIndex]

  return createPortal(
    <div
      className="z-modal bg-default absolute inset-0 flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={`Zoomed ${label}`}
    >
      <div className="border-border flex flex-shrink-0 items-center gap-2 border-b px-3 py-2">
        <Icon type="fullscreen" className="text-info" />
        <span className="text-sm font-semibold">Focused: {label}</span>
        <div className="ml-auto flex items-center gap-1">
          <StyledTooltip label="Zoom out (-)">
            <button
              className="hover:bg-contrast flex h-7 w-7 items-center justify-center rounded text-lg leading-none font-semibold disabled:opacity-50"
              onClick={() => setZoomIndex((i) => Math.max(0, i - 1))}
              disabled={zoomIndex === 0}
              aria-label="Decrease zoom"
            >
              &minus;
            </button>
          </StyledTooltip>
          <span className="w-12 text-center text-sm tabular-nums">{Math.round(zoom * 100)}%</span>
          <StyledTooltip label="Zoom in (+)">
            <button
              className="hover:bg-contrast flex h-7 w-7 items-center justify-center rounded disabled:opacity-50"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              aria-label="Increase zoom"
            >
              <Icon type="add" />
            </button>
          </StyledTooltip>
          <div className="bg-border mx-1 h-6 w-px" />
          <StyledTooltip label="Exit focus (Esc)">
            <button
              className="hover:bg-contrast flex items-center gap-1.5 rounded px-2 py-1.5 text-sm"
              onClick={onClose}
              aria-label="Zoom out of block"
            >
              <Icon type="close" />
              Zoom out
            </button>
          </StyledTooltip>
        </div>
      </div>
      <div className="flex-grow overflow-auto p-8">
        {missing ? (
          <div className="text-passive-0 flex h-full items-center justify-center">
            This block is no longer available.
          </div>
        ) : null}
        <div className={classNames('min-h-full items-start justify-center', missing ? 'hidden' : 'flex')}>
          <div
            ref={cloneHostRef}
            className={classNames('shrink-0 origin-top', 'super-block-zoom-clone')}
            style={{ transform: `scale(${zoom})` }}
          />
        </div>
      </div>
    </div>,
    portalElement,
  )
}
