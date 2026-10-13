/**
 * Standard Red Notes — a POSITIONAL reading of a mermaid flowchart: what the
 * text means, and where in the text each box, link and group is written.
 *
 * `MermaidSourceDoc.ts` reads a text with mermaid's own grammar and knows
 * nothing about flowcharts. This module is what a flowchart adds to it: one
 * handler per production of mermaid's flowchart grammar. Each does what
 * mermaid's own parser action for that production does — the calls into its
 * FlowDB, in the same order — against a small imitation of that database, and
 * additionally remembers WHERE each thing was written. So a statement here is
 * the statement mermaid's parser reduces, including the parts nobody would
 * guess: a link's whitespace may contain a newline, so a line that starts with
 * `-->` continues the statement above it; `x--> C` at the start of a line is a
 * cross-ended link, not a box called `x`; a line that merely CONTAINS the words
 * `direction TB` is a direction statement.
 *
 * The imitation is where this module can be wrong, and it is checked two ways:
 * `scripts/MermaidFlowEngineContract.mjs` compares it with the real library
 * over a corpus and over every one-character deletion of it, and at run time
 * `compareMermaidFlowReadings` compares it with mermaid's own reading of the
 * very diagram being edited — a difference refuses the edit.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not sanitise labels (mermaid runs them through DOMPurify), and it
 * does not read the YAML inside `@{ … }`. Where one of those decides something,
 * the reading says "not known here" rather than guessing, and the comparison
 * with mermaid's reading skips exactly that.
 */
import {
  compileMermaidGrammar,
  lexMermaidSource,
  MermaidReadFailure,
  type MermaidSourceEntry,
  type MermaidSourceHandler,
  type MermaidSourceLanguage,
  type MermaidSourceLine,
  mermaidSourceLineAt,
  type MermaidSourcePiece,
  type MermaidSourceProblem,
  type MermaidSourceProblemKind,
  MermaidSourceReader,
  type MermaidSourceRewrite,
  type MermaidSourceSpan,
  parseMermaidSource,
  printMermaidSourceDocument,
} from './MermaidSourceDoc'

// ---------------------------------------------------------------------------
// What a flowchart is, where it is written
// ---------------------------------------------------------------------------

export type MermaidFlowLabelType = 'text' | 'string' | 'markdown'

/** A label where it is written. */
export type MermaidFlowLabel = {
  /** What mermaid's parser is handed for it: delimiters gone, entity codes as placeholders. */
  text: string
  type: MermaidFlowLabelType
  /** Everything between the opening and closing delimiter, quotes included. */
  inner: MermaidSourceSpan
}

/** One place a box is written. */
export type MermaidFlowMention = {
  id: string
  idSpan: MermaidSourceSpan
  /** The id and its shape brackets. */
  span: MermaidSourceSpan
  /** The id, brackets, `:::class` and `@{…}`: everything that is this box, here. */
  full: MermaidSourceSpan
  shape: {
    /** Mermaid's name for it: `square`, `round`, `lean_right`, … */
    type: string
    open: MermaidSourceSpan
    close: MermaidSourceSpan
    label: MermaidFlowLabel
    /** `[|field:value|text]`: a box with a property, which the builder reads and does not write. */
    withProps: boolean
  } | null
  classes: { name: string; span: MermaidSourceSpan }[]
  /** The `@{ … }` that follows, when there is one. */
  shapeData: MermaidSourceSpan | null
  /** Index of the statement it is written in. */
  statement: number
  /** Which `&`-joined group of that statement, and where in the group. */
  group: number
  position: number
}

/** One link as written; it stands for one edge per pair of boxes around it. */
export type MermaidFlowLinkSyntax = {
  /** The whole link: its whitespace, its text, the `e1@` before it. */
  span: MermaidSourceSpan
  type: string
  stroke: string
  length: number | undefined
  /** `plain` is `-->`, `pipe` is `-->|text|`, `inline` is `-- text -->`. */
  form: 'plain' | 'pipe' | 'inline'
  label: MermaidFlowLabel | null
  /** The id written before it as `e1@`, without the `@`. */
  id: string | null
  /** Indices into the document's edges, in the order mermaid creates them. */
  edges: number[]
}

type StatementCommon = {
  index: number
  /** The statement without its separator and without the spaces after it. */
  span: MermaidSourceSpan
  /** Index of the group statement it sits directly inside, or null at the top level. */
  parent: number | null
  /** Line of its first character, counted from 0. */
  line: number
  /** Line of its last character. */
  endLine: number
  /** What ended it. */
  separator: 'newline' | 'semicolon' | 'end'
}

export type MermaidFlowVertexStatement = StatementCommon & {
  kind: 'vertex'
  /** The `&`-joined groups, left to right; `links[i]` joins `groups[i]` to `groups[i + 1]`. */
  groups: MermaidFlowMention[][]
  links: MermaidFlowLinkSyntax[]
}

export type MermaidFlowGroupStatement = StatementCommon & {
  kind: 'group'
  /** The id mermaid knows the group by — written, or `subGraph<n>` when the text gives none. */
  id: string
  /** Where the id is written; null when mermaid made it up. */
  idSpan: MermaidSourceSpan | null
  /** What follows the word `subgraph`: the id, or a title mermaid makes an id for. Null for a group with no name. */
  name: MermaidFlowLabel | null
  /** The `[title]` after the id, when it is written that way. */
  title: MermaidFlowLabel | null
  /** `subgraph` up to the end of its own line's content. */
  opening: MermaidSourceSpan
  /** The `end` keyword. */
  closing: MermaidSourceSpan
  /** Indices of the statements directly inside. */
  body: number[]
}

export type MermaidFlowStyleStatement = StatementCommon & {
  kind: 'style'
  target: string
  targetSpan: MermaidSourceSpan
}

export type MermaidFlowClassStatement = StatementCommon & {
  kind: 'class'
  targets: { id: string; span: MermaidSourceSpan }[]
  /** The whole comma-separated list. */
  targetsSpan: MermaidSourceSpan
  className: string
}

export type MermaidFlowClickStatement = StatementCommon & {
  kind: 'click'
  targets: { id: string; span: MermaidSourceSpan }[]
  targetsSpan: MermaidSourceSpan
}

export type MermaidFlowLinkStyleStatement = StatementCommon & {
  kind: 'linkStyle'
  /** The link numbers it names, each where it is written; empty for `linkStyle default`. */
  positions: { value: string; span: MermaidSourceSpan }[]
  isDefault: boolean
  /** The number list, commas included. */
  positionsSpan: MermaidSourceSpan
}

export type MermaidFlowOtherStatement = StatementCommon & {
  kind: 'classDef' | 'direction' | 'accessibility'
}

export type MermaidFlowStatement =
  | MermaidFlowVertexStatement
  | MermaidFlowGroupStatement
  | MermaidFlowStyleStatement
  | MermaidFlowClassStatement
  | MermaidFlowClickStatement
  | MermaidFlowLinkStyleStatement
  | MermaidFlowOtherStatement

/** Where one edge comes from: a link, and one pair of the boxes around it. */
export type MermaidFlowEdgeSite = {
  statement: number
  /** Index into that statement's `links`. */
  link: number
  /** Positions in `groups[link]` and `groups[link + 1]`. */
  start: number
  end: number
}

export type MermaidFlowHeader = {
  /** `graph` or `flowchart` (or a variant keyword mermaid's lexer also accepts). */
  keyword: string
  keywordSpan: MermaidSourceSpan
  /** The direction as written, or null when the header gives none. */
  direction: { value: string; span: MermaidSourceSpan } | null
}

/**
 * What a flowchart MEANS, in mermaid's own terms. Both this module's imitation
 * and the oracle's snapshot of mermaid's FlowDB produce this shape, so the two
 * can be compared field by field. `extra` is what mermaid carries beyond the
 * fields named here; the imitation leaves it out.
 */
