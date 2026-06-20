/**
 * Map note document model (full-note editor).
 *
 * A Map note stores a node-graph diagram: a set of nodes positioned on a
 * canvas, connected either by explicit edges (mind maps / free graphs) or by a
 * `parentId` hierarchy (family trees / org charts). Both representations are
 * supported simultaneously and are backward/forward-compatible.
 *
 * Exactly like the Canvas, Base, Sandbox, Calendar, Kanban, Timeline, and
 * Flashcards note types, the serialized document is stored verbatim in
 * `note.text` (the same slot Super stores its Lexical JSON in). This keeps a Map
 * note round-tripping and syncing like any other note with no models/snjs
 * changes — the note is marked as a map purely via `note.editorIdentifier`.
 */

export const MAP_DOCUMENT_VERSION = 1

export type MapNode = {
  id: string
  text: string
  x: number
  y: number
  /** Optional themed accent color (one of the palette keys, or any CSS color). */
  color?: string
  /** Optional parent node id for tree-shaped maps (family trees). */
  parentId?: string
}

export type MapEdge = {
  from: string
  to: string
}

export type MapDocument = {
  version: number
  nodes: MapNode[]
  edges: MapEdge[]
}

export const createEmptyMapDocument = (): MapDocument => ({
  version: MAP_DOCUMENT_VERSION,
  nodes: [],
  edges: [],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const sanitizeNode = (raw: unknown): MapNode | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  const node: MapNode = {
    id: candidate.id,
    text: isString(candidate.text) ? candidate.text : '',
    x: isFiniteNumber(candidate.x) ? candidate.x : 0,
    y: isFiniteNumber(candidate.y) ? candidate.y : 0,
  }
  if (isString(candidate.color) && candidate.color.length > 0) {
    node.color = candidate.color
  }
  if (isString(candidate.parentId) && candidate.parentId.length > 0) {
    node.parentId = candidate.parentId
  }
  return node
}

const sanitizeEdge = (raw: unknown): MapEdge | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.from !== 'string' || candidate.from.length === 0) {
    return null
  }
  if (typeof candidate.to !== 'string' || candidate.to.length === 0) {
    return null
  }
  return { from: candidate.from, to: candidate.to }
}

/**
 * Normalize a map document: drop nodes without ids, dedupe node ids (first
 * wins), clear `parentId` references that point to missing nodes, and drop
 * edges whose endpoints don't both exist or that are self-loops/duplicates.
 */
export const normalizeMapDocument = (nodes: MapNode[], edges: MapEdge[], version?: number): MapDocument => {
  const seenIds = new Set<string>()
  const keptNodes: MapNode[] = []
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      continue
    }
    seenIds.add(node.id)
    keptNodes.push(node)
  }

  // Clear dangling parent references.
  for (const node of keptNodes) {
    if (node.parentId && !seenIds.has(node.parentId)) {
      delete node.parentId
    }
  }

  const seenEdges = new Set<string>()
  const keptEdges: MapEdge[] = []
  for (const edge of edges) {
    if (edge.from === edge.to) {
      continue
    }
    if (!seenIds.has(edge.from) || !seenIds.has(edge.to)) {
      continue
    }
    // Treat edges as undirected for dedup purposes.
    const key = edge.from < edge.to ? `${edge.from}|${edge.to}` : `${edge.to}|${edge.from}`
    if (seenEdges.has(key)) {
      continue
    }
    seenEdges.add(key)
    keptEdges.push(edge)
  }

  return {
    version: isFiniteNumber(version) ? version : MAP_DOCUMENT_VERSION,
    nodes: keptNodes,
    edges: keptEdges,
  }
}

/**
 * Parse note text into a MapDocument. Never throws: empty, legacy plain text,
 * or otherwise malformed JSON all fall back to an empty map. The second return
 * value reports whether the input was recoverable map JSON so the editor can
 * surface a non-destructive notice when content was discarded.
 */
