/**
 * Pure-logic helpers for the Mermaid VISUAL builder and the Templates dropdown.
 * Kept free of React/Lexical so they can be unit-tested in isolation and reused
 * by MermaidNode.tsx (the chart's own builder pane) and by MermaidSettingsPanel
 * (the editor toolbar's build actions).
 *
 * SCOPE, stated once and repeated in the UI: the builder models FLOWCHARTS
 * (`graph` / `flowchart`). Nothing else. `analyzeMermaidSource` names the type it
 * found and the specific reasons it cannot model a source, so a surface can say
 * "this is a sequence diagram" rather than silently starting from an empty model.
 *
 * SOURCE PRESERVATION is the hard constraint here. A visual edit regenerates the
 * source, so anything the model does not carry is destroyed. Previously that
 * included `%%` comments and every node shape other than a plain box — both lost
 * with no warning at all, because the parse "succeeded". So the model now
 * carries:
 *
 *   - `preamble` — YAML frontmatter and leading comments, verbatim;
 *   - `shape` per node — box, rounded, pill, subroutine, database, circle,
 *     decision, hexagon;
 *   - `kind` per edge — arrow, line, dotted, thick;
 *   - `extras` — classDef / class / style / linkStyle / click and any comment
 *     after the header, verbatim and in order.
 *
 * Anything STILL outside that (a subgraph, an unknown statement) makes
 * `parseFlowchartSource` return null, which is the signal for a surface to block
 * the builder rather than overwrite the source. Honest degradation beats a
 * builder that pretends.
 */

/** The node shapes the builder models, by mermaid's own delimiters. */
export const MERMAID_NODE_SHAPES = [
  'rect',
  'round',
  'stadium',
  'subroutine',
  'cylinder',
  'circle',
  'rhombus',
  'hexagon',
] as const
export type MermaidNodeShape = (typeof MERMAID_NODE_SHAPES)[number]
export const DEFAULT_MERMAID_NODE_SHAPE: MermaidNodeShape = 'rect'

/** Human labels for the shape picker. */
export const MERMAID_NODE_SHAPE_LABELS: Record<MermaidNodeShape, string> = {
  rect: 'Box',
  round: 'Rounded',
  stadium: 'Pill',
  subroutine: 'Subroutine',
  cylinder: 'Database',
  circle: 'Circle',
  rhombus: 'Decision',
  hexagon: 'Hexagon',
}

/**
 * Delimiters, ordered MOST SPECIFIC FIRST. The order is load-bearing for
 * parsing: a stadium node must be read as a stadium and not as a round node
 * whose label happens to start with a bracket, so every two-character opener is
 * tried before every one-character opener.
 */
const SHAPE_DELIMITERS: { shape: MermaidNodeShape; open: string; close: string }[] = [
  { shape: 'circle', open: '((', close: '))' },
  { shape: 'stadium', open: '([', close: '])' },
  { shape: 'subroutine', open: '[[', close: ']]' },
  { shape: 'cylinder', open: '[(', close: ')]' },
  { shape: 'hexagon', open: '{{', close: '}}' },
  { shape: 'rect', open: '[', close: ']' },
  { shape: 'round', open: '(', close: ')' },
  { shape: 'rhombus', open: '{', close: '}' },
]

/** The opening/closing delimiter pair a shape is written with. */
export function shapeDelimiters(shape: MermaidNodeShape): { open: string; close: string } {
  const found = SHAPE_DELIMITERS.find((candidate) => candidate.shape === shape)
  return found ? { open: found.open, close: found.close } : { open: '[', close: ']' }
}

function isNodeShape(value: unknown): value is MermaidNodeShape {
  return typeof value === 'string' && (MERMAID_NODE_SHAPES as readonly string[]).includes(value)
}

