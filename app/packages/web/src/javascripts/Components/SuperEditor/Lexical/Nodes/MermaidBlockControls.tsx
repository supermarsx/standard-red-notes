import * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  formatMermaidWidth,
  MAX_MERMAID_HEIGHT_PX,
  MAX_MERMAID_WIDTH_PX,
  MIN_MERMAID_HEIGHT_PX,
  MIN_MERMAID_WIDTH_PX,
  MermaidWidthUnit,
  normalizeMermaidHeight,
  parseMermaidWidth,
  widthFromDrag,
} from './MermaidWidth'

/**
 * Standard Red Notes — the Mermaid diagram block's size controls.
 *
 * SELECTION-GATED, mirroring the table's own selected-only control:
 * `Plugins/TableCellActionMenuPlugin/index.tsx` renders its chevron + action
 * menu only while a table cell is the current Lexical selection
 * (`index.tsx:448-493` reads `$getSelection()` inside an update listener;
 * `index.tsx:551-579` renders nothing at all when it resolves to no cell). The
 * decorator-node spelling of that same rule in this editor is
 * `useLexicalNodeSelection` + `CLICK_COMMAND`
 * (`Plugins/RemoteImagePlugin/RemoteImageComponent.tsx:109-130`), with the
 * resulting flag gating visibility exactly as
 * `Plugins/ImageTools/SuperEmbeddedImage.tsx:122-132` gates the image resizer
 * and toolbar. MermaidNode uses that, and passes the result here as `visible`.
 *
 * FOCUS: every button carries `onMouseDown={e => e.preventDefault()}`, the
 * guard `Plugins/ImageTools/ImageToolbar.tsx:70,101,116,137` uses to keep the
 * caret in the editor when a control is clicked. The width FIELD deliberately
 * does not — a text input that refuses focus cannot be typed into — so the
 * guard sits on the buttons only, and the section stops click propagation so a
 * click inside it never re-enters Lexical's own click handling.
 */

const PRESETS: { label: string; value: string }[] = [
  { label: '25%', value: '25%' },
  { label: '50%', value: '50%' },
  { label: '75%', value: '75%' },
  { label: '100%', value: '100%' },
]

export type MermaidWidthSectionProps = {
  /** Whether the block is the current selection. Nothing renders when false. */
  visible: boolean
  /** The node's stored width — already normalized, or undefined for "fit". */
  width: string | undefined
  onWidthChange: (next: string | undefined) => void
  /** The node's stored preview height (px), or undefined for "auto-fit". */
  height: number | undefined
  onHeightChange: (next: number | undefined) => void
}

/**
 * The width/size section of the diagram block. Accepts `50%`, `420px` or a
 * bare `420` (pixels — see MermaidWidth.ts). An unparseable entry is reported
 * on the field and NEVER applied: the block keeps the last good width rather
 * than being handed a string nothing validated.
 */