export type MermaidFlowNodeReading = {
  id: string
  text: string
  /** Undefined for a box that was never given a shape; mermaid draws it as `square`. */
  type: string | undefined
  labelType: string
  classes: string[]
  styles: string[]
  /** True when `@{…}` was applied to it: its text and type are then not known to the imitation. */
  shapeData?: boolean
  extra?: Record<string, unknown>
}

export type MermaidFlowEdgeReading = {
  start: string
  end: string
  type: string | undefined
  stroke: string | undefined
  length: number | undefined
  text: string
  labelType: string
  /** Only an id the text itself gives (`e1@-->`); mermaid's generated ids are derived, not meaning. */
  id: string | undefined
  classes: string[]
  /** What `linkStyle` gave it. */
  style: string[] | undefined
  interpolate: string | undefined
  extra?: Record<string, unknown>
}

export type MermaidFlowGroupReading = {
  id: string
  title: string
  nodes: string[]
  dir: string | undefined
  labelType: string
  classes: string[]
  extra?: Record<string, unknown>
}

export type MermaidFlowClassReading = { id: string; styles: string[]; textStyles: string[] }

export type MermaidFlowReading = {
  direction: string | undefined
  nodes: MermaidFlowNodeReading[]
  edges: MermaidFlowEdgeReading[]
  groups: MermaidFlowGroupReading[]
  classes: MermaidFlowClassReading[]
  /** `linkStyle default …` */
  defaultLinkStyle: string[] | undefined
  defaultInterpolate: string | undefined
  extra?: Record<string, unknown>
}

/** Why a text cannot be edited as a flowchart, and where. */
export type MermaidFlowProblem = MermaidSourceProblem
export type MermaidFlowProblemKind = MermaidSourceProblemKind

/** A flowchart's text as read: the lossless document, and what the flowchart reader found in it. */
export type MermaidFlowDocument = {
  source: string
  /** The whole text, in order, with no gap and no overlap. */
  pieces: MermaidSourcePiece[]
  lines: MermaidSourceLine[]
  /** Why this text cannot be edited by the builder; null when it was read whole. */
  problem: MermaidFlowProblem | null
  header: MermaidFlowHeader | null
  /** Every statement, groups' insides included, in the order they are written. */
  statements: MermaidFlowStatement[]
  /** One entry per edge mermaid creates, in mermaid's order. */
  edges: MermaidFlowEdgeSite[]
  reading: MermaidFlowReading | null
  /** The text mermaid's flowchart parser is handed for this source. */
  parsedText: string
}

// ---------------------------------------------------------------------------
// An imitation of mermaid's FlowDB — the calls its parser makes, and what they do
// ---------------------------------------------------------------------------

type TextValue = { text: string; type: MermaidFlowLabelType }
type DirectionValue = { stmt: 'dir'; value: string }
type LinkValue = {
  type: string
  stroke: string
  length: number | undefined
  text?: TextValue
  id?: string
  form: 'plain' | 'pipe' | 'inline'
  label: MermaidFlowLabel | null
}

type VertexState = MermaidFlowNodeReading & { text: string }
type EdgeState = MermaidFlowEdgeReading & { generatedId: string }
type GroupState = MermaidFlowGroupReading

/** Mermaid's default `maxEdges`; the app does not raise it, and a diagram's text cannot. */
const MAX_EDGES = 500

class FlowDatabase {
  vertices = new Map<string, VertexState>()
  edges: EdgeState[] = []
  defaultLinkStyle: string[] | undefined
  defaultInterpolate: string | undefined
  groups: GroupState[] = []
  groupLookup = new Map<string, GroupState>()
  classes = new Map<string, MermaidFlowClassReading>()
  groupCount = 0
  direction: string | undefined

  /** Returns the vertex, or undefined when mermaid makes none for this id. */
  addVertex(
    id: string,
    textObj: TextValue | undefined,
    type: string | undefined,
    style: string[] | undefined,
    shapeData: string | undefined,
  ): VertexState | undefined {
    if (!id || id.trim().length === 0) {
      return undefined
    }
    if (shapeData !== undefined && this.groupLookup.has(id)) {
      // `@{…}` on a group configures the group, and no box is made — provided
      // the YAML parses to something. Written on one line mermaid wraps it in
      // braces, so it always does; over several lines it can come to nothing,
      // and then mermaid goes on to make a box with the group's id.
      if (shapeData.includes('\n')) {
        throw new MermaidReadFailure('unsure', `"${id}" is a group given shape data over several lines`)
      }
      return undefined
    }
    // An id that is a link's id is never a box: `e1@{ animate: true }`.
    if (this.edges.some((edge) => this.edgeId(edge) === id)) {
      return undefined
    }
    let vertex = this.vertices.get(id)
    if (vertex === undefined) {
      // Mermaid leaves the text unset here and fills in the id a few lines
      // later unless a label came with this very mention; the two are the same.
      vertex = { id, text: id, type: undefined, labelType: 'text', classes: [], styles: [] }
      this.vertices.set(id, vertex)
    }
    if (textObj !== undefined) {
      let label = textObj.text.trim()
      vertex.labelType = textObj.type
      if (label.startsWith('"') && label.endsWith('"')) {
        label = label.substring(1, label.length - 1)
      }
      vertex.text = label
    }
    if (type !== undefined) {
      vertex.type = type
    }
    if (style !== undefined) {
      vertex.styles.push(...style)
    }
    if (shapeData !== undefined) {
      vertex.shapeData = true
    }
    return vertex
  }

  private edgeId(edge: EdgeState): string {
    return edge.id ?? edge.generatedId
  }

  private addSingleLink(start: string, end: string, link: LinkValue, id: string | undefined): void {
    const edge: EdgeState = {
      start,
      end,
      type: link.type,
      stroke: link.stroke,
      length: link.length !== undefined && link.length > 10 ? 10 : link.length,
      text: '',
      labelType: 'text',
      id: undefined,
      generatedId: '',
      classes: [],
      style: undefined,
      interpolate: this.defaultInterpolate,
    }
    if (link.text !== undefined) {
      let label = link.text.text.trim()
      if (label.startsWith('"') && label.endsWith('"')) {
        label = label.substring(1, label.length - 1)
      }
      edge.text = label
      edge.labelType = link.text.type
    }
    if (id && !this.edges.some((other) => this.edgeId(other) === id)) {
      edge.id = id
    } else {
      const existing = this.edges.filter((other) => other.start === start && other.end === end).length
      edge.generatedId = `L_${start}_${end}_${existing === 0 ? 0 : existing + 1}`
    }
    if (this.edges.length >= MAX_EDGES) {
      throw new MermaidReadFailure('rejected', `more than ${MAX_EDGES} links, which mermaid refuses`)
    }
    this.edges.push(edge)
  }

  /** Returns how many edges it made. */
  addLink(starts: string[], ends: string[], link: LinkValue): number {
    const id = typeof link.id === 'string' ? link.id.replace('@', '') : undefined
    let made = 0
    for (const start of starts) {
      for (const end of ends) {
        const isLastStart = start === starts[starts.length - 1]
        const isFirstEnd = end === ends[0]
        this.addSingleLink(start, end, link, isLastStart && isFirstEnd ? id : undefined)
        made++
      }
    }
    return made
  }

  private edgeAt(position: string): EdgeState {
    const edge = /^(?:0|[1-9]\d*)$/.test(position) ? this.edges[Number(position)] : undefined
    if (edge === undefined) {
      throw new MermaidReadFailure('rejected', `linkStyle ${position} names a link that does not exist`)
    }
    return edge
  }

