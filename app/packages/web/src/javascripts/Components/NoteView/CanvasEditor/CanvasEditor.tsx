import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import {
  FunctionComponent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import { classNames } from '@standardnotes/utils'
import {
  CanvasDocument,
  CanvasEdge,
  CanvasNode,
  CanvasNodeSide,
  createCanvasId,
  createEmptyCanvasDocument,
  parseCanvasDocument,
  serializeCanvasDocument,
} from './CanvasDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Canvas note. */
export const CanvasEditorIdentifier = 'org.standardnotes.canvas'

const PERSIST_DEBOUNCE_MS = 400
const MIN_NODE_WIDTH = 120
const MIN_NODE_HEIGHT = 60
const DEFAULT_NODE_WIDTH = 200
const DEFAULT_NODE_HEIGHT = 100
const MIN_ZOOM = 0.2
const MAX_ZOOM = 3
const ZOOM_SENSITIVITY = 0.0015

type Viewport = { x: number; y: number; zoom: number }

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

const NODE_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

const sideAnchor = (node: CanvasNode, side: CanvasNodeSide): { x: number; y: number } => {
  switch (side) {
    case 'top':
      return { x: node.x + node.width / 2, y: node.y }
    case 'bottom':
      return { x: node.x + node.width / 2, y: node.y + node.height }
    case 'left':
      return { x: node.x, y: node.y + node.height / 2 }
    case 'right':
      return { x: node.x + node.width, y: node.y + node.height / 2 }
  }
}

const nodeCenter = (node: CanvasNode) => ({ x: node.x + node.width / 2, y: node.y + node.height / 2 })

/** Pick the best anchor side on `node` facing `target`. */
const bestSide = (node: CanvasNode, target: { x: number; y: number }): CanvasNodeSide => {
  const c = nodeCenter(node)
  const dx = target.x - c.x
  const dy = target.y - c.y
  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'right' : 'left'
  }
  return dy > 0 ? 'bottom' : 'top'
}

const resolveEdgeEndpoints = (edge: CanvasEdge, nodesById: Map<string, CanvasNode>) => {
  const from = nodesById.get(edge.fromNode)
  const to = nodesById.get(edge.toNode)
  if (!from || !to) {
    return null
  }
  const fromSide = edge.fromSide ?? bestSide(from, nodeCenter(to))
  const toSide = edge.toSide ?? bestSide(to, nodeCenter(from))
  return { start: sideAnchor(from, fromSide), end: sideAnchor(to, toSide) }
}

type DragState =
  | { type: 'pan'; startClientX: number; startClientY: number; startViewport: Viewport }
  | { type: 'move-node'; nodeId: string; startClientX: number; startClientY: number; startX: number; startY: number }
  | {
      type: 'resize-node'
      nodeId: string
      startClientX: number
      startClientY: number
      startWidth: number
      startHeight: number
    }
  | { type: 'connect'; fromNode: string; fromSide: CanvasNodeSide; currentX: number; currentY: number }