export function MermaidWidthSection({
  visible,
  width,
  onWidthChange,
  height,
  onHeightChange,
}: MermaidWidthSectionProps): React.JSX.Element | null {
  const [draft, setDraft] = useState(width ?? '')
  const [invalid, setInvalid] = useState(false)

  // Follow the node when the width changes from the outside (undo/redo, a
  // drag on the handle, a collaborative edit).
  useEffect(() => {
    setDraft(width ?? '')
    setInvalid(false)
  }, [width])

  const commit = useCallback(
    (raw: string) => {
      if (raw.trim() === '') {
        setInvalid(false)
        onWidthChange(undefined)
        return
      }
      const parsed = parseMermaidWidth(raw)
      if (!parsed) {
        // Unparseable: say so, keep the text visible so it can be corrected,
        // and leave the applied width alone.
        setInvalid(true)
        return
      }
      setInvalid(false)
      const normalized = formatMermaidWidth(parsed)
      setDraft(normalized ?? '')
      onWidthChange(normalized)
    },
    [onWidthChange],
  )

  if (!visible) {
    return null
  }

  const fieldClass =
    'w-20 rounded border bg-default px-1.5 py-0.5 text-foreground outline-none focus:border-info ' +
    (invalid ? 'border-danger' : 'border-border')

  return (
    <div
      className="border-border text-passive-1 flex flex-wrap items-center gap-2 border-t px-2 py-1 text-xs"
      data-mermaid-width-section="true"
      data-srn-print-exclude="true"
      onClick={(event) => event.stopPropagation()}
    >
      <span className="font-semibold">Width</span>
      <input
        className={fieldClass}
        value={draft}
        spellCheck={false}
        placeholder="Fit"
        aria-label="Diagram width"
        aria-invalid={invalid}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit((event.target as HTMLInputElement).value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(width ?? '')
            setInvalid(false)
          }
        }}
      />
      {invalid ? (
        <span className="text-danger" role="alert">
          Use a percentage or pixels, e.g. 50% or 420px.
        </span>
      ) : (
        <span className="text-passive-2">% or px — empty fits the container</span>
      )}

      <div className="border-border flex overflow-hidden rounded border" role="group" aria-label="Width presets">
        {PRESETS.map((preset) => (
          <button
            key={preset.value}
            type="button"
            className={'px-1.5 py-0.5 ' + (width === preset.value ? 'bg-info text-info-contrast' : 'hover:bg-contrast')}
            aria-pressed={width === preset.value}
            onClick={() => onWidthChange(preset.value)}
            onMouseDown={(event) => event.preventDefault()}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <button
        type="button"
        className="border-border hover:bg-contrast rounded border px-1.5 py-0.5 disabled:opacity-50"
        onClick={() => {
          onWidthChange(undefined)
          onHeightChange(undefined)
        }}
        onMouseDown={(event) => event.preventDefault()}
        disabled={width === undefined && height === undefined}
        title="Clear the stored size and fit the container again"
      >
        Fit to container
      </button>

      {height !== undefined ? <span className="text-passive-2">Height {height}px</span> : null}
    </div>
  )
}

export type MermaidResizeHandleProps = {
  /** Whether the block is the current selection. Nothing renders when false. */
  active: boolean
  /** The block element whose WIDTH is resized (and persisted as `width`). */
  widthTargetRef: React.RefObject<HTMLElement | null>
  /** The preview box whose HEIGHT is resized (and persisted as `height`). */
  heightTargetRef: React.RefObject<HTMLElement | null>
  /** Unit the block is currently sized in, so a `%` block stays responsive. */
  unit: MermaidWidthUnit
  /** Called once on drag end with the values to persist. */
  onResizeEnd: (width: string | undefined, height: number | undefined) => void
}

const clampPx = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** How far up the tree to look for a measurable container. */
const CONTAINER_SEARCH_DEPTH = 6

/**
 * The width a percentage should be measured against: the nearest ancestor that
 * actually has a box.
 *
 * The immediate parent is NOT usable. A Lexical decorator's own wrapper is
 * `display: contents` (MermaidNode.createDOM), and a `display: contents`
 * element generates no box at all, so `getBoundingClientRect()` on it returns
 * zero — which would quietly turn every percentage drag into a pixel one.
 * Exported so the arithmetic is testable without a layout engine.
 */
export function measureContainerWidth(element: HTMLElement | null, fallback: number): number {
  let candidate = element?.parentElement ?? null
  for (let depth = 0; candidate && depth < CONTAINER_SEARCH_DEPTH; depth++) {
    const width = candidate.getBoundingClientRect().width
    if (width > 0) {
      return width
    }
    candidate = candidate.parentElement
  }
  return fallback
}

/**
 * A bottom-right corner drag handle that resizes the diagram block: the block's
 * width and the preview box's height. Those are the two values the node
 * persists, so the drag and the width field write the same state.
 *
 * Mirrors `Plugins/ImageTools/ImageResizer.tsx` — pointer events (so it works
 * on touch), window-level listeners for the duration of the drag, the live size
 * written straight to the elements for feedback and the final clamped value
 * committed once on pointerup — with one difference: an image's height follows
 * its aspect ratio, while this box's height is independent, so the handle drags
 * both axes.
 */
export function MermaidResizeHandle({
  active,
  widthTargetRef,
  heightTargetRef,
  unit,
  onResizeEnd,
}: MermaidResizeHandleProps): React.JSX.Element | null {
  const drag = useRef<{
    startX: number
    startY: number
    startWidth: number
    startHeight: number
    containerWidth: number
  } | null>(null)

  const sizeAt = (state: NonNullable<typeof drag.current>, event: PointerEvent) => ({
    width: clampPx(state.startWidth + (event.clientX - state.startX), MIN_MERMAID_WIDTH_PX, MAX_MERMAID_WIDTH_PX),
    height: clampPx(state.startHeight + (event.clientY - state.startY), MIN_MERMAID_HEIGHT_PX, MAX_MERMAID_HEIGHT_PX),
  })

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const state = drag.current
      if (!state) {
        return
      }
      const { width, height } = sizeAt(state, event)
      if (widthTargetRef.current) {
        widthTargetRef.current.style.width = `${Math.round(width)}px`
      }
      if (heightTargetRef.current) {
        heightTargetRef.current.style.height = `${Math.round(height)}px`
      }
    },
    [widthTargetRef, heightTargetRef],
  )

  const onPointerUp = useCallback(
    (event: PointerEvent) => {
      const state = drag.current
      if (!state) {
        return
      }
      drag.current = null
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)

      const { width, height } = sizeAt(state, event)
      const committedWidth = widthFromDrag(width, state.containerWidth, unit)

      // Land the live inline styles on exactly what is being persisted, rather
      // than clearing them: if the drag ends on the width the node already had,
      // React's next render is a no-op and a cleared style.width would leave the
      // block at its CSS default while the node still said otherwise.
      if (widthTargetRef.current) {
        widthTargetRef.current.style.width = committedWidth ?? ''
      }
      // The height, by contrast, is owned by the viewport's own box (via
      // `heightOverride`), so this wrapper's live height must be given back.
      if (heightTargetRef.current) {
        heightTargetRef.current.style.height = ''
      }

      onResizeEnd(committedWidth, normalizeMermaidHeight(height))
    },
    [onPointerMove, onResizeEnd, widthTargetRef, heightTargetRef, unit],
  )

  const beginDrag = useCallback(
    (event: React.PointerEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const widthTarget = widthTargetRef.current
      if (!widthTarget) {
        return
      }
      const widthRect = widthTarget.getBoundingClientRect()
      const heightRect = heightTargetRef.current?.getBoundingClientRect()
      drag.current = {
        startX: event.clientX,
        startY: event.clientY,
        startWidth: Math.max(widthRect.width, MIN_MERMAID_WIDTH_PX),
        startHeight: Math.max(heightRect?.height ?? MIN_MERMAID_HEIGHT_PX, MIN_MERMAID_HEIGHT_PX),
        containerWidth: measureContainerWidth(widthTarget, widthRect.width),
      }
      window.addEventListener('pointermove', onPointerMove)
      window.addEventListener('pointerup', onPointerUp)
      window.addEventListener('pointercancel', onPointerUp)
    },
    [onPointerMove, onPointerUp, widthTargetRef, heightTargetRef],
  )

  if (!active) {
    return null
  }

  return (
    <span
      role="presentation"
      aria-label="Resize diagram"
      data-mermaid-resize-handle="true"
      data-srn-print-exclude="true"
      className="border-info bg-default absolute -right-1 -bottom-1 z-20 h-3.5 w-3.5 rounded-full border-2"
      style={{ cursor: 'nwse-resize', touchAction: 'none' }}
      onPointerDown={beginDrag}
      onClick={(event) => {
        event.preventDefault()
        event.stopPropagation()
      }}
    />
  )
}