  updateLinkInterpolate(positions: string[], interpolate: string): void {
    for (const position of positions) {
      if (position === 'default') {
        this.defaultInterpolate = interpolate
      } else {
        this.edgeAt(position).interpolate = interpolate
      }
    }
  }

  updateLink(positions: string[], style: string[]): void {
    for (const position of positions) {
      if (position === 'default') {
        this.defaultLinkStyle = style
      } else {
        const edge = this.edgeAt(position)
        edge.style = style
        if (style.length > 0 && !style.some((entry) => entry?.startsWith('fill'))) {
          style.push('fill:none')
        }
      }
    }
  }

  addClass(ids: string, styles: string[]): void {
    const style = styles.join().replace(/\\,/g, '§§§').replace(/,/g, ';').replace(/§§§/g, ',').split(';')
    for (const id of ids.split(',')) {
      let classNode = this.classes.get(id)
      if (classNode === undefined) {
        classNode = { id, styles: [], textStyles: [] }
        this.classes.set(id, classNode)
      }
      for (const entry of style) {
        if (/color/.exec(entry)) {
          classNode.textStyles.push(entry.replace('fill', 'bgFill'))
        }
        classNode.styles.push(entry)
      }
    }
  }

  setDirection(direction: string): void {
    let value = direction.trim()
    if (/.*</.exec(value)) {
      value = 'RL'
    }
    if (/.*\^/.exec(value)) {
      value = 'BT'
    }
    if (/.*>/.exec(value)) {
      value = 'LR'
    }
    if (/.*v/.exec(value)) {
      value = 'TB'
    }
    if (value === 'TD') {
      value = 'TB'
    }
    this.direction = value
  }

  setClass(ids: string, className: string): void {
    for (const id of ids.split(',')) {
      this.vertices.get(id)?.classes.push(className)
      this.edges.find((edge) => this.edgeId(edge) === id)?.classes.push(className)
      this.groupLookup.get(id)?.classes.push(className)
    }
  }

  addGroup(idValue: TextValue | undefined, list: unknown[], titleValue: TextValue | undefined): string {
    if (idValue === undefined || titleValue === undefined) {
      // Mermaid dereferences the missing name and throws.
      throw new MermaidReadFailure('rejected', 'a group with no name, which mermaid refuses')
    }
    let id: string | undefined = idValue.text.trim()
    if (idValue === titleValue && /\s/.exec(titleValue.text)) {
      id = undefined
    }
    const seen = new Set<string>()
    const nodes: string[] = []
    let dir: string | undefined
    for (const item of (list as unknown[]).flat()) {
      if (typeof item === 'object' && item !== null && (item as DirectionValue).stmt === 'dir') {
        dir = (item as DirectionValue).value
        continue
      }
      if (typeof item !== 'string') {
        throw new MermaidReadFailure('unsure', 'a group holds something this reader does not know')
      }
      if (item.trim() === '' || seen.has(item)) {
        continue
      }
      seen.add(item)
      nodes.push(item)
    }
    id = id ?? 'subGraph' + this.groupCount
    this.groupCount++
    const claimed = (nodeId: string) => this.groups.some((group) => group.nodes.includes(nodeId))
    const group: GroupState = {
      id,
      nodes: nodes.filter((nodeId) => !claimed(nodeId)),
      title: (titleValue.text || '').trim(),
      classes: [],
      dir,
      labelType: titleValue.type,
    }
    this.groups.push(group)
    this.groupLookup.set(id, group)
    return id
  }

  reading(): MermaidFlowReading {
    return {
      direction: this.direction,
      nodes: [...this.vertices.values()].map((vertex) => ({
        id: vertex.id,
        text: vertex.text,
        type: vertex.type,
        labelType: vertex.labelType,
        classes: [...vertex.classes],
        styles: [...vertex.styles],
        ...(vertex.shapeData ? { shapeData: true } : {}),
      })),
      edges: this.edges.map((edge) => ({
        start: edge.start,
        end: edge.end,
        type: edge.type,
        stroke: edge.stroke,
        length: edge.length,
        text: edge.text,
        labelType: edge.labelType,
        id: edge.id,
        classes: [...edge.classes],
        style: edge.style ? [...edge.style] : undefined,
        interpolate: edge.interpolate,
      })),
      groups: this.groups.map((group) => ({ ...group, nodes: [...group.nodes], classes: [...group.classes] })),
      classes: [...this.classes.values()].map((entry) => ({
        id: entry.id,
        styles: [...entry.styles],
        textStyles: [...entry.textStyles],
      })),
      defaultLinkStyle: this.defaultLinkStyle ? [...this.defaultLinkStyle] : undefined,
      defaultInterpolate: this.defaultInterpolate,
    }
  }
}

/** Mermaid's `destructLink`, which turns the characters of an arrow into what it means. */
function destructEndLink(raw: string): { type: string; stroke: string; length: number } {
  const str = raw.trim()
  let line = str.slice(0, -1)
  let type = 'arrow_open'
  switch (str.slice(-1)) {
    case 'x':
      type = 'arrow_cross'
      if (str.startsWith('x')) {
        type = 'double_' + type
        line = line.slice(1)
      }
      break
    case '>':
      type = 'arrow_point'
      if (str.startsWith('<')) {
        type = 'double_' + type
        line = line.slice(1)
      }
      break
    case 'o':
      type = 'arrow_circle'
      if (str.startsWith('o')) {
        type = 'double_' + type
        line = line.slice(1)
      }
      break
  }
  let stroke = 'normal'
  let length = line.length - 1
  if (line.startsWith('=')) {
    stroke = 'thick'
  }
  if (line.startsWith('~')) {
    stroke = 'invisible'
  }
  const dots = line.split('.').length - 1
  if (dots) {
    stroke = 'dotted'
    length = dots
  }
  return { type, stroke, length }
}

function destructStartLink(raw: string): { type: string; stroke: string } {
  let str = raw.trim()
  let type = 'arrow_open'
  switch (str[0]) {
    case '<':
      type = 'arrow_point'
      str = str.slice(1)
      break
    case 'x':
      type = 'arrow_cross'
      str = str.slice(1)
      break
    case 'o':
      type = 'arrow_circle'
      str = str.slice(1)
      break
  }
  let stroke = 'normal'
  if (str.includes('=')) {
    stroke = 'thick'
  }
  if (str.includes('.')) {
    stroke = 'dotted'
  }
  return { type, stroke }
}

function destructLink(end: string, start?: string): { type: string; stroke: string; length: number | undefined } {
  const info = destructEndLink(end)
  if (!start) {
    return info
  }
  const startInfo = destructStartLink(start)
  if (startInfo.stroke !== info.stroke) {
    return { type: 'INVALID', stroke: 'INVALID', length: undefined }
  }
  let type = startInfo.type
  if (type === 'arrow_open') {
    type = info.type
  } else {
    if (type !== info.type) {
      return { type: 'INVALID', stroke: 'INVALID', length: undefined }
    }
    type = 'double_' + type
  }
  if (type === 'double_arrow') {
    type = 'double_arrow_point'
  }
  return { type, stroke: startInfo.stroke, length: info.length }
}

// ---------------------------------------------------------------------------
// The parser's handlers: what mermaid's actions do, plus where it was written
// ---------------------------------------------------------------------------

type StatementDraft = {
  kind: MermaidFlowStatement['kind']
  /** Piece range of the statement proper. */
  first: number
  last: number
  separator: 'newline' | 'semicolon' | 'end'
  children: StatementDraft[]
  details: Record<string, unknown>
}

type NodeValue = { ids: string[]; mentions: MermaidFlowMention[] }
type VertexStatementValue = {
  /** Mermaid's `stmt`: the last group. */
  stmt: NodeValue
  /** Mermaid's `nodes`: every id, later groups first. */
  nodes: string[]
  groups: NodeValue[]
  links: MermaidFlowLinkSyntax[]
}
type StatementValue = { isStatement: true; list: unknown; draft: StatementDraft }
type DocumentValue = { list: unknown[]; drafts: StatementDraft[] }

