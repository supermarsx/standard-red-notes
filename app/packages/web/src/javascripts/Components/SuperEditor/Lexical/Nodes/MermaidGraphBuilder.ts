/**
 * Pure-logic helpers for the Mermaid GRAPHICAL builder and the Templates
 * dropdown. Kept free of React/Lexical so they can be unit-tested in isolation
 * and reused by MermaidNode.tsx.
 *
 * The graphical builder is "bidirectional-lite": building NODES/EDGES in the
 * form generates valid flowchart mermaid source via buildFlowchartSource().
 * Hand-edited code is NOT fully reverse-parsed back into the form model;
 * parseFlowchartSource() is a best-effort parser for simple `graph TD`
 * flowcharts only (the kind this builder emits). Anything it cannot understand
 * is left to the code editor.
 */

/** A node in the graphical flowchart builder. */
export interface MermaidGraphNode {
  /** Identifier used in mermaid source (e.g. `A`). Must be unique. */
  id: string
  /** Human label shown inside the box. Falls back to the id when empty. */
  label: string
}

/** A directed edge between two node ids, with an optional label. */
export interface MermaidGraphEdge {
  from: string
  to: string
  label: string
}

/** Layout directions supported by the builder, matching mermaid's flowchart keywords. */
export const MERMAID_GRAPH_DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const
export type MermaidGraphDirection = (typeof MERMAID_GRAPH_DIRECTIONS)[number]
export const DEFAULT_MERMAID_GRAPH_DIRECTION: MermaidGraphDirection = 'TD'

/** The full editable model behind the graphical builder. */
export interface MermaidGraphModel {
  direction: MermaidGraphDirection
  nodes: MermaidGraphNode[]
  edges: MermaidGraphEdge[]
}

function isDirection(value: unknown): value is MermaidGraphDirection {
  return typeof value === 'string' && (MERMAID_GRAPH_DIRECTIONS as readonly string[]).includes(value)
}

/**
 * Escapes a label for use inside a `["..."]` node box. Mermaid treats double
 * quotes specially, so we wrap labels in quotes and replace embedded quotes
 * with the HTML entity it understands.
 */
function escapeLabel(label: string): string {
  return label.replace(/"/g, '&quot;')
}

/**
 * Sanitizes an edge label so it cannot break the `-->|...|` syntax. Pipes and
 * newlines are replaced with spaces.
 */
function escapeEdgeLabel(label: string): string {
  return label.replace(/[|\r\n]+/g, ' ').trim()
}

/**
 * Sanitizes a node id so it is a safe mermaid identifier. Non-identifier
 * characters become underscores; an empty result falls back to `n`.
 */
export function sanitizeNodeId(id: string): string {
  const cleaned = String(id ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_]/g, '_')
  return cleaned.length > 0 ? cleaned : 'n'
}

/** Generates the next free single/multi-letter id (A, B, ... Z, A1, B1, ...). */
export function nextNodeId(existing: MermaidGraphNode[]): string {
  const taken = new Set(existing.map((n) => n.id))
  let suffix = 0
  // First pass A..Z, then A1..Z1, etc.
  for (;;) {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      const candidate = suffix === 0 ? letter : `${letter}${suffix}`
      if (!taken.has(candidate)) {
        return candidate
      }
    }
    suffix++
  }
}

/** An empty model used when a fresh graphical builder is opened. */
export function createEmptyGraphModel(): MermaidGraphModel {
  return { direction: DEFAULT_MERMAID_GRAPH_DIRECTION, nodes: [], edges: [] }
}

/**
 * Builds valid flowchart mermaid source from the graphical model. Produces
 * lines like:
 *
 *   graph TD
 *     A["Start"]
 *     B["End"]
 *     A -->|yes| B
 *
 * Edges referencing unknown node ids are dropped so the output always renders.
 */
