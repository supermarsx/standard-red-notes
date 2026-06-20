import { WebApplication } from '@/Application/WebApplication'
import { isPayloadSourceRetrieved } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { FunctionComponent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { NoteViewController } from '../Controller/NoteViewController'
import Icon from '@/Components/Icon/Icon'
import {
  MapDocument,
  MapNode,
  addChildNode,
  addNode,
  autoArrangeTree,
  connectNodes,
  createEmptyMapDocument,
  createFamilyTreeStarter,
  createMindMapStarter,
  deleteNode,
  moveNode,
  parseMapDocument,
  serializeMapDocument,
  setNodeColor,
  setNodeText,
} from './MapDocument'

/** Identifier stored in `note.editorIdentifier` to mark a note as a Map. */
export const MapEditorIdentifier = 'org.standardnotes.map'

const PERSIST_DEBOUNCE_MS = 400

const NODE_WIDTH = 140
const NODE_HEIGHT = 56

const NODE_COLORS = ['#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899']

type Props = {
  application: WebApplication
  controller: NoteViewController
  readonly?: boolean
  customBackgroundColor?: string
  customTextColor?: string
}

type DragState =
  | { kind: 'node'; id: string; offsetX: number; offsetY: number; moved: boolean }
  | { kind: 'pan'; startX: number; startY: number; originX: number; originY: number }

export const MapEditor: FunctionComponent<Props> = ({
  controller,
  readonly,
  customBackgroundColor,
  customTextColor,
}) => {
  const note = useRef(controller.item)
  const initialParse = useMemo(() => parseMapDocument(controller.item.text), [controller.item.text])
  const [document, setDocument] = useState<MapDocument>(initialParse.document)
  const [recoveryNotice, setRecoveryNotice] = useState(!initialParse.recovered)

  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [connectFrom, setConnectFrom] = useState<string | null>(null)

  const canvasRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<DragState | null>(null)

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ignoreNextChange = useRef(false)

  const isReadonly = note.current.locked || Boolean(readonly)

  const persist = useCallback(
    (doc: MapDocument) => {
      if (isReadonly) {
        return
      }
      if (persistTimer.current) {
        clearTimeout(persistTimer.current)
      }
      persistTimer.current = setTimeout(() => {
        ignoreNextChange.current = true
        void controller.saveAndAwaitLocalPropagation({
          text: serializeMapDocument(doc),
          isUserModified: true,
          previews: {
            previewPlain: `Map: ${doc.nodes.length} ${doc.nodes.length === 1 ? 'node' : 'nodes'}, ${
              doc.edges.length
            } ${doc.edges.length === 1 ? 'link' : 'links'}`,
            previewHtml: undefined,
          },
        })
      }, PERSIST_DEBOUNCE_MS)
    },
    [controller, isReadonly],
  )

  const updateDocument = useCallback(
    (updater: (doc: MapDocument) => MapDocument) => {
      setDocument((prev) => {
        const next = updater(prev)
        persist(next)
        return next
      })
    },
    [persist],
  )

  // Sync external (remote/retrieved) changes into the local map.
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
        const { document: parsed } = parseMapDocument(updatedNote.text)
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

  // --- coordinate helpers --------------------------------------------------

  /** Translate a screen (client) point into map-space coordinates. */
  const screenToMap = useCallback(
    (clientX: number, clientY: number) => {
      const rect = canvasRef.current?.getBoundingClientRect()
      const left = rect?.left ?? 0
      const top = rect?.top ?? 0
      return {
        x: (clientX - left - pan.x) / zoom,
        y: (clientY - top - pan.y) / zoom,
      }
    },
    [pan.x, pan.y, zoom],
  )

  // --- node mutators -------------------------------------------------------

  const handleAddNode = useCallback(() => {
    if (isReadonly) {
      return
    }
    // Drop a new node near the centre of the current viewport.
    const rect = canvasRef.current?.getBoundingClientRect()
    const center = screenToMap((rect?.left ?? 0) + (rect?.width ?? 600) / 2, (rect?.top ?? 0) + (rect?.height ?? 400) / 2)
    updateDocument((doc) => addNode(doc, Math.round(center.x - NODE_WIDTH / 2), Math.round(center.y - NODE_HEIGHT / 2), ''))
  }, [isReadonly, screenToMap, updateDocument])

  const handleAddChild = useCallback(
    (parentId: string) => {
      if (isReadonly) {
        return
      }
      updateDocument((doc) => addChildNode(doc, parentId, ''))
    },
    [isReadonly, updateDocument],
  )

  const handleSetText = useCallback(
    (id: string, text: string) => {
      updateDocument((doc) => setNodeText(doc, id, text))
    },
    [updateDocument],
  )

  const handleSetColor = useCallback(
    (id: string, color: string | undefined) => {
      updateDocument((doc) => setNodeColor(doc, id, color))
    },
    [updateDocument],
  )

  const handleDelete = useCallback(
    (id: string) => {
      updateDocument((doc) => deleteNode(doc, id))
      setSelectedId((prev) => (prev === id ? null : prev))
      setConnectFrom((prev) => (prev === id ? null : prev))
    },
    [updateDocument],
  )

  const handleConnectClick = useCallback(
    (id: string) => {
      if (isReadonly) {
        return
      }
      setConnectFrom((prev) => {
        if (prev === null) {
          return id
        }
        if (prev !== id) {
          updateDocument((doc) => connectNodes(doc, prev, id))
        }
        return null
      })
    },
    [isReadonly, updateDocument],
  )

  // --- templates -----------------------------------------------------------

  const applyTemplate = useCallback(
    (template: 'mindmap' | 'family') => {
      if (isReadonly) {
        return
      }
      updateDocument(() => (template === 'mindmap' ? createMindMapStarter() : createFamilyTreeStarter()))
    },
    [isReadonly, updateDocument],
  )

  const handleAutoArrange = useCallback(() => {
    if (isReadonly) {
      return
    }
    updateDocument((doc) => autoArrangeTree(doc))
  }, [isReadonly, updateDocument])

  // --- pointer drag (node move + pan) --------------------------------------

  const onNodePointerDown = useCallback(
    (event: ReactPointerEvent, node: MapNode) => {
      if (editingId === node.id) {
        return
      }
      event.stopPropagation()
      setSelectedId(node.id)
      if (isReadonly) {
        return
      }
      const mapPoint = screenToMap(event.clientX, event.clientY)
      dragState.current = {
        kind: 'node',
        id: node.id,
        offsetX: mapPoint.x - node.x,
        offsetY: mapPoint.y - node.y,
        moved: false,
      }
      ;(event.target as Element).setPointerCapture?.(event.pointerId)
    },
    [editingId, isReadonly, screenToMap],
  )

  const onCanvasPointerDown = useCallback(
    (event: ReactPointerEvent) => {
      // Background click: deselect and start panning.
      setSelectedId(null)
      dragState.current = {
        kind: 'pan',
        startX: event.clientX,
        startY: event.clientY,
        originX: pan.x,
        originY: pan.y,
      }
      ;(event.currentTarget as Element).setPointerCapture?.(event.pointerId)
    },
    [pan.x, pan.y],
  )

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const state = dragState.current
      if (!state) {
        return
      }
      if (state.kind === 'pan') {
        setPan({
          x: state.originX + (event.clientX - state.startX),
          y: state.originY + (event.clientY - state.startY),
        })
        return
      }
      // node drag
      const mapPoint = screenToMap(event.clientX, event.clientY)
      const nextX = Math.round(mapPoint.x - state.offsetX)
      const nextY = Math.round(mapPoint.y - state.offsetY)
      state.moved = true
      // Update local state immediately (debounced persist via updateDocument).
      updateDocument((doc) => moveNode(doc, state.id, nextX, nextY))
    },
    [screenToMap, updateDocument],
  )

  const endDrag = useCallback(() => {
    dragState.current = null
  }, [])

  // --- render --------------------------------------------------------------

  const nodeById = useMemo(() => {
    const map = new Map<string, MapNode>()
    for (const node of document.nodes) {
      map.set(node.id, node)
    }
    return map
  }, [document.nodes])

  // Combine explicit edges with parent links into a single set of lines to draw.
  const lines = useMemo(() => {
    const result: { from: MapNode; to: MapNode; key: string }[] = []
    const seen = new Set<string>()
    const push = (aId: string, bId: string) => {
      const a = nodeById.get(aId)
      const b = nodeById.get(bId)
      if (!a || !b) {
        return
      }
      const key = aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`
      if (seen.has(key)) {
        return
      }
      seen.add(key)
      result.push({ from: a, to: b, key })
    }
    for (const edge of document.edges) {
      push(edge.from, edge.to)
    }
    for (const node of document.nodes) {
      if (node.parentId) {
        push(node.parentId, node.id)
      }
    }
    return result
  }, [document.edges, document.nodes, nodeById])

  const isEmpty = document.nodes.length === 0

  return (
    <div
      className="flex h-full w-full flex-grow flex-col overflow-hidden"
      style={{ backgroundColor: customBackgroundColor, color: customTextColor }}
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="share" className="flex-shrink-0 text-info" />
          <span className="truncate text-sm font-bold">Map</span>
          <span className="truncate text-xs text-neutral">
            {document.nodes.length} {document.nodes.length === 1 ? 'node' : 'nodes'} · {document.edges.length}{' '}
            {document.edges.length === 1 ? 'link' : 'links'}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1">
          {connectFrom && (
            <span className="mr-1 rounded bg-info-faded px-2 py-0.5 text-xs text-info">
              Pick a node to connect…
            </span>
          )}
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => setZoom((z) => Math.max(0.3, +(z - 0.1).toFixed(2)))}
            title="Zoom out"
            aria-label="Zoom out"
          >
            <Icon type="subtract" size="small" />
          </button>
          <span className="w-10 text-center text-xs text-passive-1">{Math.round(zoom * 100)}%</span>
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(2)))}
            title="Zoom in"
            aria-label="Zoom in"
          >
            <Icon type="add" size="small" />
          </button>
          <button
            className="rounded p-1 hover:bg-default"
            onClick={() => {
              setZoom(1)
              setPan({ x: 0, y: 0 })
            }}
            title="Reset view"
            aria-label="Reset view"
          >
            <Icon type="restore" size="small" />
          </button>
          {!isReadonly && (
            <>
              <button
                className="rounded p-1 hover:bg-default disabled:opacity-50"
                onClick={handleAutoArrange}
                disabled={isEmpty}
                title="Auto-arrange as tree"
                aria-label="Auto-arrange as tree"
              >
                <Icon type="menu-arrow-down-alt" size="small" />
              </button>
              <button
                className="flex items-center gap-1 rounded px-2 py-1 text-sm hover:bg-default"
                onClick={handleAddNode}
                title="Add node"
              >
                <Icon type="add" size="small" />
                <span className="hidden sm:inline">Node</span>
              </button>
            </>
          )}
        </div>
      </div>

      {recoveryNotice && (
        <div className="flex items-center gap-2 border-b border-warning bg-warning-faded px-3 py-1.5 text-xs text-accessory-tint-3">
          <span>
            This note's content wasn't recognized as a map and a new one was started. Your original text is preserved
            until you make a change.
          </span>
          <button className="ml-auto underline" onClick={() => setRecoveryNotice(false)}>
            Dismiss
          </button>
        </div>
      )}

      {/* Canvas */}
      <div className="relative min-h-0 flex-grow overflow-hidden">
        {isEmpty ? (
          <EmptyState isReadonly={isReadonly} onTemplate={applyTemplate} onAddNode={handleAddNode} />
        ) : (
          <div
            ref={canvasRef}
            className="absolute inset-0 touch-none select-none overflow-hidden"
            style={{ cursor: 'grab' }}
            onPointerDown={onCanvasPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <div
              className="absolute left-0 top-0 origin-top-left"
              style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
            >
              {/* Edges / parent links beneath the nodes. */}
              <svg
                className="pointer-events-none absolute overflow-visible"
                style={{ left: 0, top: 0, width: 1, height: 1 }}
              >
                {lines.map((line) => {
                  const x1 = line.from.x + NODE_WIDTH / 2
                  const y1 = line.from.y + NODE_HEIGHT / 2
                  const x2 = line.to.x + NODE_WIDTH / 2
                  const y2 = line.to.y + NODE_HEIGHT / 2
                  const midY = (y1 + y2) / 2
                  return (
                    <path
                      key={line.key}
                      d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                      stroke="var(--sn-stylekit-border-color)"
                      strokeWidth={2}
                      fill="none"
                    />
                  )
                })}
              </svg>

              {document.nodes.map((node) => (
                <MapNodeBox
                  key={node.id}
                  node={node}
                  selected={selectedId === node.id}
                  connectSource={connectFrom === node.id}
                  isReadonly={isReadonly}
                  editing={editingId === node.id}
                  onPointerDown={(event) => onNodePointerDown(event, node)}
                  onStartEditing={() => !isReadonly && setEditingId(node.id)}
                  onStopEditing={() => setEditingId(null)}
                  onChangeText={(text) => handleSetText(node.id, text)}
                  onAddChild={() => handleAddChild(node.id)}
                  onConnect={() => handleConnectClick(node.id)}
                  onSetColor={(color) => handleSetColor(node.id, color)}
                  onDelete={() => handleDelete(node.id)}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// --- empty state -----------------------------------------------------------

type EmptyStateProps = {
  isReadonly: boolean
  onTemplate: (template: 'mindmap' | 'family') => void
  onAddNode: () => void
}

const EmptyState: FunctionComponent<EmptyStateProps> = ({ isReadonly, onTemplate, onAddNode }) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-neutral">
    <p className="font-semibold">Empty map</p>
    <p>Start from a template, or add a node and build it yourself.</p>
    {!isReadonly && (
      <div className="flex flex-wrap items-center justify-center gap-2">
        <button
          className="rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
          onClick={() => onTemplate('mindmap')}
        >
          Mind map
        </button>
        <button
          className="rounded bg-info px-3 py-1.5 text-sm font-semibold text-info-contrast hover:opacity-90"
          onClick={() => onTemplate('family')}
        >
          Family tree
        </button>
        <button
          className="rounded border border-border bg-contrast px-3 py-1.5 text-sm font-semibold hover:border-info"
          onClick={onAddNode}
        >
          Blank node
        </button>
      </div>
    )}
  </div>
)

// --- node box --------------------------------------------------------------

type MapNodeBoxProps = {
  node: MapNode
  selected: boolean
  connectSource: boolean
  isReadonly: boolean
  editing: boolean
  onPointerDown: (event: ReactPointerEvent) => void
  onStartEditing: () => void
  onStopEditing: () => void
  onChangeText: (text: string) => void
  onAddChild: () => void
  onConnect: () => void
  onSetColor: (color: string | undefined) => void
  onDelete: () => void
}

const MapNodeBox: FunctionComponent<MapNodeBoxProps> = ({
  node,
  selected,
  connectSource,
  isReadonly,
  editing,
  onPointerDown,
  onStartEditing,
  onStopEditing,
  onChangeText,
  onAddChild,
  onConnect,
  onSetColor,
  onDelete,
}) => {
  const accent = node.color
  return (
    <div
      className="absolute"
      style={{ left: node.x, top: node.y, width: NODE_WIDTH }}
      onPointerDown={onPointerDown}
    >
      <div
        className={classNames(
          'flex min-h-[3.5rem] flex-col rounded-md border bg-default shadow-sm',
          selected || connectSource ? 'border-info' : 'border-border',
        )}
        style={{
          borderLeft: accent ? `4px solid ${accent}` : undefined,
          cursor: isReadonly ? 'default' : 'move',
        }}
      >
        <div className="flex-grow px-2 py-1.5" onDoubleClick={onStartEditing}>
          {editing ? (
            <textarea
              autoFocus
              className="w-full resize-none rounded bg-contrast p-1 text-xs text-text outline-none"
              rows={2}
              value={node.text}
              placeholder="Label"
              onChange={(event) => onChangeText(event.target.value)}
              onBlur={onStopEditing}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault()
                  onStopEditing()
                }
              }}
            />
          ) : (
            <span className="block break-words text-xs text-text">
              {node.text || <span className="italic text-passive-2">Label</span>}
            </span>
          )}
        </div>
      </div>

      {selected && !isReadonly && !editing && (
        <div className="absolute left-0 right-0 top-full z-10 mt-1 flex flex-wrap items-center gap-1 rounded-md border border-border bg-contrast p-1 shadow-md">
          <button className="rounded p-1 hover:bg-default" onClick={onStartEditing} title="Edit label" aria-label="Edit label">
            <Icon type="pencil" size="small" />
          </button>
          <button className="rounded p-1 hover:bg-default" onClick={onAddChild} title="Add child" aria-label="Add child">
            <Icon type="add" size="small" />
          </button>
          <button
            className={classNames('rounded p-1 hover:bg-default', connectSource && 'bg-info text-info-contrast')}
            onClick={onConnect}
            title="Connect to another node"
            aria-label="Connect to another node"
          >
            <Icon type="link" size="small" />
          </button>
          <div className="flex items-center gap-0.5">
            {NODE_COLORS.map((color) => (
              <button
                key={color}
                className={classNames(
                  'h-4 w-4 rounded-full border',
                  node.color === color ? 'border-info' : 'border-border',
                )}
                style={{ backgroundColor: color }}
                onClick={() => onSetColor(node.color === color ? undefined : color)}
                title="Set color"
                aria-label={`Set color ${color}`}
              />
            ))}
          </div>
          <button
            className="rounded p-1 text-danger hover:bg-default"
            onClick={onDelete}
            title="Delete node"
            aria-label="Delete node"
          >
            <Icon type="trash" size="small" />
          </button>
        </div>
      )}
    </div>
  )
}

export const initializeMapNoteText = (): string => serializeMapDocument(createMindMapStarter())
export const initializeEmptyMapNoteText = (): string => serializeMapDocument(createEmptyMapDocument())