type Entry = MermaidSourceEntry
type Handler = MermaidSourceHandler<Reader>

class Reader extends MermaidSourceReader {
  db = new FlowDatabase()
  header: MermaidFlowHeader | null = null
  top: DocumentValue | null = null
  /** Edge sites in mermaid's order; the statement is filled in once it has an index. */
  sites: { owner: VertexStatementValue; link: number; start: number; end: number }[] = []

  /** A comma-separated id list as its ids, each where it is written. */
  idList(entry: Entry): { id: string; span: MermaidSourceSpan }[] {
    const result: { id: string; span: MermaidSourceSpan }[] = []
    let current: { id: string; span: MermaidSourceSpan } | null = null
    for (let index = entry.first; index < entry.last; index++) {
      const piece = this.pieces[index]
      if (piece.kind !== 'token') {
        continue
      }
      if (piece.token === 'COMMA') {
        current = null
        continue
      }
      if (current === null) {
        current = { id: '', span: { start: piece.start, end: piece.end } }
        result.push(current)
      }
      current.id += piece.text
      current.span.end = piece.end
    }
    return result
  }

  vertex(
    kids: Entry[],
    type: string | undefined,
    open: number[],
    textAt: number,
    close: number[],
    withProps = false,
  ): { id: string; mention: MermaidFlowMention } {
    const id = kids[0].value as string
    const idSpan = this.span(kids[0])
    let shape: MermaidFlowMention['shape'] = null
    if (type !== undefined) {
      const text = kids[textAt].value as TextValue
      const openSpan = { start: this.span(kids[open[0]]).start, end: this.span(kids[open[open.length - 1]]).end }
      const closeSpan = { start: this.span(kids[close[0]]).start, end: this.span(kids[close[close.length - 1]]).end }
      const innerStart = withProps ? this.span(kids[textAt - 1]).end : openSpan.end
      shape = {
        type,
        open: openSpan,
        close: closeSpan,
        label: { text: text.text, type: text.type, inner: { start: innerStart, end: closeSpan.start } },
        withProps,
      }
      this.db.addVertex(id, text, type, undefined, undefined)
    } else {
      this.db.addVertex(id, undefined, undefined, undefined, undefined)
    }
    const span = { start: idSpan.start, end: this.span(kids[kids.length - 1]).end }
    const mention: MermaidFlowMention = {
      id,
      idSpan,
      span,
      full: { ...span },
      shape,
      classes: [],
      shapeData: null,
      statement: -1,
      group: -1,
      position: -1,
    }
    return { id, mention }
  }

  /** `@{…}` applied to the last box of a group. */
  shapeData(node: NodeValue, data: Entry): void {
    const mention = node.mentions[node.mentions.length - 1]
    const span = this.span(data)
    // `@{` and what is inside it reach the parser as tokens; the `}` that
    // closes it is a match of its own, which hands the parser nothing.
    const closing = this.pieces[data.last]
    const until = closing?.kind === 'skipped' && closing.text.startsWith('}') ? closing.end : span.end
    mention.shapeData = { start: span.start, end: until }
    mention.full.end = Math.max(mention.full.end, until)
    this.db.addVertex(node.ids[node.ids.length - 1], undefined, undefined, undefined, data.value as string)
  }

  link(statement: VertexStatementValue, linkEntry: Entry, target: NodeValue): void {
    const link = linkEntry.value as LinkValue
    const index = statement.links.length
    const firstEdge = this.db.edges.length
    const made = this.db.addLink(statement.stmt.ids, target.ids, link)
    const syntax: MermaidFlowLinkSyntax = {
      span: this.span(linkEntry),
      type: link.type,
      stroke: link.stroke,
      length: link.length,
      form: link.form,
      label: link.label,
      id: typeof link.id === 'string' ? link.id.replace('@', '') : null,
      edges: [],
    }
    for (let offset = 0; offset < made; offset++) {
      syntax.edges.push(firstEdge + offset)
      this.sites.push({
        owner: statement,
        link: index,
        start: Math.floor(offset / target.ids.length),
        end: offset % target.ids.length,
      })
    }
    statement.links.push(syntax)
    statement.groups.push(target)
    statement.nodes = target.ids.concat(statement.nodes)
    statement.stmt = target
  }

  statement(
    kind: MermaidFlowStatement['kind'],
    body: Entry[],
    separator: Entry | null,
    list: unknown,
    details: Record<string, unknown> = {},
    children: StatementDraft[] = [],
  ): StatementValue {
    let ending: StatementDraft['separator'] = 'end'
    if (separator !== null) {
      const piece = this.pieces[separator.first]
      ending = separator.last > separator.first && piece?.token === 'SEMI' ? 'semicolon' : 'newline'
      if (separator.last > separator.first && piece?.token === 'EOF') {
        ending = 'end'
      }
    }
    // The parser only sees tokens. A match that hands it nothing — the word
    // `click`, a quote, the `}` that closes shape data — belongs to the
    // statement whose tokens it sits against: nothing but a separator, which
    // is a token, can come between two statements.
    let first = body[0].first
    let last = body[body.length - 1].last
    while (first > 0 && this.pieces[first - 1].kind === 'skipped') {
      first--
    }
    while (last < this.pieces.length && this.pieces[last].kind === 'skipped') {
      last++
    }
    return { isStatement: true, list, draft: { kind, first, last, separator: ending, children, details } }
  }
}

const textOf =
  (type: MermaidFlowLabelType): Handler =>
  (kids) => ({ text: kids[0].value as string, type })

const appendText: Handler = (kids) => {
  const head = kids[0].value as TextValue
  return { text: head.text + '' + (kids[1].value as string), type: head.type }
}

const concatenate: Handler = (kids) => `${kids[0].value as string}${kids[1].value as string}`

const bracketed =
  (type: string, open: number[], textAt: number, close: number[]): Handler =>
  (kids, reader) =>
    reader.vertex(kids, type, open, textAt, close)

const direction =
  (value: string): Handler =>
  () => ({ stmt: 'dir', value })

const clickTargets = (kids: Entry[], reader: Reader): Record<string, unknown> => {
  const span = reader.span(kids[0])
  const written = reader.source.slice(span.start, span.end)
  const targets: { id: string; span: MermaidSourceSpan }[] = []
  let offset = 0
  for (const id of written.split(',')) {
    targets.push({ id, span: { start: span.start + offset, end: span.start + offset + id.length } })
    offset += id.length + 1
  }
  reader.db.setClass(kids[0].value as string, 'clickable')
  return { targets, targetsSpan: span }
}

const click: Handler = (kids, reader) => ({ click: clickTargets(kids, reader), kids })

const linkStyle =
  (interpolateAt: number | null, stylesAt: number | null): Handler =>
  (kids, reader) => {
    const isDefault = reader.pieces[kids[2].first]?.token === 'DEFAULT'
    const positions = isDefault ? [] : (kids[2].value as { value: string; span: MermaidSourceSpan }[])
    const names = isDefault ? ['default'] : positions.map((position) => position.value)
    if (interpolateAt !== null) {
      reader.db.updateLinkInterpolate(names, kids[interpolateAt].value as string)
    }
    if (stylesAt !== null) {
      reader.db.updateLink(names, kids[stylesAt].value as string[])
    }
    return { positions, isDefault, positionsSpan: reader.span(kids[2]) }
  }