export const parseMapDocument = (
  text: string | undefined | null,
): { document: MapDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyMapDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyMapDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyMapDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A map document must at least expose a nodes array; otherwise it is probably
  // some other note format being switched into Map, so treat it as a fresh map
  // but flag it as not-recovered.
  const looksLikeMap = Array.isArray(candidate.nodes)
  if (!looksLikeMap) {
    return { document: createEmptyMapDocument(), recovered: false }
  }

  const nodes: MapNode[] = []
  for (const rawNode of candidate.nodes as unknown[]) {
    const node = sanitizeNode(rawNode)
    if (node) {
      nodes.push(node)
    }
  }

  const edges: MapEdge[] = []
  if (Array.isArray(candidate.edges)) {
    for (const rawEdge of candidate.edges as unknown[]) {
      const edge = sanitizeEdge(rawEdge)
      if (edge) {
        edges.push(edge)
      }
    }
  }

  const version = isFiniteNumber(candidate.version) ? candidate.version : MAP_DOCUMENT_VERSION

  return {
    document: normalizeMapDocument(nodes, edges, version),
    recovered: true,
  }
}

/** Serialize a MapDocument to the string stored in `note.text`. */
export const serializeMapDocument = (document: MapDocument): string => {
  return JSON.stringify({
    version: document.version ?? MAP_DOCUMENT_VERSION,
    nodes: document.nodes.map((node) => ({
      id: node.id,
      text: node.text ?? '',
      x: node.x,
      y: node.y,
      ...(node.color !== undefined ? { color: node.color } : {}),
      ...(node.parentId !== undefined ? { parentId: node.parentId } : {}),
    })),
    edges: document.edges.map((edge) => ({ from: edge.from, to: edge.to })),
  })
}

// --- mutators (pure; return a new normalized document) ---------------------

/** Add a free-floating node at the given position. */
export const addNode = (doc: MapDocument, x: number, y: number, text = ''): MapDocument => {
  const node: MapNode = { id: createMapId('node'), text, x, y }
  return normalizeMapDocument([...doc.nodes, node], doc.edges, doc.version)
}

/**
 * Add a child node connected to `parentId` via both `parentId` (tree) and an
 * explicit edge (graph). Auto-positioned just below-right of the parent.
 */
export const addChildNode = (doc: MapDocument, parentId: string, text = ''): MapDocument => {
  const parent = doc.nodes.find((n) => n.id === parentId)
  if (!parent) {
    return doc
  }
  const childCount = doc.nodes.filter((n) => n.parentId === parentId).length
  const child: MapNode = {
    id: createMapId('node'),
    text,
    x: parent.x + (childCount - 1) * 160,
    y: parent.y + 120,
    parentId,
  }
  return normalizeMapDocument(
    [...doc.nodes, child],
    [...doc.edges, { from: parentId, to: child.id }],
    doc.version,
  )
}

/** Update a node's text. */
export const setNodeText = (doc: MapDocument, id: string, text: string): MapDocument =>
  normalizeMapDocument(
    doc.nodes.map((n) => (n.id === id ? { ...n, text } : n)),
    doc.edges,
    doc.version,
  )

/** Move a node to a new position. */
export const moveNode = (doc: MapDocument, id: string, x: number, y: number): MapDocument =>
  normalizeMapDocument(
    doc.nodes.map((n) => (n.id === id ? { ...n, x, y } : n)),
    doc.edges,
    doc.version,
  )

/** Recolor a node (undefined clears the color). */
export const setNodeColor = (doc: MapDocument, id: string, color: string | undefined): MapDocument =>
  normalizeMapDocument(
    doc.nodes.map((n) => (n.id === id ? { ...n, color } : n)),
    doc.edges,
    doc.version,
  )

/**
 * Delete a node, removing it from the node list, clearing it as a parent of any
 * children, and pruning every edge that touched it (dangling-edge cleanup).
 */
export const deleteNode = (doc: MapDocument, id: string): MapDocument => {
  const nodes = doc.nodes
    .filter((n) => n.id !== id)
    .map((n) => (n.parentId === id ? { ...n, parentId: undefined } : n))
  const edges = doc.edges.filter((e) => e.from !== id && e.to !== id)
  return normalizeMapDocument(nodes, edges, doc.version)
}

