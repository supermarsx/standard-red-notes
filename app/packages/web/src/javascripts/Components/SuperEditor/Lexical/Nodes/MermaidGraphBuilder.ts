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

/**
 * Shapes mermaid draws that this builder does NOT model, by the characters
 * mermaid recognises them from — each of which is ALSO the start of a shape the
 * builder does model. `[/Input/]` opens with `[`, so it used to be read as a
 * plain box whose label was `/Input/`, and regenerated that way: a slanted box
 * became a rectangle with slashes in its text on the first edit of anything
 * else. Judged by mermaid's own parser, before and after a visual edit that
 * changed nothing:
 *
 *   `A[/Input/]`   lean_right "Input"    ->  square "/Input/"
 *   `A[\Output\]`  lean_left "Output"    ->  square "\Output\"
 *   `A[/Trap\]`    trapezoid "Trap"      ->  square "/Trap\"
 *   `A(((Stop)))`  doublecircle "Stop"   ->  circle "(Stop)"
 *   `A(-Oval-)`    ellipse "Oval"        ->  round "-Oval-"
 *   `A[|b:lt|T]`   rect "T"              ->  square "|b:lt|T"
 *
 * Ordered LONGEST OPENER FIRST, and consulted BEFORE the modelled shapes, for
 * the reason those are ordered: `(((` must not be read as `((`. A QUOTED label
 * is untouched by all of this — `A["/path/"]` opens with `["`, which is a box
 * and nothing else, and it is the form the builder itself writes.
 */
const UNMODELLED_SHAPE_OPENERS: { open: string; name: string }[] = [
  { open: '(((', name: 'a double circle' },
  { open: '[/', name: 'a slanted box or trapezoid' },
  { open: '[\\', name: 'a slanted box or trapezoid' },
  { open: '[|', name: 'a box with properties' },
  { open: '(-', name: 'an ellipse' },
  { open: '>', name: 'a flag-shaped box' },
]

/**
 * A single shaped node reference: its id, its shape and its label — or, for a
 * shape mermaid understands and this builder does not, the id and what the
 * shape is, so the caller can refuse it by name rather than misread it.
 */
type ShapedNodeMatch =
  { id: string; shape: MermaidNodeShape; label: string; unmodelled?: undefined } | { id: string; unmodelled: string }