const subgraph =
  (documentAt: number, titleAt: number | null): Handler =>
  (kids, reader) => {
    const named = kids.length > 4
    const name = named ? (kids[2].value as TextValue) : undefined
    const title = titleAt === null ? name : (kids[titleAt].value as TextValue)
    const inside = kids[documentAt].value as DocumentValue
    const id = reader.db.addGroup(name, inside.list, title)
    const writtenId = name !== undefined && name.text.trim() === id
    const separator = kids[documentAt - 1]
    // The name runs from the space after `subgraph` to whatever follows it,
    // so that the quotes of a quoted name are part of it.
    const nameSpan = named ? reader.trimmedRange(reader.span(kids[1]).end, reader.span(kids[3]).start) : null
    const details: Record<string, unknown> = {
      id,
      idSpan: writtenId ? nameSpan : null,
      name: name !== undefined && nameSpan !== null ? { text: name.text, type: name.type, inner: nameSpan } : null,
      title:
        titleAt === null
          ? null
          : {
              text: (kids[titleAt].value as TextValue).text,
              type: (kids[titleAt].value as TextValue).type,
              inner: reader.between(kids[titleAt - 1], kids[titleAt + 1]),
            },
      opening: { start: reader.span(kids[0]).start, end: reader.span(separator).start },
      closing: reader.trimmed(kids[kids.length - 1]),
    }
    return reader.statement('group', kids, null, id, details, inside.drafts)
  }

/**
 * One handler per production that means something, keyed by the production's
 * shape. Each does what mermaid's own action for that production does — the
 * same calls, in the same order — against the imitation database.
 */