/** Connect two nodes with an undirected edge (no-op if already connected). */
export const connectNodes = (doc: MapDocument, from: string, to: string): MapDocument => {
  if (from === to) {
    return doc
  }
  return normalizeMapDocument(doc.nodes, [...doc.edges, { from, to }], doc.version)
}

// --- templates -------------------------------------------------------------

/** Central root with radial children — a mind map starter. */
export const createMindMapStarter = (): MapDocument => {
  const cx = 400
  const cy = 300
  const root: MapNode = { id: createMapId('node'), text: 'Central idea', x: cx, y: cy, color: 'info' }
  const branchLabels = ['Topic 1', 'Topic 2', 'Topic 3', 'Topic 4']
  const radius = 200
  const nodes: MapNode[] = [root]
  const edges: MapEdge[] = []
  branchLabels.forEach((label, index) => {
    const angle = (index / branchLabels.length) * Math.PI * 2 - Math.PI / 2
    const child: MapNode = {
      id: createMapId('node'),
      text: label,
      x: Math.round(cx + Math.cos(angle) * radius),
      y: Math.round(cy + Math.sin(angle) * radius),
    }
    nodes.push(child)
    edges.push({ from: root.id, to: child.id })
  })
  return normalizeMapDocument(nodes, edges)
}

/** Top root with generational children — a family-tree starter. */
export const createFamilyTreeStarter = (): MapDocument => {
  const root: MapNode = { id: createMapId('node'), text: 'You', x: 400, y: 120, color: 'info' }
  const parentLabels = ['Parent', 'Parent']
  const nodes: MapNode[] = [root]
  const edges: MapEdge[] = []
  parentLabels.forEach((label, index) => {
    const child: MapNode = {
      id: createMapId('node'),
      text: label,
      x: 280 + index * 240,
      y: 280,
      parentId: root.id,
    }
    nodes.push(child)
    edges.push({ from: root.id, to: child.id })
  })
  return normalizeMapDocument(nodes, edges)
}

/**
 * A lightweight auto-arrange for tree-shaped maps: lay nodes out top-down by
 * generation (using `parentId`), spacing siblings evenly. Nodes without a
 * parent become roots. Returns a new document; leaves non-tree-connected nodes
 * where they are.
 */
export const autoArrangeTree = (doc: MapDocument): MapDocument => {
  const childrenByParent = new Map<string | undefined, MapNode[]>()
  for (const node of doc.nodes) {
    const key = node.parentId
    const list = childrenByParent.get(key) ?? []
    list.push(node)
    childrenByParent.set(key, list)
  }

  const positions = new Map<string, { x: number; y: number }>()
  const levelHeight = 130
  const nodeWidth = 170
  let nextLeafX = 0

  // Post-order assignment: a parent centers over its children; leaves take the
  // next horizontal slot.
  const assign = (node: MapNode, depth: number): number => {
    const children = childrenByParent.get(node.id) ?? []
    if (children.length === 0) {
      const x = nextLeafX * nodeWidth
      nextLeafX += 1
      positions.set(node.id, { x, y: depth * levelHeight })
      return x
    }
    const childXs = children.map((child) => assign(child, depth + 1))
    const x = (Math.min(...childXs) + Math.max(...childXs)) / 2
    positions.set(node.id, { x, y: depth * levelHeight })
    return x
  }

  const roots = childrenByParent.get(undefined) ?? []
  for (const root of roots) {
    assign(root, 0)
  }

  const offsetX = 200
  const offsetY = 80
  const nodes = doc.nodes.map((node) => {
    const pos = positions.get(node.id)
    return pos ? { ...node, x: Math.round(pos.x + offsetX), y: Math.round(pos.y + offsetY) } : node
  })

  return normalizeMapDocument(nodes, doc.edges, doc.version)
}

let idCounter = 0
/** Lightweight unique id generator for nodes (no crypto dependency). */
export function createMapId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