export const CanvasEditor: FunctionComponent<Props> = ({
  application,
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseCanvasDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<CanvasDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)
  const [viewport, setViewport] = useState<Viewport>({ x: 0, y: 0, zoom: 1 })
  const [selection, setSelection] = useState<{ kind: 'node' | 'edge'; id: string } | null>(null)
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null)

  const containerRef = useRef<HTMLDivElement>(null)
  const dragState = useRef<DragState | null>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)
  const latestDocument = useRef(document)
  latestDocument.current = document

  const isReadonly = note.current.locked || Boolean(readonly)

  // Persist (debounced) to note.text using the same mutator path Super uses.
  const persist = useCallback(
    (doc: CanvasDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeCanvasDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Canvas: ${doc.nodes.length} cards, ${doc.edges.length} connections`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: CanvasDocument) => CanvasDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local canvas.
  useEffect(() => {
    const disposer = controller.addNoteInnerValueChangeObserver((updatedNote, source) => {
      if (updatedNote.uuid !== note.current.uuid) {
        return
      }
      note.current = updatedNote

      if (ignoreNextChange.current) {
        ignoreNextChange.current = false
        return
      }

      if (isPayloadSourceRetrieved(source)) {
        const { document: parsed } = parseCanvasDocument(updatedNote.text)
        setDocument(parsed)
      }
    })
    return disposer
  }, [controller])

  useEffect(() => {
    return () => {
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
    }
  }, [])

  const nodesById = useMemo(() => {
    const map = new Map<string, CanvasNode>()
    for (const node of document.nodes) {
      map.set(node.id, node)
    }
    return map
  }, [document.nodes])

  // Convert a client (screen) coordinate to canvas (document) space.
  const clientToCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const rect = containerRef.current?.getBoundingClientRect()
      const offsetX = rect ? clientX - rect.left : clientX
      const offsetY = rect ? clientY - rect.top : clientY
      return {
        x: (offsetX - viewport.x) / viewport.zoom,
        y: (offsetY - viewport.y) / viewport.zoom,
      }
    },
    [viewport],
  )

  const addNodeAt = useCallback(
    (canvasX: number, canvasY: number) => {
      if (isReadonly) {
        return
      }
      const id = createCanvasId('node')
      const newNode: CanvasNode = {
        id,
        x: canvasX - DEFAULT_NODE_WIDTH / 2,
        y: canvasY - DEFAULT_NODE_HEIGHT / 2,
        width: DEFAULT_NODE_WIDTH,
        height: DEFAULT_NODE_HEIGHT,
        text: '',
      }
      updateDocument((doc) => ({ ...doc, nodes: [...doc.nodes, newNode] }))
      setSelection({ kind: 'node', id })
      setEditingNodeId(id)
    },
    [isReadonly, updateDocument],
  )

  const addNodeAtCenter = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    const center = clientToCanvas(
      (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
      (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
    )
    addNodeAt(center.x, center.y)
  }, [addNodeAt, clientToCanvas])

  const deleteSelection = useCallback(() => {
    if (!selection || isReadonly) {
      return
    }
    if (selection.kind === 'node') {
      updateDocument((doc) => ({
        ...doc,
        nodes: doc.nodes.filter((n) => n.id !== selection.id),
        edges: doc.edges.filter((e) => e.fromNode !== selection.id && e.toNode !== selection.id),
      }))
    } else {
      updateDocument((doc) => ({ ...doc, edges: doc.edges.filter((e) => e.id !== selection.id) }))
    }
    setSelection(null)
  }, [selection, isReadonly, updateDocument])

  const fitToContent = useCallback(() => {
    const rect = containerRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    if (document.nodes.length === 0) {
      setViewport({ x: rect.width / 2, y: rect.height / 2, zoom: 1 })
      return
    }
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of document.nodes) {
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x + node.width)
      maxY = Math.max(maxY, node.y + node.height)
    }
    const padding = 60
    const contentWidth = maxX - minX + padding * 2
    const contentHeight = maxY - minY + padding * 2
    const zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(rect.width / contentWidth, rect.height / contentHeight)))
    const x = rect.width / 2 - ((minX + maxX) / 2) * zoom
    const y = rect.height / 2 - ((minY + maxY) / 2) * zoom
    setViewport({ x, y, zoom })
  }, [document.nodes])

  // Keyboard: delete selection.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
        return
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selection) {
        event.preventDefault()
        deleteSelection()
      }
    }
    const el = containerRef.current
    el?.addEventListener('keydown', onKeyDown)
    return () => el?.removeEventListener('keydown', onKeyDown)
  }, [selection, deleteSelection])

  // Wheel zoom (and trackpad pan). Bound non-passively so we can preventDefault.
  useEffect(() => {
    const el = containerRef.current
    if (!el) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.ctrlKey || event.metaKey || !event.shiftKey) {
        // Zoom toward the cursor.
        const rect = el.getBoundingClientRect()
        const cursorX = event.clientX - rect.left
        const cursorY = event.clientY - rect.top
        setViewport((prev) => {
          const nextZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, prev.zoom * (1 - event.deltaY * ZOOM_SENSITIVITY)))
          const scale = nextZoom / prev.zoom
          return {
            zoom: nextZoom,
            x: cursorX - (cursorX - prev.x) * scale,
            y: cursorY - (cursorY - prev.y) * scale,
          }
        })
      } else {
        setViewport((prev) => ({ ...prev, x: prev.x - event.deltaX, y: prev.y - event.deltaY }))
      }
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const onBackgroundPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      if (event.button !== 0) {
        return
      }
      containerRef.current?.focus()
      setSelection(null)
      setEditingNodeId(null)
      dragState.current = {
        type: 'pan',
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewport: viewport,
      }
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [viewport],
  )

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent, node: CanvasNode) => {
      if (event.button !== 0 || editingNodeId === node.id) {
        return
      }
      event.stopPropagation()
      setSelection({ kind: 'node', id: node.id })
      if (isReadonly) {
        return
      }
      dragState.current = {
        type: 'move-node',
        nodeId: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startX: node.x,
        startY: node.y,
      }
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [editingNodeId, isReadonly],
  )

  const onResizePointerDown = useCallback(
    (event: ReactPointerEvent, node: CanvasNode) => {
      if (event.button !== 0 || isReadonly) {
        return
      }
      event.stopPropagation()
      dragState.current = {
        type: 'resize-node',
        nodeId: node.id,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startWidth: node.width,
        startHeight: node.height,
      }
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [isReadonly],
  )

  const onConnectorPointerDown = useCallback(
    (event: ReactPointerEvent, node: CanvasNode, side: CanvasNodeSide) => {
      if (event.button !== 0 || isReadonly) {
        return
      }
      event.stopPropagation()
      const anchor = sideAnchor(node, side)
      dragState.current = { type: 'connect', fromNode: node.id, fromSide: side, currentX: anchor.x, currentY: anchor.y }
      setConnectPreview({ x: anchor.x, y: anchor.y })
      ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
    },
    [isReadonly],
  )

  const [connectPreview, setConnectPreview] = useState<{ x: number; y: number } | null>(null)

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const state = dragState.current
      if (!state) {
        return
      }
      if (state.type === 'pan') {
        const dx = event.clientX - state.startClientX
        const dy = event.clientY - state.startClientY
        setViewport({ ...state.startViewport, x: state.startViewport.x + dx, y: state.startViewport.y + dy })
      } else if (state.type === 'move-node') {
        const dx = (event.clientX - state.startClientX) / viewport.zoom
        const dy = (event.clientY - state.startClientY) / viewport.zoom
        setDocument((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === state.nodeId ? { ...n, x: state.startX + dx, y: state.startY + dy } : n,
          ),
        }))
      } else if (state.type === 'resize-node') {
        const dx = (event.clientX - state.startClientX) / viewport.zoom
        const dy = (event.clientY - state.startClientY) / viewport.zoom
        setDocument((prev) => ({
          ...prev,
          nodes: prev.nodes.map((n) =>
            n.id === state.nodeId
              ? {
                  ...n,
                  width: Math.max(MIN_NODE_WIDTH, state.startWidth + dx),
                  height: Math.max(MIN_NODE_HEIGHT, state.startHeight + dy),
                }
              : n,
          ),
        }))
      } else if (state.type === 'connect') {
        const point = clientToCanvas(event.clientX, event.clientY)
        dragState.current = { ...state, currentX: point.x, currentY: point.y }
        setConnectPreview(point)
      }
    },
    [viewport.zoom, clientToCanvas],
  )

  const onPointerUp = useCallback(
    (event: ReactPointerEvent) => {
      const state = dragState.current
      dragState.current = null
      if (!state) {
        return
      }

      if (state.type === 'move-node' || state.type === 'resize-node') {
        // Commit the in-progress geometry change to persistence.
        persist(latestDocument.current)
      } else if (state.type === 'connect') {
        setConnectPreview(null)
        const point = clientToCanvas(event.clientX, event.clientY)
        const targetNode = latestDocument.current.nodes.find(
          (n) =>
            n.id !== state.fromNode &&
            point.x >= n.x &&
            point.x <= n.x + n.width &&
            point.y >= n.y &&
            point.y <= n.y + n.height,
        )
        if (targetNode) {
          const fromNode = nodesById.get(state.fromNode)
          const toSide = fromNode ? bestSide(targetNode, nodeCenter(fromNode)) : 'left'
          const newEdge: CanvasEdge = {
            id: createCanvasId('edge'),
            fromNode: state.fromNode,
            toNode: targetNode.id,
            fromSide: state.fromSide,
            toSide,
          }
          updateDocument((doc) => ({ ...doc, edges: [...doc.edges, newEdge] }))
        }
      }
    },
    [persist, clientToCanvas, nodesById, updateDocument],
  )

  const onBackgroundDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (isReadonly) {
        return
      }
      const point = clientToCanvas(event.clientX, event.clientY)
      addNodeAt(point.x, point.y)
    },
    [isReadonly, clientToCanvas, addNodeAt],
  )

  const setNodeText = useCallback(
    (nodeId: string, text: string) => {
      updateDocument((doc) => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, text } : n)),
      }))
    },
    [updateDocument],
  )

  const setNodeColor = useCallback(
    (nodeId: string, color: string | undefined) => {
      updateDocument((doc) => ({
        ...doc,
        nodes: doc.nodes.map((n) => (n.id === nodeId ? { ...n, color } : n)),
      }))
    },
    [updateDocument],
  )

  const transform = `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom})`

  const sides: CanvasNodeSide[] = ['top', 'right', 'bottom', 'left']

  return (
    <div
      className="relative h-full w-full flex-grow overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="absolute left-2 top-2 z-10 flex flex-wrap items-center gap-1 rounded-md border border-border bg-default p-1 shadow-sm">
        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-contrast disabled:opacity-50"
          onClick={addNodeAtCenter}
          disabled={isReadonly}
          title="Add card"
        >
          <Icon type="add" size="small" />
          <span className="hidden sm:inline">Card</span>
        </button>
        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-contrast disabled:opacity-50"
          onClick={deleteSelection}
          disabled={isReadonly || !selection}
          title="Delete selected"
        >
          <Icon type="trash" size="small" />
        </button>
        <div className="mx-1 h-5 w-px bg-border" />
        <button
          className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-contrast"
          onClick={fitToContent}
          title="Fit to content"
        >
          <Icon type="menu-arrow-down-alt" size="small" />
          <span className="hidden sm:inline">Fit</span>
        </button>
        <span className="px-1 text-xs text-passive-1">{Math.round(viewport.zoom * 100)}%</span>
      </div>

      {recoveryNotice && (
        <div className="absolute left-1/2 top-2 z-10 -translate-x-1/2 rounded-md border border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          This note's content wasn't recognized as a canvas and a new board was started. Your original text is preserved
          until you make a change.
          <button className="ml-2 underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        tabIndex={0}
        className="canvas-editor-surface h-full w-full touch-none outline-none"
        style={{ cursor: dragState.current?.type === 'pan' ? 'grabbing' : 'grab' }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={onBackgroundDoubleClick}
      >
        {/* Transformed world layer */}
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform }}>
          {/* Edge SVG layer. Overflow visible so lines render outside the 0-size box. */}
          <svg className="pointer-events-none absolute left-0 top-0 overflow-visible" width={1} height={1}>
            <defs>
              <marker
                id="canvas-arrow"
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" />
              </marker>
            </defs>
            {document.edges.map((edge) => {
              const endpoints = resolveEdgeEndpoints(edge, nodesById)
              if (!endpoints) {
                return null
              }
              const selected = selection?.kind === 'edge' && selection.id === edge.id
              return (
                <g key={edge.id} className="pointer-events-auto" onPointerDown={(e) => e.stopPropagation()}>
                  {/* Wide invisible hit area for easier selection. */}
                  <line
                    x1={endpoints.start.x}
                    y1={endpoints.start.y}
                    x2={endpoints.end.x}
                    y2={endpoints.end.y}
                    stroke="transparent"
                    strokeWidth={12}
                    className="cursor-pointer"
                    onClick={() => setSelection({ kind: 'edge', id: edge.id })}
                  />
                  <line
                    x1={endpoints.start.x}
                    y1={endpoints.start.y}
                    x2={endpoints.end.x}
                    y2={endpoints.end.y}
                    className={classNames(selected ? 'text-info' : 'text-passive-1')}
                    stroke="currentColor"
                    strokeWidth={selected ? 3 : 2}
                    markerEnd="url(#canvas-arrow)"
                  />
                </g>
              )
            })}
            {connectPreview && dragState.current?.type === 'connect' && (
              <line
                x1={sideAnchor(nodesById.get(dragState.current.fromNode) as CanvasNode, dragState.current.fromSide).x}
                y1={sideAnchor(nodesById.get(dragState.current.fromNode) as CanvasNode, dragState.current.fromSide).y}
                x2={connectPreview.x}
                y2={connectPreview.y}
                className="text-info"
                stroke="currentColor"
                strokeWidth={2}
                strokeDasharray="4 4"
              />
            )}
          </svg>

          {/* Card nodes */}
          {document.nodes.map((node) => {
            const selected = selection?.kind === 'node' && selection.id === node.id
            const isEditing = editingNodeId === node.id
            return (
              <div
                key={node.id}
                className={classNames(
                  'canvas-card absolute flex flex-col rounded-md border bg-default shadow-sm',
                  selected ? 'border-info' : 'border-border',
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  width: node.width,
                  height: node.height,
                  borderLeft: node.color ? `4px solid ${node.color}` : undefined,
                }}
                onPointerDown={(e) => onNodePointerDown(e, node)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (!isReadonly) {
                    setEditingNodeId(node.id)
                  }
                }}
              >
                {isEditing ? (
                  <textarea
                    autoFocus
                    className="h-full w-full flex-grow resize-none bg-transparent p-2 text-sm outline-none"
                    value={node.text}
                    onChange={(e) => setNodeText(node.id, e.target.value)}
                    onBlur={() => setEditingNodeId(null)}
                    onPointerDown={(e) => e.stopPropagation()}
                    placeholder="Type..."
                  />
                ) : (
                  <div className="h-full w-full flex-grow overflow-auto whitespace-pre-wrap break-words p-2 text-sm">
                    {node.text || <span className="text-passive-2">Empty card</span>}
                  </div>
                )}

                {selected && !isReadonly && (
                  <>
                    {/* Color swatches */}
                    <div className="absolute -top-7 left-0 flex gap-1 rounded bg-default p-0.5 shadow-sm">
                      {NODE_COLORS.map((color) => (
                        <button
                          key={color}
                          className="h-4 w-4 rounded-full border border-border"
                          style={{ backgroundColor: color }}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={() => setNodeColor(node.id, node.color === color ? undefined : color)}
                          title="Set color"
                        />
                      ))}
                    </div>

                    {/* Connection handles */}
                    {sides.map((side) => {
                      const anchor = sideAnchor(node, side)
                      return (
                        <div
                          key={side}
                          className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-info bg-default"
                          style={{ left: anchor.x - node.x, top: anchor.y - node.y }}
                          onPointerDown={(e) => onConnectorPointerDown(e, node, side)}
                        />
                      )
                    })}

                    {/* Resize handle */}
                    <div
                      className="absolute -bottom-1 -right-1 h-3 w-3 cursor-nwse-resize rounded-sm border border-info bg-default"
                      onPointerDown={(e) => onResizePointerDown(e, node)}
                    />
                  </>
                )}
              </div>
            )
          })}
        </div>

        {document.nodes.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="text-center text-sm text-passive-1">
              <p className="font-semibold">Empty canvas</p>
              <p>Double-click anywhere or use the toolbar to add a card.</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export const initializeCanvasNoteText = (): string => serializeCanvasDocument(createEmptyCanvasDocument())