const HANDLERS: Record<string, Handler> = {
  'start: graphConfig document': (kids, reader) => {
    reader.top = kids[1].value as DocumentValue
    return undefined
  },
  'document:': () => ({ list: [], drafts: [] }),
  'document: document line': (kids) => {
    const document = kids[0].value as DocumentValue
    const item = kids[1].value as StatementValue | string
    if (typeof item === 'object' && item !== null && item.isStatement) {
      if (!Array.isArray(item.list) || item.list.length > 0) {
        document.list.push(item.list)
      }
      document.drafts.push(item.draft)
    } else {
      document.list.push(item)
    }
    return document
  },
  'graphConfig: SPACE graphConfig': () => undefined,
  'graphConfig: NEWLINE graphConfig': () => undefined,
  'graphConfig: GRAPH NODIR': (kids, reader) => {
    reader.db.setDirection('TB')
    reader.header = { keyword: kids[0].value as string, keywordSpan: reader.span(kids[0]), direction: null }
    return undefined
  },
  'graphConfig: GRAPH DIR FirstStmtSeparator': (kids, reader) => {
    reader.db.setDirection(kids[1].value as string)
    reader.header = {
      keyword: kids[0].value as string,
      keywordSpan: reader.span(kids[0]),
      direction: { value: (kids[1].value as string).trim(), span: reader.trimmed(kids[1]) },
    }
    return undefined
  },

  'statement: vertexStatement separator': (kids, reader) => {
    const value = kids[0].value as VertexStatementValue
    return reader.statement('vertex', [kids[0]], kids[1], value.nodes, { value })
  },
  'statement: styleStatement separator': (kids, reader) =>
    reader.statement('style', [kids[0]], kids[1], [], kids[0].value as Record<string, unknown>),
  'statement: linkStyleStatement separator': (kids, reader) =>
    reader.statement('linkStyle', [kids[0]], kids[1], [], kids[0].value as Record<string, unknown>),
  'statement: classDefStatement separator': (kids, reader) => reader.statement('classDef', [kids[0]], kids[1], []),
  'statement: classStatement separator': (kids, reader) =>
    reader.statement('class', [kids[0]], kids[1], [], kids[0].value as Record<string, unknown>),
  'statement: clickStatement separator': (kids, reader) =>
    reader.statement('click', [kids[0]], kids[1], [], (kids[0].value as { click: Record<string, unknown> }).click),
  'statement: subgraph SPACE textNoTags SQS text SQE separator document end': subgraph(7, 4),
  'statement: subgraph SPACE textNoTags separator document end': subgraph(4, null),
  'statement: subgraph separator document end': subgraph(2, null),
  'statement: direction': (kids, reader) => reader.statement('direction', kids, null, kids[0].value),
  'statement: acc_title acc_title_value': (kids, reader) =>
    reader.statement('accessibility', kids, null, (kids[1].value as string).trim()),
  'statement: acc_descr acc_descr_value': (kids, reader) =>
    reader.statement('accessibility', kids, null, (kids[1].value as string).trim()),
  'statement: acc_descr_multiline_value': (kids, reader) =>
    reader.statement('accessibility', kids, null, (kids[0].value as string).trim()),

  'shapeData: shapeData SHAPE_DATA': concatenate,

  'vertexStatement: vertexStatement link node shapeData': (kids, reader) => {
    const statement = kids[0].value as VertexStatementValue
    const target = kids[2].value as NodeValue
    reader.shapeData(target, kids[3])
    reader.link(statement, kids[1], target)
    return statement
  },
  'vertexStatement: vertexStatement link node': (kids, reader) => {
    const statement = kids[0].value as VertexStatementValue
    reader.link(statement, kids[1], kids[2].value as NodeValue)
    return statement
  },
  'vertexStatement: vertexStatement link node spaceList': (kids, reader) => {
    const statement = kids[0].value as VertexStatementValue
    reader.link(statement, kids[1], kids[2].value as NodeValue)
    return statement
  },
  'vertexStatement: node spaceList': (kids): VertexStatementValue => {
    const node = kids[0].value as NodeValue
    return { stmt: node, nodes: node.ids, groups: [node], links: [] }
  },
  'vertexStatement: node shapeData': (kids, reader): VertexStatementValue => {
    const node = kids[0].value as NodeValue
    reader.shapeData(node, kids[1])
    return { stmt: node, nodes: node.ids, groups: [node], links: [] }
  },
  'vertexStatement: node': (kids): VertexStatementValue => {
    const node = kids[0].value as NodeValue
    return { stmt: node, nodes: node.ids, groups: [node], links: [] }
  },

  'node: styledVertex': (kids): NodeValue => {
    const vertex = kids[0].value as { id: string; mention: MermaidFlowMention }
    return { ids: [vertex.id], mentions: [vertex.mention] }
  },
  'node: node shapeData spaceList AMP spaceList styledVertex': (kids, reader): NodeValue => {
    const node = kids[0].value as NodeValue
    const vertex = kids[5].value as { id: string; mention: MermaidFlowMention }
    reader.shapeData(node, kids[1])
    return { ids: node.ids.concat(vertex.id), mentions: node.mentions.concat(vertex.mention) }
  },
  'node: node spaceList AMP spaceList styledVertex': (kids): NodeValue => {
    const node = kids[0].value as NodeValue
    const vertex = kids[4].value as { id: string; mention: MermaidFlowMention }
    return { ids: node.ids.concat(vertex.id), mentions: node.mentions.concat(vertex.mention) }
  },

  'styledVertex: vertex STYLE_SEPARATOR idString': (kids, reader) => {
    const vertex = kids[0].value as { id: string; mention: MermaidFlowMention }
    const name = kids[2].value as string
    const span = { start: reader.span(kids[1]).start, end: reader.span(kids[2]).end }
    vertex.mention.classes.push({ name, span })
    vertex.mention.full.end = span.end
    reader.db.setClass(vertex.id, name)
    return vertex
  },

  'vertex: idString SQS text SQE': bracketed('square', [1], 2, [3]),
  'vertex: idString DOUBLECIRCLESTART text DOUBLECIRCLEEND': bracketed('doublecircle', [1], 2, [3]),
  'vertex: idString PS PS text PE PE': bracketed('circle', [1, 2], 3, [4, 5]),
  'vertex: idString (- text -)': bracketed('ellipse', [1], 2, [3]),
  'vertex: idString STADIUMSTART text STADIUMEND': bracketed('stadium', [1], 2, [3]),
  'vertex: idString SUBROUTINESTART text SUBROUTINEEND': bracketed('subroutine', [1], 2, [3]),
  'vertex: idString VERTEX_WITH_PROPS_START NODE_STRING COLON NODE_STRING PIPE text SQE': (kids, reader) =>
    reader.vertex(kids, 'rect', [1], 6, [7], true),
  'vertex: idString CYLINDERSTART text CYLINDEREND': bracketed('cylinder', [1], 2, [3]),
  'vertex: idString PS text PE': bracketed('round', [1], 2, [3]),
  'vertex: idString DIAMOND_START text DIAMOND_STOP': bracketed('diamond', [1], 2, [3]),
  'vertex: idString DIAMOND_START DIAMOND_START text DIAMOND_STOP DIAMOND_STOP': bracketed(
    'hexagon',
    [1, 2],
    3,
    [4, 5],
  ),
  'vertex: idString TAGEND text SQE': bracketed('odd', [1], 2, [3]),
  'vertex: idString TRAPSTART text TRAPEND': bracketed('trapezoid', [1], 2, [3]),
  'vertex: idString INVTRAPSTART text INVTRAPEND': bracketed('inv_trapezoid', [1], 2, [3]),
  'vertex: idString TRAPSTART text INVTRAPEND': bracketed('lean_right', [1], 2, [3]),
  'vertex: idString INVTRAPSTART text TRAPEND': bracketed('lean_left', [1], 2, [3]),
  'vertex: idString': (kids, reader) => reader.vertex(kids, undefined, [], 0, []),

  'link: linkStatement arrowText': (kids): LinkValue => {
    const link = kids[0].value as LinkValue
    const label = kids[1].value as MermaidFlowLabel
    return { ...link, text: { text: label.text, type: label.type }, form: 'pipe', label }
  },
  'link: linkStatement arrowText SPACE': (kids): LinkValue => {
    const link = kids[0].value as LinkValue
    const label = kids[1].value as MermaidFlowLabel
    return { ...link, text: { text: label.text, type: label.type }, form: 'pipe', label }
  },
  'link: linkStatement TESTSTR SPACE': () => {
    throw new MermaidReadFailure('unsure', 'a link form mermaid’s lexer never produces')
  },
  'link: START_LINK edgeText LINK': (kids, reader): LinkValue => {
    const value = kids[1].value as TextValue
    return {
      ...destructLink(kids[2].value as string, kids[0].value as string),
      text: value,
      form: 'inline',
      label: { text: value.text, type: value.type, inner: reader.between(kids[0], kids[2]) },
    }
  },
  'link: LINK_ID START_LINK edgeText LINK': (kids, reader): LinkValue => {
    const value = kids[2].value as TextValue
    return {
      ...destructLink(kids[3].value as string, kids[1].value as string),
      text: value,
      id: kids[0].value as string,
      form: 'inline',
      label: { text: value.text, type: value.type, inner: reader.between(kids[1], kids[3]) },
    }
  },
  'linkStatement: LINK': (kids): LinkValue => ({
    ...destructLink(kids[0].value as string),
    form: 'plain',
    label: null,
  }),
  'linkStatement: LINK_ID LINK': (kids): LinkValue => ({
    ...destructLink(kids[1].value as string),
    id: kids[0].value as string,
    form: 'plain',
    label: null,
  }),
  'arrowText: PIPE text PIPE': (kids, reader): MermaidFlowLabel => {
    const value = kids[1].value as TextValue
    return { text: value.text, type: value.type, inner: reader.between(kids[0], kids[2]) }
  },

  'edgeText: edgeTextToken': textOf('text'),
  'edgeText: edgeText edgeTextToken': appendText,
  'edgeText: STR': textOf('string'),
  'edgeText: MD_STR': textOf('markdown'),
  'text: textToken': textOf('text'),
  'text: text textToken': appendText,
  'text: STR': textOf('string'),
  'text: MD_STR': textOf('markdown'),
  'textNoTags: textNoTagsToken': textOf('text'),
  'textNoTags: textNoTags textNoTagsToken': appendText,
  // Not a slip: mermaid types a quoted group name as plain text.
  'textNoTags: STR': textOf('text'),
  'textNoTags: MD_STR': textOf('markdown'),

  'classDefStatement: CLASSDEF SPACE idString SPACE stylesOpt': (kids, reader) => {
    reader.db.addClass(kids[2].value as string, kids[4].value as string[])
    return {}
  },
  'classStatement: CLASS SPACE idString SPACE idString': (kids, reader) => {
    reader.db.setClass(kids[2].value as string, kids[4].value as string)
    return { targets: reader.idList(kids[2]), targetsSpan: reader.span(kids[2]), className: kids[4].value as string }
  },
  'clickStatement: CLICK CALLBACKNAME': click,
  'clickStatement: CLICK CALLBACKNAME SPACE STR': click,
  'clickStatement: CLICK CALLBACKNAME CALLBACKARGS': click,
  'clickStatement: CLICK CALLBACKNAME CALLBACKARGS SPACE STR': click,
  'clickStatement: CLICK HREF STR': click,
  'clickStatement: CLICK HREF STR SPACE STR': click,
  'clickStatement: CLICK HREF STR SPACE LINK_TARGET': click,
  'clickStatement: CLICK HREF STR SPACE STR SPACE LINK_TARGET': click,
  'clickStatement: CLICK alphaNum': click,
  'clickStatement: CLICK alphaNum SPACE STR': click,
  'clickStatement: CLICK STR': click,
  'clickStatement: CLICK STR SPACE STR': click,
  'clickStatement: CLICK STR SPACE LINK_TARGET': click,
  'clickStatement: CLICK STR SPACE STR SPACE LINK_TARGET': click,
  'styleStatement: STYLE SPACE idString SPACE stylesOpt': (kids, reader) => {
    reader.db.addVertex(kids[2].value as string, undefined, undefined, kids[4].value as string[], undefined)
    return { target: kids[2].value as string, targetSpan: reader.span(kids[2]) }
  },
  'linkStyleStatement: LINKSTYLE SPACE DEFAULT SPACE stylesOpt': linkStyle(null, 4),
  'linkStyleStatement: LINKSTYLE SPACE numList SPACE stylesOpt': linkStyle(null, 4),
  'linkStyleStatement: LINKSTYLE SPACE DEFAULT SPACE INTERPOLATE SPACE alphaNum SPACE stylesOpt': linkStyle(6, 8),
  'linkStyleStatement: LINKSTYLE SPACE numList SPACE INTERPOLATE SPACE alphaNum SPACE stylesOpt': linkStyle(6, 8),
  'linkStyleStatement: LINKSTYLE SPACE DEFAULT SPACE INTERPOLATE SPACE alphaNum': linkStyle(6, null),
  'linkStyleStatement: LINKSTYLE SPACE numList SPACE INTERPOLATE SPACE alphaNum': linkStyle(6, null),
  'numList: NUM': (kids, reader) => [{ value: kids[0].value as string, span: reader.span(kids[0]) }],
  'numList: numList COMMA NUM': (kids, reader) => {
    const list = kids[0].value as { value: string; span: MermaidSourceSpan }[]
    list.push({ value: kids[2].value as string, span: reader.span(kids[2]) })
    return list
  },
  'stylesOpt: style': (kids) => [kids[0].value as string],
  'stylesOpt: stylesOpt COMMA style': (kids) => {
    const list = kids[0].value as string[]
    list.push(kids[2].value as string)
    return list
  },
  'style: style styleComponent': concatenate,
  'idString: idString idStringToken': concatenate,
  'alphaNum: alphaNum alphaNumToken': concatenate,
  'direction: direction_tb': direction('TB'),
  'direction: direction_bt': direction('BT'),
  'direction: direction_rl': direction('RL'),
  'direction: direction_lr': direction('LR'),
  'direction: direction_td': direction('TD'),
}