function matchShapedNode(text: string): ShapedNodeMatch | null {
  const head = /^([A-Za-z0-9_]+)\s*(.*)$/.exec(text.trim())
  if (!head) {
    return null
  }
  const id = head[1]
  const rest = head[2]
  const unmodelled = UNMODELLED_SHAPE_OPENERS.find((candidate) => rest.startsWith(candidate.open))
  if (unmodelled) {
    return { id, unmodelled: unmodelled.name }
  }
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
 * The two forms of `linkStyle` mermaid accepts: `default`, or a list of link
 * POSITIONS with no space inside it (`linkStyle 0,2 stroke:red` — measured
 * against mermaid 11.17.2, `0, 2` is a parse error). Group 1 is everything up to
 * the list, group 2 the list, group 3 the rest of the line, so a numbered one
 * can be rewritten touching nothing but its numbers.
 */
const LINK_STYLE_RE = /^(\s*linkStyle\s+)(default|\d+(?:,\d+)*)(\s.*)?$/

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

  /**
   * A reference to a node. `shaped` is present when the reference carried a
   * shape and a label (`A[Start]`), absent for a bare id (`A`).
   *
   * THE LAST SHAPED REFERENCE WINS, both halves of it, because that is what
   * mermaid does: `A[Start]` … `A(Renamed later)` is a rounded node labelled
   * "Renamed later". This used to keep the FIRST label and any non-box shape it
   * had seen, so opening such a diagram in the builder and touching anything
   * put the old label back. A bare reference changes nothing, in mermaid or
   * here.
   */
  const ensureNode = (id: string, shaped?: { label: string; shape: MermaidNodeShape }): void => {
    const existing = nodeMap.get(id)
    if (existing) {
      if (shaped) {
        existing.label = shaped.label.length > 0 ? shaped.label : id
        existing.shape = shaped.shape
      }
      return
    }
    nodeMap.set(id, {
      id,
      label: shaped && shaped.label.length > 0 ? shaped.label : id,
      shape: shaped?.shape ?? DEFAULT_MERMAID_NODE_SHAPE,
    })
  }

  /** Says which shape was refused, and where — never a bare "cannot read". */
  const refuseShape = (lineNumber: number, node: { id: string; unmodelled: string }): void => {
    blockers.push(
      `line ${lineNumber}: node ${node.id} is ${node.unmodelled}, a shape the builder does not model — it would be redrawn as a plain box`,
    )
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
      // A `linkStyle` names links by their POSITION, so it is the one preserved
      // statement an edit can silently re-point. One the builder cannot keep in
      // step (see `removeGraphEdge`) blocks it, like any other unreadable line.
      if (/^linkStyle\b/.test(trimmed) && !LINK_STYLE_RE.test(trimmed)) {
        blockers.push(`line ${index + 1}: a linkStyle the builder cannot keep in step with its links: ${trimmed}`)
        continue
      }
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
      if (fromNode?.unmodelled !== undefined || toNode?.unmodelled !== undefined) {
        if (fromNode?.unmodelled !== undefined) {
          refuseShape(index + 1, fromNode)
        }
        if (toNode?.unmodelled !== undefined) {
          refuseShape(index + 1, toNode)
        }
        continue
      }
      const fromId = fromNode?.id ?? (/^[A-Za-z0-9_]+$/.test(left) ? left : null)
      const toId = toNode?.id ?? (/^[A-Za-z0-9_]+$/.test(right) ? right : null)
      if (!fromId || !toId) {
        blockers.push(`line ${index + 1}: a link the builder cannot read: ${trimmed}`)
        continue
      }
      ensureNode(fromId, fromNode ?? undefined)
      ensureNode(toId, toNode ?? undefined)
      edges.push({ from: fromId, to: toId, label, kind: connector.kind })
      continue
    }

    const declaration = matchShapedNode(trimmed)
    if (declaration?.unmodelled !== undefined) {
      refuseShape(index + 1, declaration)
      continue
    }
    if (declaration) {
      ensureNode(declaration.id, declaration)
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

/**
 * What committing a typed node id did: the model to use, and — when the id was
 * refused — the reason, in words the builder shows beside the field.
 */
export interface GraphNodeIdCommit {
  model: MermaidGraphModel
  refusal: string | null
}

/**
 * Commits what was typed into a node's id field, ONCE, when the user has
 * finished typing it.
 *
 * The field used to rename on every keystroke, and a rename to an id another
 * node already has MERGES the two — `buildFlowchartSource` writes one node per
 * id. So renaming `B` to `A2` while a node `A` existed passed through `A` on
 * the way: on that keystroke B became a second `A`, and on the next one the
 * rename took A's links with it. Measured in the running app with real key
 * input: `A --> B`, `C --> A` came out as `A2 --> A2`, `C --> A2`, with node A
 * left unlinked. Committing on Enter or blur removes the intermediate ids, and
 * these two refusals remove the destinations that are never right:
 *
 *  - an EMPTY id, which generation would have replaced with `n`;
 *  - an id ANOTHER NODE HAS, compared as it will be WRITTEN — `a-b` and `a_b`
 *    are the same id once sanitised, and so are the same node.
 *
 * The id committed is the sanitised one, so the field shows what the source
 * says rather than what was typed.
 */
export function commitGraphNodeId(model: MermaidGraphModel, index: number, typed: string): GraphNodeIdCommit {
  const target = model.nodes[index]
  if (!target) {
    return { model, refusal: null }
  }
  if (typeof typed !== 'string' || typed.trim().length === 0) {
    return { model, refusal: `A node needs an id, so this one is still ${target.id}.` }
  }
  const nextId = sanitizeNodeId(typed)
  if (nextId === target.id) {
    return { model, refusal: null }
  }
  if (model.nodes.some((node, i) => i !== index && sanitizeNodeId(node.id) === nextId)) {
    return {
      model,
      refusal: `Another node is already called ${nextId}, and two nodes with one id are one node. This one is still ${target.id}.`,
    }
  }
  return { model: renameGraphNode(model, index, nextId), refusal: null }
}

/**
 * Removes one link — and keeps every numbered `linkStyle` pointing at the link
 * it pointed at before.
 *
 * `linkStyle 1 stroke:red` styles the SECOND link, by position. Removing the
 * first link used to leave that line as written, so it now named a position
 * past the end of the list, and mermaid does not ignore that: it throws
 * `Cannot set properties of undefined (setting 'style')` and the whole diagram
 * stops drawing. Removing a LATER link was quieter and no better — every style
 * after it moved onto the wrong link.
 *
 * So the numbers move with the links: a position after the removed one drops by
 * one, the removed position leaves its list, and a statement left styling
 * nothing is removed with the link it styled. Nothing else in the line is
 * touched, and `linkStyle default` is not touched at all.
 */
export function removeGraphEdge(model: MermaidGraphModel, index: number): MermaidGraphModel {
  if (!Number.isInteger(index) || index < 0 || index >= model.edges.length) {
    return model
  }
  const extras: string[] = []
  for (const line of model.extras ?? []) {
    const match = LINK_STYLE_RE.exec(line)
    if (!match || match[2] === 'default') {
      extras.push(line)
      continue
    }
    const positions = match[2]
      .split(',')
      .map(Number)
      .filter((position) => position !== index)
      .map((position) => (position > index ? position - 1 : position))
    if (positions.length > 0) {
      extras.push(`${match[1]}${positions.join(',')}${match[3] ?? ''}`)
    }
  }
  return { ...model, edges: model.edges.filter((_, i) => i !== index), extras }
}

/** Removes a node and every link that touched it. */
export function removeGraphNode(model: MermaidGraphModel, index: number): MermaidGraphModel {
  const removedId = model.nodes[index]?.id
  if (removedId === undefined) {
    return model
  }
  // One link at a time, LAST FIRST, through `removeGraphEdge`: each removal
  // renumbers the `linkStyle` statements, and going backwards means the
  // positions still to be removed have not moved yet.
  let next = model
  for (let edge = model.edges.length - 1; edge >= 0; edge--) {
    if (model.edges[edge].from === removedId || model.edges[edge].to === removedId) {
      next = removeGraphEdge(next, edge)
    }
  }
  return { ...next, nodes: next.nodes.filter((_, i) => i !== index) }
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

/**
 * Must choosing a template be confirmed first? A template REPLACES the whole
 * source, and it used to do so the moment it was picked from the dropdown, with
 * nothing asked — one stray selection and a diagram was gone, behind the same
 * control that offers "Flowchart" as if it were a setting.
 *
 * It need not be confirmed when there is nothing of the user's to lose: an
 * empty diagram, or one that is still exactly a starter — a template as
 * inserted, or one of `starterSources` (the caller passes the source a new
 * block is created with). Anything else is somebody's work.
 */
export function templateReplacesUserWork(currentSource: string, starterSources: readonly string[] = []): boolean {
  const current = typeof currentSource === 'string' ? currentSource.trim() : ''
  if (current.length === 0) {
    return false
  }
  const starters = [...MERMAID_TEMPLATES.map((template) => template.source), ...starterSources]
  return !starters.some((starter) => starter.trim() === current)
}
