import React, { forwardRef, ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { observer } from 'mobx-react-lite'
import { ContentType, PrefKey, SNNote, SNTag, SNFolder, DecryptedItemInterface } from '@standardnotes/snjs'
import { classNames } from '@standardnotes/utils'
import { WebApplication } from '@/Application/WebApplication'
import Icon from '@/Components/Icon/Icon'
import { useResponsiveAppPane } from '../Panes/ResponsivePaneProvider'
import { AppPaneId } from '../Panes/AppPaneMetadata'
import { openOrFocusConstellationWindow } from './constellationWindow'
import {
  ConstellationScope,
  ConstellationScopeKind,
  selectConstellationNoteUuids,
} from './selectConstellationNotes'
import {
  screenToWorld as cameraScreenToWorld,
  wheelDeltaToFactor,
  zoomByFactor,
  zoomToward,
} from './constellationCamera'

const FolderContentType = 'Folder'

type ConstellationPosition = 'right' | 'left' | 'bottom'

type SelectedNote = { uuid: string; title: string; summary: string; x: number; y: number }

type GraphNode = {
  uuid: string
  title: string
  x: number
  y: number
  vx: number
  vy: number
  degree: number
}

type GraphEdge = { a: number; b: number }

type Graph = { nodes: GraphNode[]; edges: GraphEdge[]; truncated: number }

type Colors = { node: string; nodeDim: string; edge: string; edgeHi: string; label: string; bg: string }

// Cap the number of nodes the force simulation handles. Repulsion is O(n^2) per
// frame; beyond this the graph is both unreadable and too heavy to animate.
const MAX_NODES = 600

type Props = {
  application: WebApplication
  className?: string
  id: string
  children?: ReactNode
  /** When true the view is rendered as a standalone popped-out window. */
  standalone?: boolean
}

/**
 * Build the undirected note-to-note adjacency for a single note: its outgoing
 * links plus its backlinks. Used by the 'current' scope to expand a bounded
 * neighborhood around the active note.
 */
function noteAdjacency(application: WebApplication, uuid: string): string[] {
  const note = application.items.findItem<SNNote>(uuid)
  if (!note) {
    return []
  }
  const neighbors = new Set<string>()
  for (const linked of application.items.referencesForItem<SNNote>(note, ContentType.TYPES.Note)) {
    neighbors.add(linked.uuid)
  }
  for (const backlink of application.items.itemsReferencingItem<SNNote>(note, ContentType.TYPES.Note)) {
    neighbors.add(backlink.uuid)
  }
  return [...neighbors]
}

/** Resolve the note uuids belonging to a tag/folder collection. */
function collectionNoteUuids(application: WebApplication, collection: DecryptedItemInterface): string[] {
  return application.items
    .referencesForItem<SNNote>(collection, ContentType.TYPES.Note)
    .map((note) => note.uuid)
}

function buildGraph(application: WebApplication, scope: ConstellationScope): Graph {
  const allNotes = application.items.getDisplayableNotes()

  // Decide which notes are in-scope. Global keeps the legacy all-notes behaviour;
  // the other scopes restrict to a (usually small) subset.
  let scopedNotes = allNotes
  if (scope.kind !== 'global') {
    const activeNoteUuid =
      scope.kind === 'current' ? application.itemListController.activeControllerItem?.uuid : undefined

    let collection: string[] | undefined
    if ((scope.kind === 'tag' || scope.kind === 'folder') && scope.collectionUuid) {
      const item = application.items.findItem(scope.collectionUuid)
      collection = item ? collectionNoteUuids(application, item) : []
    }

    const selected = selectConstellationNoteUuids({
      scope,
      allNotes,
      activeNoteUuid,
      adjacency: (uuid) => noteAdjacency(application, uuid),
      collectionNoteUuids: collection,
    })
    scopedNotes = allNotes.filter((note) => selected.has(note.uuid))
  }

  const truncated = Math.max(0, scopedNotes.length - MAX_NODES)
  const notes = scopedNotes.slice(0, MAX_NODES)

  const indexByUuid = new Map<string, number>()
  const nodes: GraphNode[] = notes.map((note, i) => {
    indexByUuid.set(note.uuid, i)
    // Deterministic-ish initial spread on a spiral so the layout starts untangled.
    const angle = i * 2.399963 // golden angle
    const radius = 16 * Math.sqrt(i + 1)
    return {
      uuid: note.uuid,
      title: note.title || 'Untitled',
      x: radius * Math.cos(angle),
      y: radius * Math.sin(angle),
      vx: 0,
      vy: 0,
      degree: 0,
    }
  })

  const edges: GraphEdge[] = []
  const seen = new Set<string>()
  for (const note of notes) {
    const a = indexByUuid.get(note.uuid)
    if (a === undefined) {
      continue
    }
    const linked = application.items.referencesForItem<SNNote>(note, ContentType.TYPES.Note)
    for (const other of linked) {
      const b = indexByUuid.get(other.uuid)
      if (b === undefined || b === a) {
        continue
      }
      const key = a < b ? `${a}-${b}` : `${b}-${a}`
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      edges.push({ a, b })
      nodes[a].degree++
      nodes[b].degree++
    }
  }

  return { nodes, edges, truncated }
}

function readColors(element: HTMLElement): Colors {
  const style = getComputedStyle(element)
  const v = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
  return {
    node: v('--sn-stylekit-info-color', '#b3242e'),
    nodeDim: v('--sn-stylekit-neutral-color', '#9b8b90'),
    edge: v('--sn-stylekit-border-color', '#403036'),
    edgeHi: v('--sn-stylekit-info-color', '#b3242e'),
    label: v('--sn-stylekit-foreground-color', '#ece8e9'),
    bg: v('--sn-stylekit-background-color', '#120e11'),
  }
}

const ConstellationView = forwardRef<HTMLDivElement, Props>(
  ({ application, className, id, children, standalone }, ref) => {
  const { presentPane } = useResponsiveAppPane()
  const [selected, setSelected] = useState<SelectedNote | null>(null)
  // Constellation is an editor tab now; it no longer docks to a screen edge, so
  // the position is fixed (kept only for the residual border styling).
  const [position] = useState<ConstellationPosition>(
    application.getPreference(PrefKey.ConstellationPosition, 'right'),
  )

  // --- scope (tab / filter) ----------------------------------------------
  const [scopeKind, setScopeKind] = useState<ConstellationScopeKind>('global')
  const [collectionUuid, setCollectionUuid] = useState<string | undefined>(undefined)

  // Observe the active note so the 'current' scope follows note switches and the
  // empty-state can react. `activeControllerItem` is a mobx computed; reading it
  // inside this observer component subscribes us to changes.
  const activeNote = application.itemListController.activeControllerItem
  const activeNoteUuid = activeNote && activeNote.content_type === ContentType.TYPES.Note ? activeNote.uuid : undefined

  // Available tags / folders for the selector dropdowns.
  const tags = useMemo(() => application.items.getDisplayableTags(), [application, scopeKind])
  const folders = useMemo(
    () => application.items.getItems<SNFolder>(FolderContentType),
    [application, scopeKind],
  )

  const scope: ConstellationScope = useMemo(
    () => ({ kind: scopeKind, collectionUuid }),
    [scopeKind, collectionUuid],
  )
  const scopeRef = useRef(scope)
  scopeRef.current = scope

  const changeScopeKind = useCallback((next: ConstellationScopeKind) => {
    setScopeKind(next)
    // Reset the collection selection so the default-pick effect runs for the new
    // scope (e.g. switching tag -> folder shouldn't reuse a tag uuid).
    setCollectionUuid(undefined)
    setSelected(null)
  }, [])

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)

  const graphRef = useRef<Graph>({ nodes: [], edges: [], truncated: 0 })
  const colorsRef = useRef<Colors | null>(null)
  const cameraRef = useRef({ x: 0, y: 0, scale: 1 })
  const sizeRef = useRef({ width: 0, height: 0 })
  const alphaRef = useRef(1)
  const hoverRef = useRef<number | null>(null)
  const dragRef = useRef<{ node: number | null; panning: boolean; startX: number; startY: number; moved: boolean }>({
    node: null,
    panning: false,
    startX: 0,
    startY: 0,
    moved: false,
  })
  const rafRef = useRef<number | null>(null)
  // Active pointers for multi-touch. We track each pointer's last canvas-local
  // position; once two are down we switch from pan/drag into pinch-zoom mode.
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  // Distance between the two pinching fingers on the previous move, used to derive
  // the incremental zoom factor. Null when not pinching.
  const pinchDistRef = useRef<number | null>(null)
  // Forward reference to the recenter callback (defined later) so scope-change
  // effects can re-center the camera without a declaration-order problem.
  const recenterRef = useRef<() => void>(() => {})

  const [counts, setCounts] = useState({ notes: 0, links: 0, truncated: 0 })

  const reheat = useCallback((value = 0.6) => {
    alphaRef.current = Math.max(alphaRef.current, value)
  }, [])

  const rebuild = useCallback(() => {
    const graph = buildGraph(application, scopeRef.current)
    // Preserve positions for nodes that still exist, so live updates don't jump.
    const previous = new Map(graphRef.current.nodes.map((n) => [n.uuid, n]))
    for (const node of graph.nodes) {
      const prev = previous.get(node.uuid)
      if (prev) {
        node.x = prev.x
        node.y = prev.y
      }
    }
    graphRef.current = graph
    if (containerRef.current) {
      colorsRef.current = readColors(containerRef.current)
    }
    setCounts({ notes: graph.nodes.length, links: graph.edges.length, truncated: graph.truncated })
    reheat(1)
  }, [application, reheat])

  const screenToWorld = useCallback(
    (screenX: number, screenY: number) => cameraScreenToWorld(cameraRef.current, screenX, screenY),
    [],
  )

  const nodeRadius = useCallback((node: GraphNode) => 3 + Math.min(9, Math.sqrt(node.degree) * 2.2), [])

  const hitTest = useCallback(
    (screenX: number, screenY: number): number | null => {
      const world = screenToWorld(screenX, screenY)
      const { nodes } = graphRef.current
      const scale = cameraRef.current.scale
      for (let i = nodes.length - 1; i >= 0; i--) {
        const node = nodes[i]
        const r = nodeRadius(node) + 4 / scale
        const dx = node.x - world.x
        const dy = node.y - world.y
        if (dx * dx + dy * dy <= r * r) {
          return i
        }
      }
      return null
    },
    [nodeRadius, screenToWorld],
  )

  // --- simulation + render loop ------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) {
      return
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }

    const resize = () => {
      const rect = container.getBoundingClientRect()
      const dpr = window.devicePixelRatio || 1
      sizeRef.current = { width: rect.width, height: rect.height }
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Re-center the camera on the graph origin.
      cameraRef.current.x = rect.width / 2 + (cameraRef.current.x - sizeRef.current.width / 2)
      reheat(0.3)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(container)
    // Initial center.
    const rect = container.getBoundingClientRect()
    cameraRef.current.x = rect.width / 2
    cameraRef.current.y = rect.height / 2
    resize()

    const step = () => {
      const { nodes, edges } = graphRef.current
      const alpha = alphaRef.current

      if (alpha > 0.01 && nodes.length > 0) {
        const repulsion = 1600 * alpha + 400
        const springLength = 70
        const springK = 0.025
        const centerK = 0.012
        const damping = 0.82
        const dragNode = dragRef.current.node

        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i]
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j]
            let dx = a.x - b.x
            let dy = a.y - b.y
            let d2 = dx * dx + dy * dy
            if (d2 < 0.01) {
              dx = (i - j) * 0.1 + 0.01
              dy = 0.1
              d2 = dx * dx + dy * dy
            }
            const d = Math.sqrt(d2)
            const f = repulsion / d2
            const fx = (dx / d) * f
            const fy = (dy / d) * f
            a.vx += fx
            a.vy += fy
            b.vx -= fx
            b.vy -= fy
          }
        }

        for (const e of edges) {
          const a = nodes[e.a]
          const b = nodes[e.b]
          let dx = b.x - a.x
          let dy = b.y - a.y
          const d = Math.sqrt(dx * dx + dy * dy) || 0.01
          const f = (d - springLength) * springK
          const fx = (dx / d) * f
          const fy = (dy / d) * f
          a.vx += fx
          a.vy += fy
          b.vx -= fx
          b.vy -= fy
        }

        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i]
          n.vx += -n.x * centerK
          n.vy += -n.y * centerK
          n.vx *= damping
          n.vy *= damping
          if (i !== dragNode) {
            n.x += n.vx * alpha
            n.y += n.vy * alpha
          }
        }

        alphaRef.current = alpha * 0.985
      }

      // --- draw ---
      const { width, height } = sizeRef.current
      const colors = colorsRef.current ?? readColors(container)
      const camera = cameraRef.current
      const hover = hoverRef.current
      ctx.clearRect(0, 0, width, height)
      ctx.save()
      ctx.translate(camera.x, camera.y)
      ctx.scale(camera.scale, camera.scale)

      const neighbors = new Set<number>()
      if (hover !== null) {
        for (const e of edges) {
          if (e.a === hover) neighbors.add(e.b)
          if (e.b === hover) neighbors.add(e.a)
        }
      }

      ctx.lineWidth = 1 / camera.scale
      for (const e of edges) {
        const a = nodes[e.a]
        const b = nodes[e.b]
        const active = hover !== null && (e.a === hover || e.b === hover)
        ctx.strokeStyle = active ? colors.edgeHi : colors.edge
        ctx.globalAlpha = hover !== null && !active ? 0.25 : 0.7
        ctx.beginPath()
        ctx.moveTo(a.x, a.y)
        ctx.lineTo(b.x, b.y)
        ctx.stroke()
      }
      ctx.globalAlpha = 1

      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        const isHover = i === hover
        const isNeighbor = neighbors.has(i)
        const dimmed = hover !== null && !isHover && !isNeighbor
        const r = nodeRadius(n)
        ctx.beginPath()
        ctx.arc(n.x, n.y, r, 0, Math.PI * 2)
        ctx.fillStyle = n.degree === 0 ? colors.nodeDim : colors.node
        ctx.globalAlpha = dimmed ? 0.3 : 1
        ctx.fill()
        if (isHover) {
          ctx.lineWidth = 2 / camera.scale
          ctx.strokeStyle = colors.label
          ctx.stroke()
        }
      }

      // Labels: for hovered node, its neighbors, and when zoomed in enough.
      ctx.globalAlpha = 1
      const showAllLabels = camera.scale > 1.4
      ctx.font = `${12 / camera.scale}px sans-serif`
      ctx.fillStyle = colors.label
      ctx.textAlign = 'center'
      ctx.textBaseline = 'top'
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]
        const isHover = i === hover
        if (!isHover && !neighbors.has(i) && !showAllLabels) {
          continue
        }
        if (hover !== null && !isHover && !neighbors.has(i)) {
          continue
        }
        const label = n.title.length > 28 ? `${n.title.slice(0, 27)}…` : n.title
        ctx.globalAlpha = isHover ? 1 : 0.85
        ctx.fillText(label, n.x, n.y + nodeRadius(n) + 2 / camera.scale)
      }
      ctx.globalAlpha = 1
      ctx.restore()

      rafRef.current = requestAnimationFrame(step)
    }

    rafRef.current = requestAnimationFrame(step)

    return () => {
      observer.disconnect()
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [nodeRadius, reheat])

  // --- data: build + live updates ----------------------------------------
  useEffect(() => {
    rebuild()
    const removeObserver = application.items.streamItems([ContentType.TYPES.Note], () => {
      rebuild()
    })
    return () => {
      removeObserver()
    }
  }, [application, rebuild])

  // When switching to a tag/folder scope with nothing selected, default to the
  // active note's first tag/folder if it has one, else the first available.
  useEffect(() => {
    if (scopeKind !== 'tag' && scopeKind !== 'folder') {
      return
    }
    if (collectionUuid) {
      return
    }
    const list: DecryptedItemInterface[] = scopeKind === 'tag' ? tags : folders
    if (list.length === 0) {
      return
    }
    let preferred: string | undefined
    if (activeNoteUuid) {
      const containing = list.find((collection) =>
        application.items
          .referencesForItem(collection, ContentType.TYPES.Note)
          .some((note) => note.uuid === activeNoteUuid),
      )
      preferred = containing?.uuid
    }
    setCollectionUuid(preferred ?? list[0].uuid)
  }, [scopeKind, collectionUuid, tags, folders, activeNoteUuid, application])

  // Rebuild whenever the scope, the selected collection, or (for the 'current'
  // scope) the active note changes. Computing on demand here — not continuously —
  // keeps the scoped sets cheap.
  useEffect(() => {
    rebuild()
    recenterRef.current()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeKind, collectionUuid, scopeKind === 'current' ? activeNoteUuid : undefined])

  // --- pointer interaction -----------------------------------------------
  const localPoint = (event: React.PointerEvent) => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const openNote = useCallback(
    (uuid: string) => {
      const note = application.items.findItem<SNNote>(uuid)
      if (!note) {
        return
      }
      application.itemListController.keepActiveItemOpenForSystemView(note.uuid)
      void application.itemListController.selectItemUsingInstance(note, true)
      presentPane(AppPaneId.Editor)
    },
    [application, presentPane],
  )

  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
      const { x, y } = localPoint(event)
      pointersRef.current.set(event.pointerId, { x, y })

      // Second finger down → enter pinch mode and cancel any in-progress
      // single-pointer pan/drag so they don't fight the zoom.
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()]
        pinchDistRef.current = Math.hypot(a.x - b.x, a.y - b.y)
        dragRef.current = { node: null, panning: false, startX: 0, startY: 0, moved: true }
        return
      }

      const node = hitTest(x, y)
      dragRef.current = { node, panning: node === null, startX: x, startY: y, moved: false }
      reheat(node !== null ? 0.5 : 0.1)
    },
    [hitTest, reheat],
  )

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const { x, y } = localPoint(event)

      // --- pinch-to-zoom -------------------------------------------------
      if (pointersRef.current.has(event.pointerId)) {
        pointersRef.current.set(event.pointerId, { x, y })
      }
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const prev = pinchDistRef.current
        if (prev && prev > 0 && dist > 0) {
          // Zoom centered on the midpoint between the two fingers.
          const midX = (a.x + b.x) / 2
          const midY = (a.y + b.y) / 2
          cameraRef.current = zoomByFactor(cameraRef.current, dist / prev, midX, midY)
        }
        pinchDistRef.current = dist
        return
      }

      const drag = dragRef.current
      if (drag.node === null && !drag.panning) {
        hoverRef.current = hitTest(x, y)
        return
      }
      if (Math.abs(x - drag.startX) > 3 || Math.abs(y - drag.startY) > 3) {
        drag.moved = true
      }
      if (drag.node !== null) {
        const world = screenToWorld(x, y)
        const n = graphRef.current.nodes[drag.node]
        if (n) {
          n.x = world.x
          n.y = world.y
          n.vx = 0
          n.vy = 0
        }
        reheat(0.4)
      } else if (drag.panning) {
        cameraRef.current.x += x - drag.startX
        cameraRef.current.y += y - drag.startY
        drag.startX = x
        drag.startY = y
      }
    },
    [hitTest, reheat, screenToWorld],
  )

  const onPointerUp = useCallback(
    (event: React.PointerEvent) => {
      const wasPinching = pointersRef.current.size === 2
      pointersRef.current.delete(event.pointerId)
      if (pointersRef.current.size < 2) {
        pinchDistRef.current = null
      }
      try {
        ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
      } catch {
        /* pointer already released */
      }
      // Lifting one finger out of a two-finger pinch must not be treated as a
      // click; leave the remaining pointer idle until it moves again.
      if (wasPinching) {
        dragRef.current = { node: null, panning: false, startX: 0, startY: 0, moved: true }
        return
      }

      const drag = dragRef.current
      if (!drag.moved) {
        if (drag.node !== null) {
          const node = graphRef.current.nodes[drag.node]
          if (node) {
            const note = application.items.findItem<SNNote>(node.uuid)
            const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
            setSelected({
              uuid: node.uuid,
              title: note?.title || node.title || 'Untitled',
              summary: (note?.preview_plain || '').slice(0, 240),
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            })
          }
        } else {
          setSelected(null)
        }
      }
      dragRef.current = { node: null, panning: false, startX: 0, startY: 0, moved: false }
    },
    [application],
  )

  const onPointerCancel = useCallback((event: React.PointerEvent) => {
    pointersRef.current.delete(event.pointerId)
    if (pointersRef.current.size < 2) {
      pinchDistRef.current = null
    }
    dragRef.current = { node: null, panning: false, startX: 0, startY: 0, moved: true }
  }, [])

  const recenter = useCallback(() => {
    const { width, height } = sizeRef.current
    cameraRef.current = { x: width / 2, y: height / 2, scale: 1 }
    reheat(0.6)
  }, [reheat])
  recenterRef.current = recenter

  // Zoom by a fixed step centered on the viewport, used by the +/- buttons.
  const zoomStep = useCallback((factor: number) => {
    const { width, height } = sizeRef.current
    cameraRef.current = zoomByFactor(cameraRef.current, factor, width / 2, height / 2)
  }, [])

  // Wheel zoom is wired up as a NON-PASSIVE native listener (below) so we can
  // preventDefault and stop the page from scrolling while zooming the graph.
  // React's synthetic onWheel can be passive depending on the bundler, which
  // would make preventDefault a no-op.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      const py = event.clientY - rect.top
      cameraRef.current = zoomToward(
        cameraRef.current,
        cameraRef.current.scale * wheelDeltaToFactor(event.deltaY),
        px,
        py,
      )
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
  }, [])

  return (
    <div
      id={id}
      ref={ref}
      className={classNames(
        className,
        'flex h-full flex-col overflow-hidden bg-default',
        standalone
          ? ''
          : position === 'left'
          ? 'border-r border-border'
          : position === 'bottom'
          ? 'border-t border-border'
          : 'border-l border-border',
      )}
    >
      <div className="flex items-center justify-between border-b border-border bg-contrast px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon type="star-filled" className="flex-shrink-0 text-info" />
          <span className="text-base font-bold">Constellation</span>
          <span className="ml-1 truncate text-xs text-neutral">
            {counts.notes} notes · {counts.links} links
            {counts.truncated > 0 ? ` · +${counts.truncated} hidden` : ''}
          </span>
        </div>
        <div className="flex flex-shrink-0 items-center gap-0.5">
          {!standalone && (
            <button
              className="rounded p-1 hover:bg-default"
              onClick={openOrFocusConstellationWindow}
              aria-label="Open in new window"
              title="Open in new window"
            >
              <Icon type="open-in" />
            </button>
          )}
          <button className="rounded p-1 hover:bg-default" onClick={recenter} aria-label="Recenter graph" title="Recenter">
            <Icon type="fullscreen-exit" />
          </button>
        </div>
      </div>

      {/* Scope tabs + collection selector. Wraps on small screens so it never
          overflows; the dropdown only appears for tag/folder scopes. */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-contrast px-3 py-2">
        <div role="tablist" aria-label="Constellation scope" className="flex flex-wrap gap-0.5 rounded bg-default p-0.5">
          {(
            [
              { kind: 'current', label: 'Current note' },
              { kind: 'global', label: 'Global' },
              { kind: 'tag', label: 'Topic' },
              { kind: 'folder', label: 'Folder' },
            ] as { kind: ConstellationScopeKind; label: string }[]
          ).map((tab) => (
            <button
              key={tab.kind}
              role="tab"
              aria-selected={scopeKind === tab.kind}
              className={classNames(
                'rounded px-2.5 py-1 text-xs font-semibold transition-colors',
                scopeKind === tab.kind ? 'bg-info text-info-contrast' : 'text-text hover:bg-contrast',
              )}
              onClick={() => changeScopeKind(tab.kind)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {(scopeKind === 'tag' || scopeKind === 'folder') && (
          <select
            className="min-w-0 max-w-[12rem] flex-grow truncate rounded border border-border bg-default px-2 py-1 text-xs text-text sm:flex-grow-0"
            value={collectionUuid ?? ''}
            onChange={(event) => setCollectionUuid(event.target.value || undefined)}
            aria-label={scopeKind === 'tag' ? 'Select topic' : 'Select folder'}
          >
            <option value="">{scopeKind === 'tag' ? 'Select a topic…' : 'Select a folder…'}</option>
            {(scopeKind === 'tag' ? tags : folders).map((collection) => (
              <option key={collection.uuid} value={collection.uuid}>
                {(collection as SNTag | SNFolder).title || 'Untitled'}
              </option>
            ))}
          </select>
        )}
      </div>

      <div ref={containerRef} className="relative flex-grow overflow-hidden">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 touch-none"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerLeave={() => {
            hoverRef.current = null
          }}
        />

        {/* Zoom controls. Bottom-right, unobtrusive; large enough to be tappable
            on touch devices without overlapping the note card (top-left/center). */}
        {counts.notes > 0 && (
          <div className="absolute bottom-3 right-3 z-10 flex flex-col gap-0.5 rounded-md border border-border bg-default/90 p-0.5 shadow-main backdrop-blur-sm">
            <button
              className="rounded p-1.5 hover:bg-contrast"
              onClick={() => zoomStep(1.25)}
              aria-label="Zoom in"
              title="Zoom in"
            >
              <Icon type="add" size="small" />
            </button>
            <button
              className="rounded p-1.5 hover:bg-contrast"
              onClick={() => zoomStep(1 / 1.25)}
              aria-label="Zoom out"
              title="Zoom out"
            >
              <Icon type="subtract" size="small" />
            </button>
            <button
              className="rounded p-1.5 hover:bg-contrast"
              onClick={recenter}
              aria-label="Fit graph to view"
              title="Reset zoom"
            >
              <Icon type="restore" size="small" />
            </button>
          </div>
        )}
        {counts.notes === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-neutral">
            {scopeKind === 'current'
              ? activeNoteUuid
                ? 'This note has no links yet. Link it to other notes to grow its neighborhood.'
                : 'Open a note to see its local constellation.'
              : scopeKind === 'tag'
              ? collectionUuid
                ? 'This topic has no notes yet.'
                : tags.length === 0
                ? 'No topics yet. Create a topic to filter the constellation.'
                : 'Select a topic to filter the constellation.'
              : scopeKind === 'folder'
              ? collectionUuid
                ? 'This folder has no notes yet.'
                : folders.length === 0
                ? 'No folders yet. Create a folder to filter the constellation.'
                : 'Select a folder to filter the constellation.'
              : 'No notes yet. Create notes and link them together to see your constellation.'}
          </div>
        )}
        {counts.notes > 0 && counts.links === 0 && (
          <div className="pointer-events-none absolute bottom-3 left-0 right-0 px-6 text-center text-xs text-neutral">
            No links yet — link notes from a note’s options to connect them.
          </div>
        )}
        {selected && (
          <div
            className="absolute z-10 w-64 max-w-[85%] overflow-hidden rounded-md border border-border bg-default shadow-main"
            style={{
              left: Math.max(8, Math.min(selected.x, (sizeRef.current.width || 400) - 264)),
              top: Math.max(8, Math.min(selected.y, (sizeRef.current.height || 400) - 168)),
            }}
          >
            <div className="flex items-start justify-between gap-2 border-b border-border bg-contrast px-3 py-2">
              <span className="break-words text-sm font-semibold text-text">{selected.title}</span>
              <button
                className="flex-shrink-0 text-passive-1 hover:text-danger"
                onClick={() => setSelected(null)}
                aria-label="Close"
                title="Close"
              >
                ×
              </button>
            </div>
            <div className="max-h-24 overflow-y-auto px-3 py-2 text-xs text-neutral">
              {selected.summary ? (
                <p className="whitespace-pre-wrap break-words">{selected.summary}</p>
              ) : (
                <p className="italic">No preview available.</p>
              )}
            </div>
            <div className="border-t border-border px-3 py-2">
              <button
                className="w-full rounded bg-info px-2 py-1 text-sm font-semibold text-info-contrast hover:opacity-90"
                onClick={() => {
                  openNote(selected.uuid)
                  setSelected(null)
                }}
              >
                Open note
              </button>
            </div>
          </div>
        )}
      </div>
      {children}
    </div>
  )
})

ConstellationView.displayName = 'ConstellationView'

export default observer(ConstellationView)