/** Productions whose value is simply their first symbol's, as in jison's default action. */
const PASS_THROUGH: ReadonlySet<string> = new Set([
  'line: statement',
  'line: SEMI',
  'line: NEWLINE',
  'line: SPACE',
  'line: EOF',
  'FirstStmtSeparator: SEMI',
  'FirstStmtSeparator: NEWLINE',
  'FirstStmtSeparator: spaceList NEWLINE',
  'spaceList: SPACE spaceList',
  'spaceList: SPACE',
  'separator: NEWLINE',
  'separator: SEMI',
  'separator: EOF',
  'shapeData: SHAPE_DATA',
  'styledVertex: vertex',
  'link: linkStatement',
  'keywords: STYLE',
  'keywords: LINKSTYLE',
  'keywords: CLASSDEF',
  'keywords: CLASS',
  'keywords: CLICK',
  'keywords: GRAPH',
  'keywords: DIR',
  'keywords: subgraph',
  'keywords: end',
  'keywords: DOWN',
  'keywords: UP',
  'style: styleComponent',
  'styleComponent: NUM',
  'styleComponent: NODE_STRING',
  'styleComponent: COLON',
  'styleComponent: UNIT',
  'styleComponent: SPACE',
  'styleComponent: BRKT',
  'styleComponent: STYLE',
  'styleComponent: PCT',
  'idStringToken: NUM',
  'idStringToken: NODE_STRING',
  'idStringToken: DOWN',
  'idStringToken: MINUS',
  'idStringToken: DEFAULT',
  'idStringToken: COMMA',
  'idStringToken: COLON',
  'idStringToken: AMP',
  'idStringToken: BRKT',
  'idStringToken: MULT',
  'idStringToken: UNICODE_TEXT',
  'textToken: TEXT',
  'textToken: TAGSTART',
  'textToken: TAGEND',
  'textToken: UNICODE_TEXT',
  'textNoTagsToken: NUM',
  'textNoTagsToken: NODE_STRING',
  'textNoTagsToken: SPACE',
  'textNoTagsToken: MINUS',
  'textNoTagsToken: AMP',
  'textNoTagsToken: UNICODE_TEXT',
  'textNoTagsToken: COLON',
  'textNoTagsToken: MULT',
  'textNoTagsToken: BRKT',
  'textNoTagsToken: keywords',
  'textNoTagsToken: START_LINK',
  'edgeTextToken: EDGE_TEXT',
  'edgeTextToken: UNICODE_TEXT',
  'alphaNumToken: NUM',
  'alphaNumToken: UNICODE_TEXT',
  'alphaNumToken: NODE_STRING',
  'alphaNumToken: DIR',
  'alphaNumToken: DOWN',
  'alphaNumToken: MINUS',
  'alphaNumToken: COMMA',
  'alphaNumToken: COLON',
  'alphaNumToken: AMP',
  'alphaNumToken: BRKT',
  'alphaNumToken: MULT',
  'idString: idStringToken',
  'alphaNum: alphaNumToken',
])

// ---------------------------------------------------------------------------
// Reading a flowchart
// ---------------------------------------------------------------------------

function finishStatements(
  reader: Reader,
  lines: MermaidSourceLine[],
): { statements: MermaidFlowStatement[]; edges: MermaidFlowEdgeSite[] } {
  const statements: MermaidFlowStatement[] = []
  const owners = new Map<VertexStatementValue, number>()

  const visit = (drafts: StatementDraft[], parent: number | null): number[] => {
    const indices: number[] = []
    for (const draft of drafts) {
      const index = statements.length
      indices.push(index)
      // Without the whitespace at either end: a group's `end` token swallows
      // what follows it, and a `direction` token its own indentation.
      const whole = reader.range(draft.first, draft.last)
      const written = reader.source.slice(whole.start, whole.end)
      const span = {
        start: whole.start + (written.length - written.trimStart().length),
        end: whole.end - (written.length - written.trimEnd().length),
      }
      const common: StatementCommon = {
        index,
        span,
        parent,
        line: mermaidSourceLineAt(lines, span.start),
        endLine: mermaidSourceLineAt(lines, Math.max(span.start, span.end - 1)),
        separator: draft.separator,
      }
      if (draft.kind === 'vertex') {
        const value = draft.details.value as VertexStatementValue
        owners.set(value, index)
        const groups = value.groups.map((group, groupIndex) =>
          group.mentions.map((mention, position) => {
            mention.statement = index
            mention.group = groupIndex
            mention.position = position
            return mention
          }),
        )
        statements.push({ ...common, kind: 'vertex', groups, links: value.links })
      } else if (draft.kind === 'group') {
        const placeholder = {
          ...common,
          kind: 'group',
          body: [] as number[],
          ...draft.details,
        } as MermaidFlowGroupStatement
        statements.push(placeholder)
        placeholder.body = visit(draft.children, index)
      } else {
        statements.push({ ...common, kind: draft.kind, ...draft.details } as MermaidFlowStatement)
      }
    }
    return indices
  }
  visit(reader.top?.drafts ?? [], null)

  const edges = reader.sites.map((site) => ({
    statement: owners.get(site.owner) ?? -1,
    link: site.link,
    start: site.start,
    end: site.end,
  }))
  return { statements, edges }
}

/** What the flowchart reader makes of a text it read to the end. */
type FlowResult = {
  header: MermaidFlowHeader | null
  statements: MermaidFlowStatement[]
  edges: MermaidFlowEdgeSite[]
  reading: MermaidFlowReading
}

/**
 * Mermaid's flowchart parser is wrapped in a function that strips the
 * whitespace between a `}` and the end of its line before parsing. The `}` and
 * the newline stay; what is between them goes.
 */
const SPACE_AFTER_BRACE: MermaidSourceRewrite = {
  pattern: /\}\s*\n/g,
  remove: (match) => (match[0].length > 2 ? { from: 1, to: match[0].length - 1 } : null),
}

type FlowLanguage = MermaidSourceLanguage<Reader, FlowResult>
let language: FlowLanguage | undefined
let loading: Promise<void> | undefined

/**
 * Fetch mermaid's flowchart grammar and make it runnable. It is some 36 KB of
 * tables, so it is imported dynamically — which makes it a chunk of its own,
 * fetched the first time a flowchart is opened in the builder rather than with
 * the app. Nothing may import `MermaidFlowGrammar` statically, or that is
 * undone. Everything else here is synchronous once it has arrived. Safe to call
 * any number of times.
 */
export function loadMermaidFlowGrammar(): Promise<void> {
  if (!loading) {
    loading = import('./MermaidFlowGrammar').then((module) => {
      language = {
        recognises: /^\s*(?:graph|flowchart)(?![\w-])/,
        otherKind: 'This is not a flowchart.',
        grammar: compileMermaidGrammar(module.MERMAID_FLOW_GRAMMAR, HANDLERS, PASS_THROUGH),
        rewrites: [SPACE_AFTER_BRACE],
        begin: (source, pieces) => new Reader(source, pieces),
        finish: (reader, lines) => ({
          header: reader.header,
          ...finishStatements(reader, lines),
          reading: reader.db.reading(),
        }),
      }
    })
  }
  return loading
}

function flowLanguage(): FlowLanguage {
  if (!language) {
    // A wiring fault, not something about the text: say so rather than report
    // every diagram as unreadable.
    throw new Error('The flowchart grammar is not loaded: await loadMermaidFlowGrammar() first.')
  }
  return language
}

/** Has `loadMermaidFlowGrammar` finished? */
export function isMermaidFlowGrammarLoaded(): boolean {
  return language !== undefined
}