export function buildFlowchartSource(model: MermaidGraphModel): string {
  const direction = isDirection(model?.direction) ? model.direction : DEFAULT_MERMAID_GRAPH_DIRECTION
  const nodes = Array.isArray(model?.nodes) ? model.nodes : []
  const edges = Array.isArray(model?.edges) ? model.edges : []

  const lines: string[] = [`graph ${direction}`]
  const knownIds = new Set<string>()

  for (const node of nodes) {
    const id = sanitizeNodeId(node?.id)
    if (knownIds.has(id)) {
      continue
    }
    knownIds.add(id)
    const label = typeof node?.label === 'string' && node.label.trim().length > 0 ? node.label : id
    lines.push(`  ${id}["${escapeLabel(label)}"]`)
  }

  for (const edge of edges) {
    const from = sanitizeNodeId(edge?.from)
    const to = sanitizeNodeId(edge?.to)
    if (!knownIds.has(from) || !knownIds.has(to)) {
      continue
    }
    const label = escapeEdgeLabel(typeof edge?.label === 'string' ? edge.label : '')
    if (label) {
      lines.push(`  ${from} -->|${label}| ${to}`)
    } else {
      lines.push(`  ${from} --> ${to}`)
    }
  }

  return lines.join('\n')
}

/**
 * Best-effort reverse parser for the SIMPLE `graph <dir>` flowcharts this
 * builder emits. Recognizes:
 *   - the `graph TD` / `flowchart LR` header (direction)
 *   - `A["Label"]`, `A[Label]`, `A` node declarations
 *   - `A --> B` and `A -->|label| B` edges
 *
 * Returns null when the source is not a recognizable flowchart (e.g. a sequence
 * diagram, gantt, etc.) so callers can keep the user in the code editor instead
 * of clobbering content they cannot represent.
 */
export function parseFlowchartSource(source: string): MermaidGraphModel | null {
  if (typeof source !== 'string') {
    return null
  }
  const rawLines = source.split(/\r?\n/)
  let direction: MermaidGraphDirection = DEFAULT_MERMAID_GRAPH_DIRECTION
  let sawHeader = false

  const nodeMap = new Map<string, MermaidGraphNode>()
  const edges: MermaidGraphEdge[] = []

  const ensureNode = (id: string, label?: string): void => {
    const existing = nodeMap.get(id)
    if (existing) {
      if (label && existing.label === existing.id) {
        existing.label = label
      }
      return
    }
    nodeMap.set(id, { id, label: label && label.length > 0 ? label : id })
  }

  const headerRe = /^\s*(?:graph|flowchart)\s+(TD|TB|LR|BT|RL)\b/i
  // Edge: ID [shape]? --> |label|? ID [shape]?
  const edgeRe =
    /^\s*([A-Za-z0-9_]+)(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*-->\s*(?:\|([^|]*)\|\s*)?([A-Za-z0-9_]+)(?:\[[^\]]*\]|\([^)]*\)|\{[^}]*\})?\s*$/
  // Standalone node declarations with a box `[..]`, rounded `(..)` or rhombus
  // `{..}` shape. The shape is not preserved on round-trip (the builder only
  // emits `[..]`), but the node + label are recovered so templates with
  // decision nodes still load.
  const nodeRe = /^\s*([A-Za-z0-9_]+)\s*(?:\[\s*"?([^"\]]*)"?\s*\]|\(\s*"?([^")]*)"?\s*\)|\{\s*"?([^"}]*)"?\s*\})\s*$/
  const bareIdRe = /^\s*([A-Za-z0-9_]+)\s*$/

  for (const line of rawLines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('%%')) {
      continue
    }

    const header = headerRe.exec(trimmed)
    if (header) {
      sawHeader = true
      const dir = header[1].toUpperCase()
      // Mermaid treats TB as an alias of TD.
      direction = isDirection(dir) ? dir : dir === 'TB' ? 'TD' : DEFAULT_MERMAID_GRAPH_DIRECTION
      continue
    }

    const edgeMatch = edgeRe.exec(trimmed)
    if (edgeMatch) {
      const from = edgeMatch[1]
      const label = (edgeMatch[2] ?? '').trim()
      const to = edgeMatch[3]
      // Pull labels out of inline shapes if present.
      const fromLabel = extractInlineLabel(trimmed, from)
      const toLabel = extractInlineLabel(trimmed, to)
      ensureNode(from, fromLabel)
      ensureNode(to, toLabel)
      edges.push({ from, to, label })
      continue
    }

    const nodeMatch = nodeRe.exec(trimmed)
    if (nodeMatch) {
      const label = (nodeMatch[2] ?? nodeMatch[3] ?? nodeMatch[4] ?? '').trim()
      ensureNode(nodeMatch[1], label)
      continue
    }

    const bareMatch = bareIdRe.exec(trimmed)
    if (bareMatch && !/^(graph|flowchart|subgraph|end)$/i.test(bareMatch[1])) {
      ensureNode(bareMatch[1])
      continue
    }

    // Unrecognized non-trivial line -> not a simple flowchart we can round-trip.
    return null
  }

  if (!sawHeader) {
    return null
  }

  return { direction, nodes: Array.from(nodeMap.values()), edges }
}