/** The link styles the builder models. */
export const MERMAID_EDGE_KINDS = ['arrow', 'open', 'dotted', 'thick'] as const
export type MermaidEdgeKind = (typeof MERMAID_EDGE_KINDS)[number]
export const DEFAULT_MERMAID_EDGE_KIND: MermaidEdgeKind = 'arrow'

export const MERMAID_EDGE_KIND_LABELS: Record<MermaidEdgeKind, string> = {
  arrow: 'Arrow',
  open: 'Line',
  dotted: 'Dotted',
  thick: 'Thick',
}

/**
 * Connectors, ordered MOST SPECIFIC FIRST for the same reason the shapes are:
 * the dotted connector contains the arrow's own tail, and a plain arrow must not
 * be read out of a longer run of dashes.
 */
const EDGE_CONNECTORS: { kind: MermaidEdgeKind; connector: string }[] = [
  { kind: 'dotted', connector: '-.->' },
  { kind: 'thick', connector: '==>' },
  { kind: 'arrow', connector: '-->' },
  { kind: 'open', connector: '---' },
]

/** The connector string a link kind is written with. */
export function edgeConnector(kind: MermaidEdgeKind): string {
  return EDGE_CONNECTORS.find((candidate) => candidate.kind === kind)?.connector ?? '-->'
}

function isEdgeKind(value: unknown): value is MermaidEdgeKind {
  return typeof value === 'string' && (MERMAID_EDGE_KINDS as readonly string[]).includes(value)
}

/** A node in the visual flowchart builder. */
export interface MermaidGraphNode {
  /** Identifier used in mermaid source (e.g. `A`). Must be unique. */
  id: string
  /** Human label shown inside the box. Falls back to the id when empty. */
  label: string
  /** Absent means the default box — so an older caller still type-checks. */
  shape?: MermaidNodeShape
}

/** A directed edge between two node ids, with an optional label. */
export interface MermaidGraphEdge {
  from: string
  to: string
  label: string
  /** Absent means a plain arrow. */
  kind?: MermaidEdgeKind
}

/** Layout directions supported by the builder, matching mermaid's flowchart keywords. */
export const MERMAID_GRAPH_DIRECTIONS = ['TD', 'LR', 'BT', 'RL'] as const
export type MermaidGraphDirection = (typeof MERMAID_GRAPH_DIRECTIONS)[number]
export const DEFAULT_MERMAID_GRAPH_DIRECTION: MermaidGraphDirection = 'TD'

/** The full editable model behind the visual builder. */
export interface MermaidGraphModel {
  direction: MermaidGraphDirection
  nodes: MermaidGraphNode[]
  edges: MermaidGraphEdge[]
  /**
   * Everything BEFORE the header, verbatim: YAML frontmatter (which carries the
   * diagram's title and per-diagram config) and leading comments. Re-emitted
   * unchanged.
   */
  preamble?: string[]
  /**
   * Statements the builder preserves but does not model — classDef, class,
   * style, linkStyle, click, and comments after the header. Verbatim, in source
   * order, re-emitted after the generated body.
   */
  extras?: string[]
}

function isDirection(value: unknown): value is MermaidGraphDirection {
  return typeof value === 'string' && (MERMAID_GRAPH_DIRECTIONS as readonly string[]).includes(value)
}

/**
 * Escapes a label for use inside a shaped node. Mermaid treats double quotes
 * specially, so we wrap labels in quotes and replace embedded quotes with the
 * HTML entity it understands.
 */