/**
 * The productions of the loaded grammar the reader gives no meaning to. Empty,
 * or the builder would be reading some statement by default rules; the spec
 * holds it at empty so that a regenerated grammar with a new production is
 * noticed before anything is edited with it.
 */
export function unhandledMermaidFlowProductions(): string[] {
  return [...flowLanguage().grammar.unhandled]
}

/** The mermaid version the loaded grammar was generated from. */
export function mermaidFlowGrammarVersion(): string {
  return flowLanguage().grammar.mermaid
}

/**
 * The flowchart lexer's tokens for a source, as mermaid's own lexer would
 * report them. For the contract test; nothing in the app calls it.
 */
export function lexMermaidFlowSource(source: string): { token: string | null; text: string }[] {
  return lexMermaidSource(source, flowLanguage())
}

/**
 * Read a flowchart's text. Never throws for any text, and never loses a
 * character: whatever `source` is, the pieces of the result print back to it.
 * The grammar has to have been loaded (`loadMermaidFlowGrammar`).
 */
export function parseMermaidFlowSource(source: string): MermaidFlowDocument {
  const { result, ...document } = parseMermaidSource(source, flowLanguage())
  return {
    ...document,
    header: result?.header ?? null,
    statements: result?.statements ?? [],
    edges: result?.edges ?? [],
    reading: result?.reading ?? null,
  }
}

/** The text a document was read from, rebuilt from its pieces. */
export const printMermaidFlowDocument = printMermaidSourceDocument

// ---------------------------------------------------------------------------
// Is this module's reading the one mermaid has?
// ---------------------------------------------------------------------------

const sameList = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  (a === undefined) === (b === undefined) &&
  (a === undefined || (a.length === b?.length && a.every((value, index) => value === b[index])))

/**
 * Could mermaid have made `theirs` out of the label this module read as `ours`?
 *
 * Mermaid keeps a label as DOMPurify serialises it — `&` becomes `&amp;`, an
 * unknown tag disappears, an unclosed one swallows the rest — and this module
 * does not sanitise. What the sanitiser cannot change is everything BEFORE the
 * label's first `<`, `>`, `&` or no-break space, so that is what is compared:
 * mermaid's text has to begin with it. For a label with no such character,
 * which is nearly all of them, that is the whole label and the two must be
 * equal.
 */
const MARKUP_ONWARDS = new RegExp('[<>&' + String.fromCharCode(160) + '][^]*$')
const beforeMarkup = (value: string): string => value.replace(MARKUP_ONWARDS, '').replace(/\s+/g, ' ').trim()
function sameLabelSoFar(ours: string, theirs: string): boolean {
  const prefix = beforeMarkup(ours)
  if (prefix.length === ours.replace(/\s+/g, ' ').trim().length) {
    return prefix === beforeMarkup(theirs) && !MARKUP_ONWARDS.test(theirs)
  }
  return beforeMarkup(theirs).startsWith(prefix)
}

/**
 * Every way `ours` (this module's imitation) differs from `theirs` (mermaid's
 * own reading of the same text). Empty means the builder knows where every box,
 * link and group of this diagram is written. Anything else means it does not,
 * and nothing may be edited: the differences are returned as sentences, for the
 * refusal.
 *
 * Deliberately not compared: a label from its first markup character on
 * (mermaid sanitises, this module does not), the text and shape of a box given
 * `@{…}`, and `extra`.
 */
export function compareMermaidFlowReadings(ours: MermaidFlowReading, theirs: MermaidFlowReading): string[] {
  const differences: string[] = []
  const differ = (what: string, mine: unknown, mermaids: unknown) => {
    differences.push(`${what}: the builder reads ${JSON.stringify(mine)}, mermaid reads ${JSON.stringify(mermaids)}`)
  }
  if (ours.direction !== theirs.direction) {
    differ('direction', ours.direction, theirs.direction)
  }

  const ourIds = ours.nodes.map((node) => node.id)
  const theirIds = theirs.nodes.map((node) => node.id)
  if (!sameList(ourIds, theirIds)) {
    differ('boxes', ourIds, theirIds)
  } else {
    ours.nodes.forEach((node, index) => {
      const other = theirs.nodes[index]
      if (!node.shapeData) {
        if (node.type !== other.type) {
          differ(`shape of ${node.id}`, node.type, other.type)
        }
        if (!sameLabelSoFar(node.text, other.text)) {
          differ(`label of ${node.id}`, node.text, other.text)
        }
        if (node.labelType !== other.labelType) {
          differ(`label kind of ${node.id}`, node.labelType, other.labelType)
        }
      }
      if (!sameList(node.classes, other.classes)) {
        differ(`classes of ${node.id}`, node.classes, other.classes)
      }
      if (!sameList(node.styles, other.styles)) {
        differ(`styles of ${node.id}`, node.styles, other.styles)
      }
    })
  }

  if (ours.edges.length !== theirs.edges.length) {
    differ('number of links', ours.edges.length, theirs.edges.length)
  } else {
    ours.edges.forEach((edge, index) => {
      const other = theirs.edges[index]
      const name = `link ${index}`
      if (edge.start !== other.start || edge.end !== other.end) {
        differ(`ends of ${name}`, [edge.start, edge.end], [other.start, other.end])
      }
      if (edge.type !== other.type || edge.stroke !== other.stroke || edge.length !== other.length) {
        differ(`line of ${name}`, [edge.type, edge.stroke, edge.length], [other.type, other.stroke, other.length])
      }
      if (!sameLabelSoFar(edge.text, other.text) || edge.labelType !== other.labelType) {
        differ(`text of ${name}`, [edge.text, edge.labelType], [other.text, other.labelType])
      }
      if (edge.id !== other.id) {
        differ(`id of ${name}`, edge.id, other.id)
      }
      if (!sameList(edge.classes, other.classes)) {
        differ(`classes of ${name}`, edge.classes, other.classes)
      }
      if (!sameList(edge.style, other.style)) {
        differ(`style of ${name}`, edge.style, other.style)
      }
      if (edge.interpolate !== other.interpolate) {
        differ(`curve of ${name}`, edge.interpolate, other.interpolate)
      }
    })
  }

  const ourGroups = ours.groups.map((group) => group.id)
  const theirGroups = theirs.groups.map((group) => group.id)
  if (!sameList(ourGroups, theirGroups)) {
    differ('groups', ourGroups, theirGroups)
  } else {
    ours.groups.forEach((group, index) => {
      const other = theirs.groups[index]
      if (!sameList(group.nodes, other.nodes)) {
        differ(`boxes in group ${group.id}`, group.nodes, other.nodes)
      }
      if (group.dir !== other.dir) {
        differ(`direction of group ${group.id}`, group.dir, other.dir)
      }
      if (!sameLabelSoFar(group.title, other.title) || group.labelType !== other.labelType) {
        differ(`title of group ${group.id}`, [group.title, group.labelType], [other.title, other.labelType])
      }
      if (!sameList(group.classes, other.classes)) {
        differ(`classes of group ${group.id}`, group.classes, other.classes)
      }
    })
  }

  const ourClasses = ours.classes.map((entry) => `${entry.id}=${entry.styles.join(';')}|${entry.textStyles.join(';')}`)
  const theirClasses = theirs.classes.map(
    (entry) => `${entry.id}=${entry.styles.join(';')}|${entry.textStyles.join(';')}`,
  )
  if (!sameList(ourClasses, theirClasses)) {
    differ('named styles', ourClasses, theirClasses)
  }
  if (!sameList(ours.defaultLinkStyle, theirs.defaultLinkStyle)) {
    differ('default link style', ours.defaultLinkStyle, theirs.defaultLinkStyle)
  }
  if (ours.defaultInterpolate !== theirs.defaultInterpolate) {
    differ('default link curve', ours.defaultInterpolate, theirs.defaultInterpolate)
  }
  return differences
}
