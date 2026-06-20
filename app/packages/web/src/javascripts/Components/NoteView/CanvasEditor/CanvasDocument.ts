/**
 * Canvas note document model.
 *
 * The schema is intentionally close in spirit to Obsidian's `.canvas` JSON
 * (nodes + edges, each node has x/y/width/height/text, edges connect node ids
 * with optional side anchors) so it feels familiar, but it is our own format
 * and we own its evolution via the `version` field.
 *
 * The serialized document is stored verbatim in `note.text` exactly how the
 * Super editor stores its Lexical JSON in `note.text`. This means a Canvas note
 * round-trips and syncs like any other note with no models/snjs changes.
 */

export const CANVAS_DOCUMENT_VERSION = 1

export type CanvasNodeSide = 'top' | 'right' | 'bottom' | 'left'

export type CanvasNode = {
  id: string
  x: number
  y: number
  width: number
  height: number
  text: string
  /** Optional CSS color string for the card background accent. */
  color?: string
}

export type CanvasEdge = {
  id: string
  fromNode: string
  toNode: string
  fromSide?: CanvasNodeSide
  toSide?: CanvasNodeSide
}

export type CanvasDocument = {
  version: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
}

export const createEmptyCanvasDocument = (): CanvasDocument => ({
  version: CANVAS_DOCUMENT_VERSION,
  nodes: [],
  edges: [],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isValidSide = (value: unknown): value is CanvasNodeSide =>
  value === 'top' || value === 'right' || value === 'bottom' || value === 'left'

const sanitizeNode = (raw: unknown): CanvasNode | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const candidate = raw as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }

  return {
    id: candidate.id,
    x: isFiniteNumber(candidate.x) ? candidate.x : 0,
    y: isFiniteNumber(candidate.y) ? candidate.y : 0,
    width: isFiniteNumber(candidate.width) && candidate.width > 0 ? candidate.width : 200,
    height: isFiniteNumber(candidate.height) && candidate.height > 0 ? candidate.height : 100,
    text: typeof candidate.text === 'string' ? candidate.text : '',
    color: typeof candidate.color === 'string' ? candidate.color : undefined,
  }
}

const sanitizeEdge = (raw: unknown, validNodeIds: Set<string>): CanvasEdge | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }

  const candidate = raw as Record<string, unknown>

  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }

  if (typeof candidate.fromNode !== 'string' || typeof candidate.toNode !== 'string') {
    return null
  }

  // Drop edges that reference nodes that no longer exist so the canvas never
  // renders dangling connectors.
  if (!validNodeIds.has(candidate.fromNode) || !validNodeIds.has(candidate.toNode)) {
    return null
  }

  return {
    id: candidate.id,
    fromNode: candidate.fromNode,
    toNode: candidate.toNode,
    fromSide: isValidSide(candidate.fromSide) ? candidate.fromSide : undefined,
    toSide: isValidSide(candidate.toSide) ? candidate.toSide : undefined,
  }
}

/**
 * Parse note text into a CanvasDocument. Never throws: empty, legacy plain
 * text, or otherwise malformed JSON all fall back to an empty canvas. The
 * second return value reports whether the input was recoverable canvas JSON so
 * the editor can surface a non-destructive notice when content was discarded.
 */
export const parseCanvasDocument = (
  text: string | undefined | null,
): { document: CanvasDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyCanvasDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyCanvasDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyCanvasDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>
  const rawNodes = Array.isArray(candidate.nodes) ? candidate.nodes : []
  const rawEdges = Array.isArray(candidate.edges) ? candidate.edges : []

  // A canvas document must at least expose nodes/edges arrays; otherwise it is
  // probably some other note format being switched into Canvas, so treat it as
  // a fresh board but flag it as not-recovered.
  const looksLikeCanvas = Array.isArray(candidate.nodes) || Array.isArray(candidate.edges)

  const nodes: CanvasNode[] = []
  const seenNodeIds = new Set<string>()
  for (const rawNode of rawNodes) {
    const node = sanitizeNode(rawNode)
    if (node && !seenNodeIds.has(node.id)) {
      seenNodeIds.add(node.id)
      nodes.push(node)
    }
  }

  const edges: CanvasEdge[] = []
  const seenEdgeIds = new Set<string>()
  for (const rawEdge of rawEdges) {
    const edge = sanitizeEdge(rawEdge, seenNodeIds)
    if (edge && !seenEdgeIds.has(edge.id)) {
      seenEdgeIds.add(edge.id)
      edges.push(edge)
    }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : CANVAS_DOCUMENT_VERSION,
      nodes,
      edges,
    },
    recovered: looksLikeCanvas,
  }
}

/** Serialize a CanvasDocument to the string stored in `note.text`. */
export const serializeCanvasDocument = (document: CanvasDocument): string => {
  return JSON.stringify({
    version: document.version ?? CANVAS_DOCUMENT_VERSION,
    nodes: document.nodes,
    edges: document.edges,
  })
}

let idCounter = 0
/** Lightweight unique id generator for nodes/edges (no crypto dependency). */
export const createCanvasId = (prefix: string): string => {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