function escapeLabel(label: string): string {
  return label.replace(/"/g, '&quot;')
}

/**
 * Sanitizes an edge label so it cannot break the pipe-delimited link label
 * syntax. Pipes and newlines are replaced with spaces.
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

/** An empty model used when a fresh builder is opened. */
export function createEmptyGraphModel(): MermaidGraphModel {
  return { direction: DEFAULT_MERMAID_GRAPH_DIRECTION, nodes: [], edges: [], preamble: [], extras: [] }
}

/**
 * Builds valid flowchart mermaid source from the visual model: the preserved
 * preamble, the header, one line per node in its own shape, one line per link in
 * its own kind, then the preserved styling statements.
 *
 * Edges referencing unknown node ids are dropped so the output always renders.
 */
export function buildFlowchartSource(model: MermaidGraphModel): string {
  const direction = isDirection(model?.direction) ? model.direction : DEFAULT_MERMAID_GRAPH_DIRECTION
  const nodes = Array.isArray(model?.nodes) ? model.nodes : []
  const edges = Array.isArray(model?.edges) ? model.edges : []
  const preamble = Array.isArray(model?.preamble) ? model.preamble : []
  const extras = Array.isArray(model?.extras) ? model.extras : []

  // Verbatim. Frontmatter and leading comments are the user's words, not ours.
  const lines: string[] = [...preamble]
  lines.push(`graph ${direction}`)
  const knownIds = new Set<string>()

  for (const node of nodes) {
    const id = sanitizeNodeId(node?.id)
    if (knownIds.has(id)) {
      continue
    }
    knownIds.add(id)
    const label = typeof node?.label === 'string' && node.label.trim().length > 0 ? node.label : id
    const { open, close } = shapeDelimiters(isNodeShape(node?.shape) ? node.shape : DEFAULT_MERMAID_NODE_SHAPE)
    lines.push(`  ${id}${open}"${escapeLabel(label)}"${close}`)
  }

  for (const edge of edges) {
    const from = sanitizeNodeId(edge?.from)
    const to = sanitizeNodeId(edge?.to)
    if (!knownIds.has(from) || !knownIds.has(to)) {
      continue
    }
    const connector = edgeConnector(isEdgeKind(edge?.kind) ? edge.kind : DEFAULT_MERMAID_EDGE_KIND)
    const label = escapeEdgeLabel(typeof edge?.label === 'string' ? edge.label : '')
    if (label) {
      lines.push(`  ${from} ${connector}|${label}| ${to}`)
    } else {
      lines.push(`  ${from} ${connector} ${to}`)
    }
  }

  // Verbatim, after the body: mermaid accepts styling statements anywhere, and
  // appending keeps their relative order without the builder pretending to
  // understand them.
  lines.push(...extras)

  return lines.join('\n')
}

/** Strips the optional surrounding quotes mermaid allows around a label. */
function unquoteLabel(raw: string): string {
  const trimmed = raw.trim()
  const unquoted =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed
  return unquoted.replace(/&quot;/g, '"').trim()
}

/** A single shaped node reference: its id, its shape and its label. */
function matchShapedNode(text: string): { id: string; shape: MermaidNodeShape; label: string } | null {
  const head = /^([A-Za-z0-9_]+)\s*(.*)$/.exec(text.trim())
  if (!head) {
    return null
  }
  const id = head[1]
  const rest = head[2]
  for (const candidate of SHAPE_DELIMITERS) {
    if (
      rest.length >= candidate.open.length + candidate.close.length &&
      rest.startsWith(candidate.open) &&
      rest.endsWith(candidate.close)
    ) {
      return {
        id,
        shape: candidate.shape,
        label: unquoteLabel(rest.slice(candidate.open.length, rest.length - candidate.close.length)),
      }
    }
  }
  return null
}

/**
 * The outcome of scanning one line for a link.
 *
 * `unmodelled` is not a parse failure dressed up — it is the specific answer the
 * user gets to see. A longer link (`---->`, `===>`, `-..->`) is a LENGTH or a
 * STYLE mermaid understands and this builder does not, and reading a shorter
 * connector out of it would silently shorten someone's arrow. Saying which link
 * it was beats "a statement the builder cannot read".
 */
interface ConnectorScan {
  match: { index: number; kind: MermaidEdgeKind; connector: string } | null
  /** The connector-shaped run that was refused, verbatim, if any. */
  unmodelled: string | null
}

/** The characters a link is drawn from, used to delimit a refused run. */
const LINK_CHARACTERS = '-=.>'

/**
 * Finds the link connector at BRACKET DEPTH ZERO, so a label that itself
 * contains an arrow does not split the line in the wrong place.
 */
function findConnector(line: string): ConnectorScan {
  let depth = 0
  let inQuote = false
  let unmodelled: string | null = null
  /**
   * The first connector-shaped run that matched NOTHING — `-..->` and friends.
   * A run no candidate matches is just as much an unmodelled link as one a guard
   * refuses, and the user deserves the same specific answer for it.
   */
  let unmatchedRun: string | null = null

  /** The whole connector-shaped run around `i`, so the message can quote it. */
  const runAround = (i: number): string => {
    let start = i
    while (start > 0 && LINK_CHARACTERS.includes(line[start - 1])) {
      start--
    }
    let end = i
    while (end < line.length && LINK_CHARACTERS.includes(line[end])) {
      end++
    }
    return line.slice(start, end)
  }

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (inQuote) {
      continue
    }
    if (ch === '[' || ch === '(' || ch === '{') {
      depth++
      continue
    }
    if (ch === ']' || ch === ')' || ch === '}') {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth !== 0) {
      continue
    }
    if (LINK_CHARACTERS.includes(ch) && !LINK_CHARACTERS.includes(line[i - 1] ?? '')) {
      // The start of a run. The shortest connector this builder models is three
      // characters, so anything shorter is not a link at all.
      const run = runAround(i)
      if (run.length >= 3) {
        unmatchedRun = unmatchedRun ?? run
      }
    }
    for (const candidate of EDGE_CONNECTORS) {
      if (line.startsWith(candidate.connector, i)) {
        // BOTH ends have to be checked. A four-dash link contains a three-dash
        // one starting one character later, so a trailing guard alone would
        // still match it — at the wrong offset, and with the leftover dash
        // silently folded into the node name beside it.
        const next = line[i + candidate.connector.length]
        const previous = i > 0 ? line[i - 1] : undefined
        if (next === '-' || next === '>' || next === '=' || next === '.') {
          unmodelled = unmodelled ?? runAround(i)
          continue
        }
        if (previous === '-' || previous === '=' || previous === '.') {
          unmodelled = unmodelled ?? runAround(i)
          continue
        }
        return { match: { index: i, kind: candidate.kind, connector: candidate.connector }, unmodelled: null }
      }
    }
  }
  return { match: null, unmodelled: unmodelled ?? unmatchedRun }
}

