import { ReactNode, useEffect, useRef, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { loadNoteLayout, NOTE_LAYOUT_SETTINGS_CHANGED_EVENT } from '../../Layout/layoutSettings'
import { collectVisualLines, minimapScrollTarget, visibleLineStart, VisualLine } from './geometry'
import './EditorNavigationAids.scss'

type Snapshot = {
  lines: VisualLine[]
  contentHeight: number
  width: number
  viewportTop: number
  viewportHeight: number
  trackHeight: number
}
const EMPTY: Snapshot = { lines: [], contentHeight: 1, width: 1, viewportTop: 0, viewportHeight: 0, trackHeight: 0 }

/** A screen-only view of the existing editor DOM, with no cloned editor or document writes. */
export function EditorNavigationAids({ noteUuid, children }: { noteUuid?: string; children: ReactNode }) {
  const [editor] = useLexicalComposerContext()
  const [layout, setLayout] = useState(() => loadNoteLayout(noteUuid))
  const [snapshot, setSnapshot] = useState<Snapshot>(EMPTY)
  const shell = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const scroll = useRef<(top: number) => void>(() => undefined)
  const enabled = layout.lineNumbers || layout.minimap
  useEffect(() => {
    const reload = () => setLayout(loadNoteLayout(noteUuid))
    reload()
    window.addEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener(NOTE_LAYOUT_SETTINGS_CHANGED_EVENT, reload)
      window.removeEventListener('storage', reload)
    }
  }, [noteUuid])
  useEffect(() => {
    if (!enabled) {
      return
    }
    let disposeRoot = () => undefined as void
    const unregister = editor.registerRootListener((root) => {
      disposeRoot()
      if (!root || !shell.current) {
        return
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      let frame: number | undefined
      let disposed = false
      const scroller = () => {
        let element: HTMLElement | null = root
        while (element && element !== shell.current) {
          if (
            /(auto|scroll)/.test(getComputedStyle(element).overflowY) &&
            element.scrollHeight > element.clientHeight
          ) {
            return element
          }
          element = element.parentElement
        }
        return root.closest<HTMLElement>('.editor-scroller') ?? root
      }
      const viewport = () => {
        const element = scroller()
        const rootBox = root.getBoundingClientRect()
        const box = element.getBoundingClientRect()
        return {
          viewportTop: element === root ? element.scrollTop : box.top - rootBox.top,
          viewportHeight: element.clientHeight,
          trackHeight: shell.current?.clientHeight ?? 0,
        }
      }
      scroll.current = (top) => {
        const element = scroller()
        const current = viewport().viewportTop
        element.scrollTo({ top: element.scrollTop + top - current, behavior: 'auto' })
      }
      const measure = () => {
        timer = undefined
        if (disposed) {
          return
        }
        setSnapshot({
          lines: collectVisualLines(root),
          contentHeight: Math.max(1, root.scrollHeight),
          width: Math.max(1, root.clientWidth),
          ...viewport(),
        })
      }
      const schedule = () => {
        if (!timer) {
          timer = setTimeout(measure, 120)
        }
      }
      const onScroll = () => {
        if (frame !== undefined) {
          return
        }
        frame = requestAnimationFrame(() => {
          frame = undefined
          if (!disposed) {
            setSnapshot((old) => ({ ...old, ...viewport() }))
          }
        })
      }
      const mutation = new MutationObserver(schedule)
      mutation.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
      })
      const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
      resize?.observe(root)
      resize?.observe(shell.current)
      root.addEventListener('load', schedule, true)
      window.addEventListener('scroll', onScroll, true)
      window.addEventListener('resize', schedule)
      document.fonts?.addEventListener('loadingdone', schedule)
      schedule()
      disposeRoot = () => {
        disposed = true
        mutation.disconnect()
        resize?.disconnect()
        if (timer) {
          clearTimeout(timer)
        }
        if (frame !== undefined) {
          cancelAnimationFrame(frame)
        }
        root.removeEventListener('load', schedule, true)
        window.removeEventListener('scroll', onScroll, true)
        window.removeEventListener('resize', schedule)
        document.fonts?.removeEventListener('loadingdone', schedule)
        scroll.current = () => undefined
      }
    })
    return () => {
      unregister()
      disposeRoot()
    }
  }, [editor, enabled, layout.lineNumbers, layout.minimap, noteUuid])
  useEffect(() => {
    if (!layout.minimap || !canvas.current) {
      return
    }
    const surface = canvas.current
    const context = surface.getContext('2d')
    if (!context) {
      return
    }
    const ratio = Math.min(2, window.devicePixelRatio || 1)
    surface.width = 64 * ratio
    surface.height = Math.max(1, snapshot.trackHeight * ratio)
    context.scale(ratio, ratio)
    context.fillStyle = getComputedStyle(surface).color
    const scaleY = snapshot.trackHeight / snapshot.contentHeight
    for (const line of snapshot.lines) {
      context.fillRect(
        (line.left / snapshot.width) * 60 + 2,
        line.top * scaleY,
        Math.max(1, ((line.right - line.left) / snapshot.width) * 60),
        Math.max(1, Math.min(3, line.height * scaleY)),
      )
    }
  }, [layout.minimap, snapshot.lines, snapshot.trackHeight, snapshot.contentHeight, snapshot.width])
  const visible = []
  if (layout.lineNumbers) {
    for (let index = visibleLineStart(snapshot.lines, snapshot.viewportTop); index < snapshot.lines.length; index++) {
      const line = snapshot.lines[index]
      if (line.top > snapshot.viewportTop + snapshot.viewportHeight) {
        break
      }
      visible.push(
        <span key={index} style={{ top: line.top - snapshot.viewportTop, height: line.height }}>
          {index + 1}
        </span>,
      )
    }
  }
  return (
    <div className="srn-editor-navigation-aids" ref={shell}>
      {layout.lineNumbers && (
        <div className="srn-line-gutter" aria-hidden="true">
          {visible}
        </div>
      )}
      <div className="relative min-h-0 min-w-0 flex-grow">{children}</div>
      {layout.minimap && (
        <button
          type="button"
          className="srn-note-minimap"
          aria-label="Document minimap. Click to scroll; use arrow keys, Page Up or Page Down to navigate."
          onPointerDown={(event) => {
            event.preventDefault()
            const box = event.currentTarget.getBoundingClientRect()
            scroll.current(
              minimapScrollTarget(
                (event.clientY - box.top) / Math.max(1, box.height),
                snapshot.contentHeight,
                snapshot.viewportHeight,
              ),
            )
          }}
          onKeyDown={(event) => {
            const step =
              event.key === 'ArrowDown'
                ? 40
                : event.key === 'ArrowUp'
                  ? -40
                  : event.key === 'PageDown'
                    ? snapshot.viewportHeight
                    : event.key === 'PageUp'
                      ? -snapshot.viewportHeight
                      : undefined
            const top =
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? snapshot.contentHeight
                  : step !== undefined
                    ? snapshot.viewportTop + step
                    : undefined
            if (top !== undefined) {
              event.preventDefault()
              scroll.current(Math.max(0, Math.min(snapshot.contentHeight - snapshot.viewportHeight, top)))
            }
          }}
        >
          <canvas ref={canvas} aria-hidden="true" />
          <span
            className="srn-note-minimap-viewport"
            style={{
              top: `${(Math.max(0, snapshot.viewportTop) / snapshot.contentHeight) * 100}%`,
              height: `${Math.min(1, snapshot.viewportHeight / snapshot.contentHeight) * 100}%`,
            }}
          />
        </button>
      )}
    </div>
  )
}