/** Pulls a `Label` out of the first `id[...]` occurrence on a line, if any. */
function extractInlineLabel(line: string, id: string): string | undefined {
  const re = new RegExp(`\\b${id}\\s*\\[\\s*"?([^"\\]]*)"?\\s*\\]`)
  const m = re.exec(line)
  if (m) {
    const label = m[1].trim()
    return label.length > 0 ? label : undefined
  }
  return undefined
}

/** A starter diagram offered by the Templates dropdown. */
export interface MermaidTemplate {
  id: string
  label: string
  source: string
}

/**
 * Curated starter diagrams. Each replaces the entire source when chosen. These
 * are intentionally small and valid so they render immediately.
 */
export const MERMAID_TEMPLATES: MermaidTemplate[] = [
  {
    id: 'org-chart',
    label: 'Org chart',
    source: [
      'graph TD',
      '  CEO["CEO"]',
      '  CTO["CTO"]',
      '  CFO["CFO"]',
      '  ENG["Engineering"]',
      '  FIN["Finance"]',
      '  CEO --> CTO',
      '  CEO --> CFO',
      '  CTO --> ENG',
      '  CFO --> FIN',
    ].join('\n'),
  },
  {
    id: 'shareholders',
    label: 'Company shareholders',
    source: [
      'graph TD',
      '  CO["Company"]',
      '  F["Founders 40%"]',
      '  VC["Investors 35%"]',
      '  EMP["Employee pool 15%"]',
      '  OTH["Other 10%"]',
      '  F --> CO',
      '  VC --> CO',
      '  EMP --> CO',
      '  OTH --> CO',
    ].join('\n'),
  },
  {
    id: 'process-workflow',
    label: 'Process workflow',
    source: [
      'graph LR',
      '  A["Intake"]',
      '  B["Review"]',
      '  C{"Approved?"}',
      '  D["Publish"]',
      '  E["Revise"]',
      '  A --> B',
      '  B --> C',
      '  C -->|Yes| D',
      '  C -->|No| E',
      '  E --> B',
    ].join('\n'),
  },
  {
    id: 'flowchart',
    label: 'Flowchart',
    source: [
      'graph TD',
      '  A["Start"]',
      '  B{"Decision"}',
      '  C["OK"]',
      '  D["Rethink"]',
      '  A --> B',
      '  B -->|Yes| C',
      '  B -->|No| D',
    ].join('\n'),
  },
  {
    id: 'sequence',
    label: 'Sequence',
    source: [
      'sequenceDiagram',
      '  participant U as User',
      '  participant S as Server',
      '  U->>S: Request',
      '  S-->>U: Response',
    ].join('\n'),
  },
]

/** Looks up a template's source by id, or undefined if unknown. */
export function getTemplateSource(id: string): string | undefined {
  return MERMAID_TEMPLATES.find((t) => t.id === id)?.source
}