/** Statements the builder preserves verbatim rather than modelling. */
const PASSTHROUGH_RE = /^(?:%%|classDef\b|class\b|style\b|linkStyle\b|click\b)/

/**
 * Best-effort reverse parser for the flowchart dialect this builder models.
 * Delegates to `analyzeMermaidSource`, which is the richer answer: it also names
 * the diagram type and WHY a source could not be read.
 *
 * Returns null when the source is not a flowchart it can fully represent (a
 * sequence diagram, a subgraph, an unknown statement) so callers can keep the
 * user in the code editor instead of clobbering content they cannot represent.
 */
export function parseFlowchartSource(source: string): MermaidGraphModel | null {
  return analyzeMermaidSource(source).model
}

/** The diagram families `detectMermaidDiagramType` can name. */
export const MERMAID_DIAGRAM_TYPE_LABELS: Record<string, string> = {
  flowchart: 'flowchart',
  sequence: 'sequence diagram',
  class: 'class diagram',
  state: 'state diagram',
  er: 'entity-relationship diagram',
  gantt: 'Gantt chart',
  pie: 'pie chart',
  journey: 'user journey',
  gitGraph: 'Git graph',
  mindmap: 'mindmap',
  timeline: 'timeline',
  quadrant: 'quadrant chart',
  requirement: 'requirement diagram',
  sankey: 'Sankey diagram',
  xychart: 'XY chart',
  block: 'block diagram',
  c4: 'C4 diagram',
  unknown: 'diagram',
}

