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
 *  - The clone is kept in sync: while open we re-clone on each editor update so
 *    edits made before zooming (or via undo/redo keyboard) stay reflected.
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useCallback, useEffect, useRef, useState } from 'react'
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

  const syncClone = useCallback(() => {
    const host = cloneHostRef.current
    if (!host || !blockKey) {
      return
    }
    const liveElement = editor.getElementByKey(blockKey)
    host.replaceChildren()
    if (!liveElement) {
      setMissing(true)
      return
    }
    setMissing(false)
    const clone = liveElement.cloneNode(true) as HTMLElement
    // Neutralize editability on the static snapshot so it reads as view-only.
    clone.removeAttribute('contenteditable')
    clone.querySelectorAll('[contenteditable]').forEach((el) => el.removeAttribute('contenteditable'))
    clone.style.margin = '0'
    host.appendChild(clone)
  }, [editor, blockKey])

  // Re-clone when opening and on every editor update while open, so the snapshot
  // stays current with the underlying block.
  useEffect(() => {
    if (!blockKey) {
      return
    }
    editor.getEditorState().read(syncClone)
    return editor.registerUpdateListener(() => {
      editor.getEditorState().read(syncClone)
    })
  }, [editor, blockKey, syncClone])

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
      className="absolute inset-0 z-modal flex flex-col bg-default"
      role="dialog"
      aria-modal="true"
      aria-label={`Zoomed ${label}`}
    >
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <Icon type="fullscreen" className="text-info" />
        <span className="text-sm font-semibold">Focused: {label}</span>
        <div className="ml-auto flex items-center gap-1">
          <StyledTooltip label="Zoom out (-)">
            <button
              className="flex h-7 w-7 items-center justify-center rounded text-lg font-semibold leading-none hover:bg-contrast disabled:opacity-50"
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
              className="flex h-7 w-7 items-center justify-center rounded hover:bg-contrast disabled:opacity-50"
              onClick={() => setZoomIndex((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
              disabled={zoomIndex === ZOOM_STEPS.length - 1}
              aria-label="Increase zoom"
            >
              <Icon type="add" />
            </button>
          </StyledTooltip>
          <div className="mx-1 h-6 w-px bg-border" />
          <StyledTooltip label="Exit focus (Esc)">
            <button
              className="flex items-center gap-1.5 rounded px-2 py-1.5 text-sm hover:bg-contrast"
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
          <div className="flex h-full items-center justify-center text-passive-0">
            This block is no longer available.
          </div>
        ) : (
          <div className="flex min-h-full items-start justify-center">
            <div
              ref={cloneHostRef}
              className={classNames('origin-top', 'super-block-zoom-clone')}
              style={{ transform: `scale(${zoom})` }}
            />
          </div>
        )}
      </div>
    </div>,
    portalElement,
  )
}