const DIAGRAM_TYPE_KEYWORDS: { type: string; re: RegExp }[] = [
  { type: 'flowchart', re: /^(?:graph|flowchart)\b/i },
  { type: 'sequence', re: /^sequenceDiagram\b/i },
  { type: 'class', re: /^classDiagram(?:-v2)?\b/i },
  { type: 'state', re: /^stateDiagram(?:-v2)?\b/i },
  { type: 'er', re: /^erDiagram\b/i },
  { type: 'gantt', re: /^gantt\b/i },
  { type: 'pie', re: /^pie\b/i },
  { type: 'journey', re: /^journey\b/i },
  { type: 'gitGraph', re: /^gitGraph\b/i },
  { type: 'mindmap', re: /^mindmap\b/i },
  { type: 'timeline', re: /^timeline\b/i },
  { type: 'quadrant', re: /^quadrantChart\b/i },
  { type: 'requirement', re: /^requirementDiagram\b/i },
  { type: 'sankey', re: /^sankey/i },
  { type: 'xychart', re: /^xychart/i },
  { type: 'block', re: /^block(?:-beta)?\b/i },
  { type: 'c4', re: /^C4(?:Context|Container|Component|Dynamic|Deployment)\b/i },
]

/**
 * Names the diagram family a source declares — the FIRST statement that is not
 * frontmatter, a comment or blank. `unknown` when nothing matches, which is the
 * honest answer for a malformed source.
 */
export function detectMermaidDiagramType(source: string): string {
  if (typeof source !== 'string') {
    return 'unknown'
  }
  const lines = source.split(/\r?\n/)
  let index = 0
  if (lines[0]?.trim() === '---') {
    index = 1
    while (index < lines.length && lines[index].trim() !== '---') {
      index++
    }
    index++
  }
  for (; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (!trimmed || trimmed.startsWith('%%')) {
      continue
    }
    const match = DIAGRAM_TYPE_KEYWORDS.find((candidate) => candidate.re.test(trimmed))
    return match ? match.type : 'unknown'
  }
  return 'unknown'
}

/** What a surface needs to decide between "build" and "explain why not". */
export interface MermaidSourceAnalysis {
  /** The declared diagram family — a key of MERMAID_DIAGRAM_TYPE_LABELS. */
  type: string
  /** The editable model, or null when the source cannot be represented. */
  model: MermaidGraphModel | null
  /**
   * Human-readable reasons the model is null, in source order. Empty when the
   * model is non-null. These are shown to the user verbatim: a builder that
   * clearly states what it does not handle is the whole point.
   */
  blockers: string[]
}

/**
 * THE one analysis every surface runs. Parses when it can, and when it cannot,
 * says precisely what stopped it rather than returning a bare null that a caller
 * would have to turn into a guess.
 */
export function analyzeMermaidSource(source: string): MermaidSourceAnalysis {
  if (typeof source !== 'string') {
    return { type: 'unknown', model: null, blockers: ['the source is not text'] }
  }

  const type = detectMermaidDiagramType(source)
  if (source.trim().length === 0) {
    // An empty block is not a failure — it is a fresh diagram, and the builder
    // is exactly the right thing to open on it.
    return { type: 'flowchart', model: createEmptyGraphModel(), blockers: [] }
  }
  if (type !== 'flowchart') {
    return {
      type,
      model: null,
      blockers: [`this is a ${MERMAID_DIAGRAM_TYPE_LABELS[type] ?? 'diagram'}, and the builder models flowcharts`],
    }
  }

  const rawLines = source.split(/\r?\n/)
  const preamble: string[] = []
  const extras: string[] = []
  const blockers: string[] = []
  let direction: MermaidGraphDirection = DEFAULT_MERMAID_GRAPH_DIRECTION

  const nodeMap = new Map<string, MermaidGraphNode>()
  const edges: MermaidGraphEdge[] = []

  const ensureNode = (id: string, label?: string, shape?: MermaidNodeShape): void => {
    const existing = nodeMap.get(id)
    if (existing) {
      if (label && existing.label === existing.id) {
        existing.label = label
      }
      if (shape && shape !== DEFAULT_MERMAID_NODE_SHAPE) {
        existing.shape = shape
      }
      return
    }
    nodeMap.set(id, { id, label: label && label.length > 0 ? label : id, shape: shape ?? DEFAULT_MERMAID_NODE_SHAPE })
  }

  let index = 0
  // YAML frontmatter, verbatim. It carries the diagram's title and its own
  // config block; regenerating the source without it is a visible change the
  // user never asked for.
  if (rawLines[0]?.trim() === '---') {
    let close = 1
    while (close < rawLines.length && rawLines[close].trim() !== '---') {
      close++
    }
    if (close >= rawLines.length) {
      return { type, model: null, blockers: ['the YAML frontmatter block is not closed'] }
    }
    for (let i = 0; i <= close; i++) {
      preamble.push(rawLines[i])
    }
    index = close + 1
  }

  // Anchored at both ends, with mermaid's optional statement semicolon allowed.
  // An un-anchored header would swallow whatever followed it on the line and
  // then regenerate the source without it — the exact silent loss this parser
  // exists to stop.
  const headerRe = /^(?:graph|flowchart)\s+(TD|TB|LR|BT|RL)\s*;?\s*$/i
  const bareHeaderRe = /^(?:graph|flowchart)\s*;?\s*$/i
  let sawHeader = false

  for (; index < rawLines.length; index++) {
    const line = rawLines[index]
    const trimmed = line.trim()

    if (!sawHeader) {
      if (!trimmed || trimmed.startsWith('%%')) {
        preamble.push(line)
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
      if (bareHeaderRe.test(trimmed)) {
        sawHeader = true
        continue
      }
      return { type, model: null, blockers: [`line ${index + 1} is not a flowchart header: ${trimmed}`] }
    }

    if (!trimmed) {
      continue
    }
    if (PASSTHROUGH_RE.test(trimmed)) {
      extras.push(line)
      continue
    }
    if (/^subgraph\b/i.test(trimmed)) {
      blockers.push(`line ${index + 1}: subgraphs are not modelled yet`)
      continue
    }
    if (/^end$/i.test(trimmed)) {
      blockers.push(`line ${index + 1}: this closes a subgraph, which is not modelled yet`)
      continue
    }
    if (/^direction\b/i.test(trimmed)) {
      blockers.push(`line ${index + 1}: a per-subgraph direction is not modelled yet`)
      continue
    }

    const scan = findConnector(trimmed)
    if (scan.match === null && scan.unmodelled !== null) {
      blockers.push(`line ${index + 1}: the link ${scan.unmodelled} is a length or style the builder does not model`)
      continue
    }
    const connector = scan.match
    if (connector) {
      const left = trimmed.slice(0, connector.index).trim()
      let right = trimmed.slice(connector.index + connector.connector.length).trim()
      let label = ''
      if (right.startsWith('|')) {
        const close = right.indexOf('|', 1)
        if (close === -1) {
          blockers.push(`line ${index + 1}: an unterminated link label`)
          continue
        }
        label = right.slice(1, close).trim()
        right = right.slice(close + 1).trim()
      }
      const fromNode = matchShapedNode(left)
      const toNode = matchShapedNode(right)
      const fromId = fromNode?.id ?? (/^[A-Za-z0-9_]+$/.test(left) ? left : null)
      const toId = toNode?.id ?? (/^[A-Za-z0-9_]+$/.test(right) ? right : null)
      if (!fromId || !toId) {
        blockers.push(`line ${index + 1}: a link the builder cannot read: ${trimmed}`)
        continue
      }
      ensureNode(fromId, fromNode?.label, fromNode?.shape)
      ensureNode(toId, toNode?.label, toNode?.shape)
      edges.push({ from: fromId, to: toId, label, kind: connector.kind })
      continue
    }

    const declaration = matchShapedNode(trimmed)
    if (declaration) {
      ensureNode(declaration.id, declaration.label, declaration.shape)
      continue
    }

    if (/^[A-Za-z0-9_]+$/.test(trimmed)) {
      ensureNode(trimmed)
      continue
    }

    blockers.push(`line ${index + 1}: a statement the builder cannot read: ${trimmed}`)
  }

  if (!sawHeader) {
    return { type, model: null, blockers: ['there is no graph / flowchart header'] }
  }
  if (blockers.length > 0) {
    return { type, model: null, blockers }
  }

  return { type, model: { direction, nodes: Array.from(nodeMap.values()), edges, preamble, extras }, blockers: [] }
}

/**
 * Renames a node AND every reference to it. The rename used to change only the
 * node, which left every edge pointing at an id that no longer existed — and
 * `buildFlowchartSource` drops unknown edges, so the connections silently
 * vanished the moment the user corrected a name.
 */
export function renameGraphNode(model: MermaidGraphModel, index: number, nextId: string): MermaidGraphModel {
  const target = model.nodes[index]
  if (!target) {
    return model
  }
  const previousId = target.id
  const nodes = model.nodes.map((node, i) => (i === index ? { ...node, id: nextId } : node))
  const edges = model.edges.map((edge) => ({
    ...edge,
    from: edge.from === previousId ? nextId : edge.from,
    to: edge.to === previousId ? nextId : edge.to,
  }))
  return { ...model, nodes, edges }
}

/** Appends a fresh node with a free id. */
export function appendGraphNode(model: MermaidGraphModel): MermaidGraphModel {
  const id = nextNodeId(model.nodes)
  return { ...model, nodes: [...model.nodes, { id, label: id, shape: DEFAULT_MERMAID_NODE_SHAPE }] }
}

/**
 * Appends a link between the last two nodes — the pair a user who has just added
 * a node means — falling back to the single node when there is only one.
 */
export function appendGraphEdge(model: MermaidGraphModel): MermaidGraphModel {
  if (model.nodes.length === 0) {
    return model
  }
  const last = model.nodes[model.nodes.length - 1].id
  const previous = model.nodes.length > 1 ? model.nodes[model.nodes.length - 2].id : last
  return { ...model, edges: [...model.edges, { from: previous, to: last, label: '', kind: DEFAULT_MERMAID_EDGE_KIND }] }
}

/** Removes a node and every link that touched it. */
export function removeGraphNode(model: MermaidGraphModel, index: number): MermaidGraphModel {
  const removedId = model.nodes[index]?.id
  return {
    ...model,
    nodes: model.nodes.filter((_, i) => i !== index),
    edges: model.edges.filter((edge) => edge.from !== removedId && edge.to !== removedId),
  }
}

/**
 * The preserved lines that reference an id no longer in the model. They are
 * never rewritten (guessing inside someone's styling is worse than leaving it)
 * but they ARE reported, so the UI can say the styling now points at nothing.
 */
export function danglingExtras(model: MermaidGraphModel): string[] {
  const known = new Set(model.nodes.map((node) => node.id))
  return (model.extras ?? []).filter((line) => {
    // The id list is the FIRST whitespace-delimited token only: `class A hot`
    // names node `A` and class `hot`, and letting the capture run to the end of
    // the line would swallow the class name, fail the identifier test and report
    // nothing — a dangling-reference check that can never fire.
    const match = /^(?:class|style|click)\s+([A-Za-z0-9_,]+)/.exec(line.trim())
    if (!match) {
      return false
    }
    return match[1]
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0 && /^[A-Za-z0-9_]+$/.test(part))
      .some((id) => !known.has(id))
  })
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
