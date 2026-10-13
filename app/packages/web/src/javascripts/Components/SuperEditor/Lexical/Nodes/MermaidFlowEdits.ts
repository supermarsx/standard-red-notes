/**
 * Standard Red Notes — what the visual builder can DO to a flowchart's text.
 *
 * Every operation here is a small change to the text, never a rewrite of it:
 * a label is replaced where it is written, a new box is one new line, a link
 * that goes takes only its own characters with it. The text an operation does
 * not own — other statements, comments, blank lines, indentation, the
 * frontmatter — is left byte for byte as it was.
 *
 * HOW AN OPERATION IS HELD TO THAT
 *
 * An operation returns two things: the new text, and what the diagram must
 * mean afterwards, stated as a change to mermaid's reading of it ("the same
 * reading, with this box's text replaced"). `applyMermaidFlowEdit` in
 * MermaidOracle.ts then asks mermaid what the new text means and keeps the edit
 * only if that is exactly it.
 *
 * Before that, the same question is asked here, of the builder's own reading
 * of its own result (`MermaidSourceDoc`, which is checked against mermaid
 * separately). An operation with several ways of writing the same change —
 * taking one link out of `A --> B & C` can leave a line, two lines, or none —
 * tries them from the most natural to the most explicit and returns the first
 * that reads right. One that cannot be written so that it reads right is
 * REFUSED, with the reason, and the text is not touched.
 *
 * WHAT IS REFUSED BY NAME
 *
 * A box whose label or shape is set with `@{ … }` (YAML this app does not
 * edit); an id that is a reserved word or already in use; a statement that
 * contains an entity code split across tokens; a group written on one line.
 * Each refusal says which line.
 */
import {
  judgeMermaidFlowReading,
  type MermaidFlowEdit,
  type MermaidFlowEditPlan,
  type MermaidFlowElementRef,
  type MermaidFlowExpectation,
} from './MermaidOracle'
import {
  type MermaidFlowDocument,
  type MermaidFlowEdgeReading,
  type MermaidFlowGroupStatement,
  type MermaidFlowLabelType,
  type MermaidFlowLinkStyleStatement,
  type MermaidFlowMention,
  type MermaidFlowReading,
  type MermaidFlowStatement,
  type MermaidFlowVertexStatement,
  parseMermaidFlowSource,
} from './MermaidFlowDoc'
import {
  applyMermaidSourceSplices,
  MermaidEditRefusal,
  MermaidSourceBench,
  type MermaidSourceSplice,
  type MermaidSourceSpan,
} from './MermaidSourceDoc'

// ---------------------------------------------------------------------------
// The vocabulary the builder writes
// ---------------------------------------------------------------------------

/**
 * The shapes mermaid writes with brackets, by mermaid's own names, each with
 * the delimiters it is written in. The other shapes mermaid knows are written
 * as `@{ shape: … }`; the builder shows and keeps those, and does not set them.
 */
export const MERMAID_FLOW_BRACKET_SHAPES = {
  square: ['[', ']'],
  round: ['(', ')'],
  stadium: ['([', '])'],
  subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'],
  circle: ['((', '))'],
  diamond: ['{', '}'],
  hexagon: ['{{', '}}'],
  odd: ['>', ']'],
  lean_right: ['[/', '/]'],
  lean_left: ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'],
  inv_trapezoid: ['[\\', '/]'],
  doublecircle: ['(((', ')))'],
  ellipse: ['(-', '-)'],
} as const
export type MermaidFlowBracketShape = keyof typeof MERMAID_FLOW_BRACKET_SHAPES

export function isMermaidFlowBracketShape(value: unknown): value is MermaidFlowBracketShape {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MERMAID_FLOW_BRACKET_SHAPES, value)
}

export const MERMAID_FLOW_LINK_STROKES = ['normal', 'thick', 'dotted', 'invisible'] as const
export type MermaidFlowLinkStroke = (typeof MERMAID_FLOW_LINK_STROKES)[number]

/** What is drawn at a link's ends: nothing, or a head at the far end, or the same head at both. */
export const MERMAID_FLOW_LINK_ENDS = [
  'none',
  'arrow',
  'circle',
  'cross',
  'both-arrows',
  'both-circles',
  'both-crosses',
] as const
export type MermaidFlowLinkEnds = (typeof MERMAID_FLOW_LINK_ENDS)[number]

/** How a link is drawn. `length` is how many ranks it spans: 1 is the ordinary link. */
export type MermaidFlowLinkLook = { stroke: MermaidFlowLinkStroke; ends: MermaidFlowLinkEnds; length: number }

export const DEFAULT_MERMAID_FLOW_LINK_LOOK: MermaidFlowLinkLook = { stroke: 'normal', ends: 'arrow', length: 1 }

const ENDS_TO_TYPE: Record<MermaidFlowLinkEnds, string> = {
  none: 'arrow_open',
  arrow: 'arrow_point',
  circle: 'arrow_circle',
  cross: 'arrow_cross',
  'both-arrows': 'double_arrow_point',
  'both-circles': 'double_arrow_circle',
  'both-crosses': 'double_arrow_cross',
}

/** How mermaid's reading of a link is drawn, in the builder's terms; null for a link the builder cannot describe. */
export function mermaidFlowLinkLookOf(
  edge: Pick<MermaidFlowEdgeReading, 'type' | 'stroke' | 'length'>,
): MermaidFlowLinkLook | null {
  const ends = MERMAID_FLOW_LINK_ENDS.find((candidate) => ENDS_TO_TYPE[candidate] === edge.type)
  const stroke = MERMAID_FLOW_LINK_STROKES.find((candidate) => candidate === edge.stroke)
  if (!ends || !stroke || typeof edge.length !== 'number' || edge.length < 1) {
    return null
  }
  return { stroke, ends, length: edge.length }
}

/** The longest link mermaid keeps: it caps a longer one at ten ranks. */
const MAX_LINK_LENGTH = 10

/** The characters a link of this look is written with: `-->`, `-.->`, `<==>`, `~~~`. */
export function mermaidFlowArrow(look: MermaidFlowLinkLook): string {
  const length = Math.max(1, Math.min(MAX_LINK_LENGTH, Math.round(look.length)))
  if (look.stroke === 'invisible') {
    return '~'.repeat(length + 2)
  }
  const both = look.ends.startsWith('both-')
  const head = look.ends === 'arrow' || look.ends === 'both-arrows' ? '>' : look.ends.includes('circle') ? 'o' : 'x'
  const tail = look.ends === 'none' ? '' : head
  const lead = both ? (head === '>' ? '<' : head) : ''
  if (look.stroke === 'dotted') {
    return `${lead}-${'.'.repeat(length)}-${tail}`
  }
  const dash = look.stroke === 'thick' ? '=' : '-'
  // An open link is one dash longer: its last dash stands where the head would.
  return `${lead}${dash.repeat(length + 1)}${look.ends === 'none' ? dash : tail}`
}

export const MERMAID_FLOW_DIRECTIONS = ['TB', 'TD', 'BT', 'LR', 'RL'] as const
export type MermaidFlowDirection = (typeof MERMAID_FLOW_DIRECTIONS)[number]

// ---------------------------------------------------------------------------
// Refusing
// ---------------------------------------------------------------------------

const refuse = (reason: string, line?: number): never => {
  throw new MermaidEditRefusal(reason, line)
}

// ---------------------------------------------------------------------------
// Ids and labels as they are written
// ---------------------------------------------------------------------------

/**
 * Words mermaid's flowchart lexer reads as something other than a box's name,
 * and the three single letters it reads as part of an arrow or a direction.
 */
const RESERVED_IDS: ReadonlySet<string> = new Set([
  'graph',
  'flowchart',
  'subgraph',
  'end',
  'style',
  'linkStyle',
  'classDef',
  'class',
  'click',
  'href',
  'call',
  'default',
  'interpolate',
  'direction',
  'accTitle',
  'accDescr',
  '_self',
  '_blank',
  '_parent',
  '_top',
  'x',
  'o',
  'v',
])

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Why `id` cannot be given to a new box or group, or null when it can. */
export function mermaidFlowIdProblem(id: string, reading: MermaidFlowReading): string | null {
  if (id === '') {
    return 'A box needs a name.'
  }
  if (!SAFE_ID.test(id)) {
    return 'Use letters, digits and _ for a name, starting with a letter.'
  }
  if (RESERVED_IDS.has(id)) {
    return `"${id}" is a word mermaid keeps for itself.`
  }
  if (/^L_.*_\d+$/.test(id) || /^subGraph\d+$/.test(id)) {
    return `"${id}" is a name mermaid makes up for its own use.`
  }
  if (reading.nodes.some((node) => node.id === id)) {
    return `There is already a box called "${id}".`
  }
  if (reading.groups.some((group) => group.id === id)) {
    return `There is already a group called "${id}".`
  }
  if (reading.edges.some((edge) => edge.id === id)) {
    return `There is already a link called "${id}".`
  }
  if (reading.classes.some((entry) => entry.id === id)) {
    return `"${id}" is already the name of a style.`
  }
  return null
}

/** The next free name in a series: `A`…`Z`, then `A1`…; or `G1`, `G2`… for a group. */
export function nextMermaidFlowId(reading: MermaidFlowReading, kind: 'node' | 'group' = 'node'): string {
  const free = (candidate: string) => mermaidFlowIdProblem(candidate, reading) === null
  if (kind === 'group') {
    for (let number = 1; ; number++) {
      if (free(`G${number}`)) {
        return `G${number}`
      }
    }
  }
  for (let suffix = 0; ; suffix++) {
    for (let letter = 0; letter < 26; letter++) {
      const candidate = String.fromCharCode(65 + letter) + (suffix === 0 ? '' : String(suffix))
      if (free(candidate)) {
        return candidate
      }
    }
  }
}

/** A label that reads the same quoted or not, wherever between brackets it is written. */
const PLAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N} _.,!?'-]*[\p{L}\p{N}.!?])?$/u
/** The same for text written inside an arrow (`-- text -->`), where a dash, a dot or an equals sign ends it. */
const PLAIN_INLINE_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N} _,!?']*[\p{L}\p{N}!?])?$/u

type WrittenLabel = { source: string; type: MermaidFlowLabelType; text: string }

/**
 * A typed label as mermaid source. `form` is how the label it replaces was
 * written: plain text stays unquoted when the new text is safe unquoted, a
 * markdown string stays one, and everything else is quoted.
 */
function writeLabel(typed: string, form: MermaidFlowLabelType, plain: RegExp = PLAIN_LABEL): WrittenLabel {
  const text = typed.replace(/\r\n?|\n/g, '<br/>').trim()
  const quotedText = text.replace(/"/g, '#quot;')
  if (form === 'markdown') {
    if (text.includes('`')) {
      return refuse('A label written in markdown cannot contain a backtick.')
    }
    return { source: '"`' + quotedText + '`"', type: 'markdown', text }
  }
  if (form === 'text' && plain.test(text)) {
    return { source: text, type: 'text', text }
  }
  // Mermaid has no empty string: a quoted space is how a box is left blank.
  return { source: `"${quotedText === '' ? ' ' : quotedText}"`, type: 'string', text }
}

// ---------------------------------------------------------------------------
// Readings, copied and changed
// ---------------------------------------------------------------------------

function copyReading(reading: MermaidFlowReading): MermaidFlowReading {
  return {
    ...reading,
    nodes: reading.nodes.map((node) => ({ ...node, classes: [...node.classes], styles: [...node.styles] })),
    edges: reading.edges.map((edge) => ({
      ...edge,
      classes: [...edge.classes],
      style: edge.style ? [...edge.style] : undefined,
    })),
    groups: reading.groups.map((group) => ({ ...group, nodes: [...group.nodes], classes: [...group.classes] })),
    classes: reading.classes.map((entry) => ({
      ...entry,
      styles: [...entry.styles],
      textStyles: [...entry.textStyles],
    })),
    extra: reading.extra ? { ...reading.extra } : undefined,
  }
}

type Expect = (before: MermaidFlowReading) => MermaidFlowExpectation

const expectation = (
  reading: MermaidFlowReading,
  marks: Partial<Omit<MermaidFlowExpectation, 'reading'>> = {},
): MermaidFlowExpectation => ({
  reading,
  created: marks.created ?? [],
  relabelled: marks.relabelled ?? [],
  reordered: marks.reordered ?? [],
})

/** Tooltips are filed by box id, in what mermaid carries beyond boxes and links. */
function mapTooltips(reading: MermaidFlowReading, change: (id: string) => string | null): void {
  const tooltips = reading.extra?.tooltips
  if (!Array.isArray(tooltips) || !reading.extra) {
    return
  }
  const next = (tooltips as [string, unknown][]).flatMap(([id, tip]): [string, unknown][] => {
    const renamed = change(id)
    return renamed === null ? [] : [[renamed, tip]]
  })
  if (next.length > 0) {
    reading.extra.tooltips = next
  } else {
    delete reading.extra.tooltips
    if (Object.keys(reading.extra).length === 0) {
      reading.extra = undefined
    }
  }
}

const newEdge = (
  start: string,
  end: string,
  look: MermaidFlowLinkLook,
  label: WrittenLabel | null,
): MermaidFlowEdgeReading => ({
  start,
  end,
  type: look.stroke === 'invisible' ? 'arrow_open' : ENDS_TO_TYPE[look.ends],
  stroke: look.stroke,
  length: Math.max(1, Math.min(MAX_LINK_LENGTH, Math.round(look.length))),
  text: label ? label.text : '',
  labelType: label ? label.type : 'text',
  id: undefined,
  classes: [],
  style: undefined,
  interpolate: undefined,
})

// ---------------------------------------------------------------------------
// The document, as an operation needs to ask about it
// ---------------------------------------------------------------------------

/** A statement's boxes and links as text, for writing it again without one of them. */
type IrNode = { id: string; text: string; mention: MermaidFlowMention | null }
type IrStatement = { groups: IrNode[][]; links: string[] }

const bareNode = (id: string): IrNode => ({ id, text: id, mention: null })

type Splice = MermaidSourceSplice

/** The flowchart an operation is about to change: the generic bench, plus what a flowchart adds to ask. */
class Workbench extends MermaidSourceBench {
  readonly document: MermaidFlowDocument
  /** The builder's own reading of the text as it is: what candidates are checked against. */
  readonly ownReading: MermaidFlowReading

  constructor(document: MermaidFlowDocument) {
    super(document)
    this.document = document
    if (!document.reading) {
      throw new MermaidEditRefusal('The builder could not read this diagram.')
    }
    this.ownReading = document.reading
  }

  // --- finding things -----------------------------------------------------

  get vertexStatements(): MermaidFlowVertexStatement[] {
    return this.document.statements.filter(
      (statement): statement is MermaidFlowVertexStatement => statement.kind === 'vertex',
    )
  }

  mentionsOf(id: string): MermaidFlowMention[] {
    return this.vertexStatements.flatMap((statement) => statement.groups.flat().filter((mention) => mention.id === id))
  }

  /** Where a box first comes into being: its first mention, or a `style` line that names it earlier. */
  createdAt(id: string): number {
    let first = Number.POSITIVE_INFINITY
    for (const statement of this.document.statements) {
      if (statement.kind === 'vertex') {
        for (const mention of statement.groups.flat()) {
          if (mention.id === id) {
            first = Math.min(first, mention.idSpan.start)
          }
        }
      } else if (statement.kind === 'style' && statement.target === id) {
        first = Math.min(first, statement.span.start)
      }
    }
    return first
  }

  groupStatement(id: string): MermaidFlowGroupStatement {
    const found = this.document.statements.filter(
      (statement): statement is MermaidFlowGroupStatement => statement.kind === 'group' && statement.id === id,
    )
    if (found.length === 0) {
      return refuse(`There is no group called "${id}".`)
    }
    if (found.length > 1) {
      return refuse(`Two groups are called "${id}"; edit them in the code.`, found[1].line)
    }
    return found[0]
  }

  /** The group statements around a statement, innermost last; empty at the top level. */
  ancestors(parent: number | null): number[] {
    const chain: number[] = []
    for (let at = parent; at !== null; at = this.document.statements[at].parent) {
      chain.unshift(at)
    }
    return chain
  }

  /** The block both groups are inside: a group statement's index, or null for the top level. */
  commonBlock(first: number | null, second: number | null): number | null {
    const a = this.ancestors(first)
    const b = this.ancestors(second)
    let common: number | null = null
    for (let depth = 0; depth < Math.min(a.length, b.length) && a[depth] === b[depth]; depth++) {
      common = a[depth]
    }
    return common
  }

  /** The index of the group statement a box belongs to by mermaid's reading, or null. */
  blockOfNode(id: string, reading: MermaidFlowReading): number | null {
    const group = reading.groups.find((candidate) => candidate.nodes.includes(id))
    return group ? this.groupStatement(group.id).index : null
  }

  /** Does this statement, or anything inside it, mention one of these boxes? */
  mentions(statement: MermaidFlowStatement, ids: ReadonlySet<string>): boolean {
    if (statement.kind === 'vertex') {
      return statement.groups.some((group) => group.some((mention) => ids.has(mention.id)))
    }
    if (statement.kind === 'group') {
      return statement.body.some((index) => this.mentions(this.document.statements[index], ids))
    }
    return false
  }

  /** How many links are written before `offset`: the number a link written there would get. */
  edgesBefore(offset: number): number {
    return this.document.edges.filter((site) => this.document.statements[site.statement].span.start < offset).length
  }

  // --- can this be rewritten? ---------------------------------------------

  /** Does the statement have its line, or lines, to itself? */
  ownsItsLines(statement: MermaidFlowStatement): boolean {
    const first = this.document.lines[statement.line]
    const last = this.document.lines[statement.endLine]
    const before = this.source.slice(first.start, statement.span.start)
    const after = this.source.slice(statement.span.end, last.end)
    return /^[ \t]*$/.test(before) && /^[ \t]*;?[ \t]*$/.test(after)
  }

  // --- writing ------------------------------------------------------------

  /** A statement replaced by others — by none, to remove it. */
  replaceStatement(statement: MermaidFlowStatement, replacements: string[]): Splice {
    const lines = this.document.lines
    if (this.ownsItsLines(statement)) {
      if (replacements.length > 0) {
        const indent = this.indentOfLine(statement.line)
        return { start: statement.span.start, end: statement.span.end, text: replacements.join(this.eol + indent) }
      }
      const first = lines[statement.line]
      const last = lines[statement.endLine]
      if (last.eol !== '') {
        return { start: first.start, end: last.end + last.eol.length, text: '' }
      }
      // The last line of the text: take the line break before it instead.
      const previous = statement.line > 0 ? lines[statement.line - 1] : null
      return { start: previous ? previous.end : first.start, end: last.end, text: '' }
    }
    if (replacements.length > 0) {
      return { start: statement.span.start, end: statement.span.end, text: replacements.join('; ') }
    }
    // One of several statements on a line: it goes with its own `;`, or — the
    // last of them — with the spaces before it.
    const rest = /^[ \t]*;[ \t]*/.exec(this.source.slice(statement.span.end))
    if (rest) {
      return { start: statement.span.start, end: statement.span.end + rest[0].length, text: '' }
    }
    const lead = /[ \t]*$/.exec(this.source.slice(0, statement.span.start))?.[0].length ?? 0
    return { start: statement.span.start - lead, end: statement.span.end, text: '' }
  }

  /** Where a new statement goes at the end of a block: the line to follow, and its indentation. */
  endOfBlock(block: number | null): { line: number; indent: string } {
    const statements = this.document.statements
    if (block === null) {
      const top = statements.filter(
        (statement) => statement.parent === null && (statement.kind === 'vertex' || statement.kind === 'group'),
      )
      if (top.length > 0) {
        const last = top[top.length - 1]
        return { line: last.endLine, indent: this.indentOfLine(last.line) }
      }
      const header = this.document.header
      return { line: header ? this.lineOf(header.keywordSpan.start) : 0, indent: '  ' }
    }
    const group = statements[block] as MermaidFlowGroupStatement
    const closingLine = this.lineOf(group.closing.start)
    const openingLine = this.lineOf(group.opening.start)
    if (group.body.length === 0) {
      if (closingLine <= openingLine) {
        return refuse('This group is written on one line; edit it in the code.', openingLine)
      }
      const outer = this.indentOfLine(openingLine)
      return { line: openingLine, indent: outer + (outer.includes('\t') ? '\t' : '  ') }
    }
    const last = statements[group.body[group.body.length - 1]]
    if (last.endLine >= closingLine || last.line <= openingLine) {
      return refuse('This group is written on one line; edit it in the code.', openingLine)
    }
    return { line: last.endLine, indent: this.indentOfLine(last.line) }
  }

  /**
   * Where a statement that mentions these boxes goes in a block: after the
   * last statement directly in the block that mentions one of them (so that it
   * cannot become a box's first mention), or at the block's end.
   */
  afterMentionsIn(block: number | null, ids: ReadonlySet<string>): { line: number; indent: string } {
    const direct = this.document.statements.filter((statement) => statement.parent === block)
    const mentioning = direct.filter((statement) => this.mentions(statement, ids))
    if (mentioning.length === 0) {
      return this.endOfBlock(block)
    }
    const last = mentioning[mentioning.length - 1]
    if (block !== null) {
      const group = this.document.statements[block] as MermaidFlowGroupStatement
      if (last.endLine >= this.lineOf(group.closing.start)) {
        return refuse('This group is written on one line; edit it in the code.', group.line)
      }
    }
    return { line: last.endLine, indent: this.indentOfLine(last.line) }
  }

  // --- what else names a thing that is going --------------------------------

  /**
   * The lines that exist only to style or wire the things called `ids`, taken
   * out: a `style` line for one of them goes whole, and a `class` or `click`
   * line loses the name — and goes whole when it names nothing else.
   */
  forget(ids: ReadonlySet<string>, what: string): Splice[] {
    const splices: Splice[] = []
    for (const statement of this.document.statements) {
      if (statement.kind === 'style' && ids.has(statement.target)) {
        splices.push(this.replaceStatement(statement, []))
      } else if (statement.kind === 'class' || statement.kind === 'click') {
        const kept = statement.targets.filter((target) => !ids.has(target.id))
        if (kept.length === statement.targets.length) {
          continue
        }
        this.requireClean(statement.span, what)
        if (kept.length === 0) {
          splices.push(this.replaceStatement(statement, []))
        } else {
          splices.push({ ...statement.targetsSpan, text: kept.map((target) => target.id).join(',') })
        }
      }
    }
    return splices
  }

  /**
   * The same for links that are going and that the text names (`A e1@--> B`):
   * a class given to `e1`, and a statement that is nothing but `e1@{ … }`.
   * Left behind, that statement would stop configuring a link and start
   * making a box called `e1`.
   */
  forgetLinks(indices: Iterable<number>, reading: MermaidFlowReading): Splice[] {
    const ids = new Set<string>()
    for (const index of indices) {
      const id = reading.edges[index]?.id
      if (id !== undefined) {
        ids.add(id)
      }
    }
    if (ids.size === 0) {
      return []
    }
    const splices = this.forget(ids, 'A line that names this link')
    for (const statement of this.vertexStatements) {
      const only = statement.links.length === 0 && statement.groups[0].length === 1 ? statement.groups[0][0] : null
      if (only && ids.has(only.id) && only.shapeData !== null) {
        splices.push(this.replaceStatement(statement, []))
      }
    }
    return splices
  }

  // --- link numbers ---------------------------------------------------------

  /**
   * Every `linkStyle` statement rewritten for links that have moved: `renumber`
   * gives a link's new number, or null when the link is gone. A statement left
   * styling nothing is removed.
   */
  renumberLinkStyles(renumber: (old: number) => number | null): Splice[] {
    const splices: Splice[] = []
    for (const statement of this.document.statements) {
      if (statement.kind !== 'linkStyle' || statement.isDefault) {
        continue
      }
      const linkStyle = statement as MermaidFlowLinkStyleStatement
      const next = linkStyle.positions.map((position) => renumber(Number(position.value)))
      if (next.every((value, index) => value === Number(linkStyle.positions[index].value))) {
        continue
      }
      this.requireClean(linkStyle.span, 'A linkStyle line')
      const kept = next.filter((value): value is number => value !== null)
      if (kept.length === 0) {
        splices.push(this.replaceStatement(linkStyle, []))
      } else {
        splices.push({ start: linkStyle.positionsSpan.start, end: linkStyle.positionsSpan.end, text: kept.join(',') })
      }
    }
    return splices
  }

  // --- a statement as boxes and links --------------------------------------

  ir(statement: MermaidFlowVertexStatement): IrStatement {
    this.requireClean(statement.span, 'This statement')
    return {
      groups: statement.groups.map((group) =>
        group.map((mention) => ({ id: mention.id, text: this.cut(mention.full), mention })),
      ),
      links: statement.links.map((link) => this.cut(link.span).trim()),
    }
  }

  // --- trying a result ------------------------------------------------------

  /** The text these splices make, if the builder's own reading of it is what `expect` says. */
  attempt(splices: Splice[], expect: Expect): { text: string } | { faults: string[] } {
    const text = applyMermaidSourceSplices(this.source, splices)
    if (text === null) {
      return { faults: ['two changes overlap'] }
    }
    const result = parseMermaidFlowSource(text)
    if (!result.reading) {
      return { faults: [`the result does not parse: ${result.problem?.message ?? ''}`] }
    }
    const faults = judgeMermaidFlowReading(expect(copyReading(this.ownReading)), result.reading)
    return faults.length === 0 ? { text } : { faults }
  }
}

/** Statements as text: a box is written in full the first time it appears, by its id after that. */
function render(statements: IrStatement[]): string[] {
  const written = new Set<MermaidFlowMention>()
  const node = (entry: IrNode): string => {
    if (entry.mention && !written.has(entry.mention)) {
      written.add(entry.mention)
      return entry.text
    }
    return entry.id
  }
  return statements.map((statement) =>
    statement.groups
      .map((group) => group.map(node).join(' & '))
      .reduce((text, group, index) => (index === 0 ? group : `${text} ${statement.links[index - 1]} ${group}`), ''),
  )
}

/** Runs of statements that are only boxes, each merged into one `A & B` statement. */
function mergeBoxOnly(statements: IrStatement[]): IrStatement[] {
  const merged: IrStatement[] = []
  for (const statement of statements) {
    const previous = merged[merged.length - 1]
    if (statement.links.length === 0 && previous && previous.links.length === 0) {
      previous.groups[0].push(...statement.groups[0])
    } else {
      merged.push({ groups: statement.groups.map((group) => [...group]), links: [...statement.links] })
    }
  }
  return merged
}

type Rewrite = Map<MermaidFlowVertexStatement, IrStatement[]>

/**
 * A fault found by the builder's own check, in its own words: the judge's
 * sentences say "mermaid reads", and here it was the builder reading its own
 * result before mermaid was asked anything.
 */
const ownWords = (fault: string | undefined): string =>
  (fault ?? 'there is no way to write it').replace('mermaid reads', 'the result would read')

/**
 * Write statements again in the first of several ways that reads right, then
 * take out every box-only mention the result does not need. `others` are the
 * rest of the operation's splices; `ways` go from the most natural to the most
 * explicit.
 */
function settle(bench: Workbench, ways: Rewrite[], others: Splice[], expect: Expect, what: string): string {
  const splicesFor = (rewrite: Rewrite): Splice[] => [
    ...others,
    ...[...rewrite.entries()].map(([statement, replacements]) =>
      bench.replaceStatement(
        statement,
        render(replacements.filter((replacement) => replacement.groups.some((group) => group.length > 0))),
      ),
    ),
  ]
  let chosen: Rewrite | null = null
  let text = ''
  let faults: string[] = []
  for (const way of ways) {
    const result = bench.attempt(splicesFor(way), expect)
    if ('text' in result) {
      chosen = way
      text = result.text
      break
    }
    faults = result.faults
  }
  if (chosen === null) {
    return refuse(`The builder cannot ${what} without changing something else (${ownWords(faults[0])}).`)
  }
  // Prune: a box mentioned on its own, with nothing but its id, is only worth
  // keeping when the diagram reads differently without it.
  for (const [statement, replacements] of [...chosen.entries()]) {
    for (let index = 0; index < replacements.length; index++) {
      if (replacements[index].links.length > 0) {
        continue
      }
      const nodes = replacements[index].groups[0]
      for (let at = nodes.length - 1; at >= 0; at--) {
        const trial = new Map(chosen)
        const without: IrStatement = { groups: [nodes.filter((_node, node) => node !== at)], links: [] }
        trial.set(
          statement,
          replacements.map((replacement, position) => {
            if (position === index) {
              return without
            }
            return replacement
          }),
        )
        const result = bench.attempt(splicesFor(trial), expect)
        if ('text' in result) {
          nodes.splice(at, 1)
          text = result.text
        }
      }
    }
  }
  return text
}

// ---------------------------------------------------------------------------
// An operation, from a body that may refuse
// ---------------------------------------------------------------------------

type Draft = { text: string; expect: Expect }

/**
 * An edit from its body. The body either refuses or returns the new text and
 * the expectation; the text is checked once more against the builder's own
 * reading, so no operation can hand back a text its own parser disagrees with.
 */
const operation =
  (body: (bench: Workbench, reading: MermaidFlowReading) => Draft): MermaidFlowEdit =>
  (document, reading): MermaidFlowEditPlan => {
    try {
      const bench = new Workbench(document)
      const draft = body(bench, reading)
      const own = parseMermaidFlowSource(draft.text)
      if (!own.reading) {
        return {
          ok: false,
          reason: `The builder’s own result does not parse (${own.problem?.message ?? 'no reason given'}).`,
        }
      }
      const faults = judgeMermaidFlowReading(draft.expect(copyReading(bench.ownReading)), own.reading)
      if (faults.length > 0) {
        return {
          ok: false,
          reason: `The builder cannot do this without changing something else (${ownWords(faults[0])}).`,
        }
      }
      return { ok: true, text: draft.text, expectation: draft.expect(copyReading(reading)) }
    } catch (error) {
      if (error instanceof MermaidEditRefusal) {
        return { ok: false, reason: error.message, line: error.line }
      }
      throw error
    }
  }

const spliced = (bench: Workbench, splices: Splice[], expect: Expect): Draft => {
  const text = applyMermaidSourceSplices(bench.source, splices)
  if (text === null) {
    return refuse('The builder tried to change the same characters twice.')
  }
  return { text, expect }
}

/**
 * `spliced`, for an operation that adds or removes a group. A group written
 * without a name of its own (`subgraph "Phase one"`) is called `subGraph0`,
 * `subGraph1`, … by mermaid, counting every group in the order they close — so
 * one group more or fewer renames the ones counted after it. That is a change
 * to groups nobody asked to change, and it is refused in those words rather
 * than as a list of ids.
 */
const amongCountedGroups = (bench: Workbench, splices: Splice[], expect: Expect): Draft => {
  const result = bench.attempt(splices, expect)
  if ('text' in result) {
    return { text: result.text, expect }
  }
  const counted = bench.document.statements.find((statement) => statement.kind === 'group' && statement.idSpan === null)
  if (counted && /^(?:groups|order of the groups|boxes in group subGraph)/.test(result.faults[0] ?? '')) {
    return refuse(
      'A group here has no name of its own, so mermaid names it by counting the groups; adding or removing a group would rename it. Give that group a name in the code first.',
      counted.line,
    )
  }
  return refuse(`The builder cannot do this without changing something else (${ownWords(result.faults[0])}).`)
}

const requireNode = (reading: MermaidFlowReading, id: string): void => {
  if (!reading.nodes.some((node) => node.id === id)) {
    refuse(`There is no box called "${id}".`)
  }
}

/** A box whose text or shape may come from `@{ … }` cannot have either set by the builder. */
const refuseShapeData = (bench: Workbench, id: string, what: string): void => {
  const described = bench.mentionsOf(id).find((mention) => mention.shapeData !== null)
  if (described) {
    refuse(
      `"${id}" is described with @{ … }, which the builder does not edit; ${what} in the code.`,
      bench.lineOf(described.idSpan.start),
    )
  }
}

// ---------------------------------------------------------------------------
// Boxes
// ---------------------------------------------------------------------------

/** Give a box other text. */
export const relabelMermaidFlowNode = (id: string, label: string): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, id)
    refuseShapeData(bench, id, 'change its text')
    const mentions = bench.mentionsOf(id)
    // Mermaid keeps the LAST label it is given, so that is the one to replace.
    const labelled = [...mentions].reverse().find((mention) => mention.shape !== null)
    if (labelled?.shape) {
      if (labelled.shape.withProps) {
        return refuse(
          `"${id}" is written with a property; change its text in the code.`,
          bench.lineOf(labelled.idSpan.start),
        )
      }
      bench.requireClean(labelled.shape.label.inner, 'This label')
      const written = writeLabel(label, labelled.shape.label.type)
      return spliced(bench, [{ ...labelled.shape.label.inner, text: written.source }], (before) => {
        const node = before.nodes.find((candidate) => candidate.id === id)
        if (node) {
          node.text = written.text
          node.labelType = written.type
        }
        return expectation(before, { relabelled: [{ kind: 'node', id }] })
      })
    }
    // Never given a label: it is drawn with its id. Give it one where it is first written.
    const written = writeLabel(label, 'text')
    const expect: Expect = (before) => {
      const node = before.nodes.find((candidate) => candidate.id === id)
      if (node) {
        node.text = written.text
        node.labelType = written.type
        node.type = 'square'
      }
      return expectation(before, { relabelled: [{ kind: 'node', id }] })
    }
    if (mentions.length > 0) {
      const at = mentions[0].idSpan.end
      return spliced(bench, [{ start: at, end: at, text: `[${written.source}]` }], expect)
    }
    // A box that exists only because a `style` line names it.
    const place = bench.endOfBlock(null)
    return spliced(bench, [bench.linesAfter(place.line, place.indent, [`${id}[${written.source}]`])], expect)
  })

/** Draw a box as another shape. */
export const reshapeMermaidFlowNode = (id: string, shape: MermaidFlowBracketShape): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, id)
    refuseShapeData(bench, id, 'change its shape')
    const [open, close] = MERMAID_FLOW_BRACKET_SHAPES[shape]
    const mentions = bench.mentionsOf(id)
    const shaped = [...mentions].reverse().find((mention) => mention.shape !== null)
    if (shaped?.shape) {
      if (shaped.shape.withProps) {
        return refuse(
          `"${id}" is written with a property; change its shape in the code.`,
          bench.lineOf(shaped.idSpan.start),
        )
      }
      bench.requireClean({ start: shaped.shape.open.start, end: shaped.shape.close.end }, 'This box')
      const splices: Splice[] = [
        { ...shaped.shape.open, text: open },
        { ...shaped.shape.close, text: close },
      ]
      // Unquoted text that is safe between square brackets is not always safe
      // between slashes or `(-` `-)`: quote it unless it is plainly safe anywhere.
      const label = shaped.shape.label
      let labelType: string | null = null
      if (label.type === 'text' && !PLAIN_LABEL.test(bench.cut(label.inner).trim())) {
        const written = writeLabel(bench.cut(label.inner), 'string')
        splices.push({ ...label.inner, text: written.source })
        labelType = written.type
      }
      return spliced(bench, splices, (before) => {
        const node = before.nodes.find((candidate) => candidate.id === id)
        if (node) {
          node.type = shape
          node.labelType = labelType ?? node.labelType
        }
        return expectation(before, labelType === null ? {} : { relabelled: [{ kind: 'node', id }] })
      })
    }
    const written = writeLabel(id, 'text')
    const expect: Expect = (before) => {
      const node = before.nodes.find((candidate) => candidate.id === id)
      if (node) {
        node.type = shape
        node.labelType = written.type
      }
      return expectation(before, { relabelled: [{ kind: 'node', id }] })
    }
    if (mentions.length > 0) {
      const at = mentions[0].idSpan.end
      return spliced(bench, [{ start: at, end: at, text: `${open}${written.source}${close}` }], expect)
    }
    const place = bench.endOfBlock(null)
    return spliced(
      bench,
      [bench.linesAfter(place.line, place.indent, [`${id}${open}${written.source}${close}`])],
      expect,
    )
  })

/** Call a box something else, everywhere it is named. */
export const renameMermaidFlowNode = (id: string, nextId: string): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, id)
    const wanted = nextId.trim()
    if (wanted === id) {
      return { text: bench.source, expect: (before) => expectation(before) }
    }
    const problem = mermaidFlowIdProblem(wanted, reading)
    if (problem) {
      return refuse(problem)
    }
    if (reading.groups.some((group) => group.id === id)) {
      return refuse(`"${id}" is also a group; rename it in the code.`)
    }
    const mentions = bench.mentionsOf(id)
    const labelled = mentions.some((mention) => mention.shape !== null)
    const described = mentions.find((mention) => mention.shapeData !== null)
    if (described && !labelled) {
      // Its text may be its id or may be set inside `@{ … }`: only YAML can say.
      return refuse(
        `"${id}" is described with @{ … }, which the builder does not read; rename it in the code.`,
        bench.lineOf(described.idSpan.start),
      )
    }
    const splices: Splice[] = []
    const replace = (span: MermaidSourceSpan, afterLink: boolean) => {
      bench.requireClean(span, `"${id}"`)
      // `---oB` is a link with a circle on it and a box called B. An id that
      // starts with o or x cannot follow a link without a space between.
      const glued = afterLink && /[-=.]$/.test(bench.source.slice(0, span.start)) && /^[ox]/.test(wanted)
      splices.push({ ...span, text: (glued ? ' ' : '') + wanted })
    }
    for (const mention of mentions) {
      replace(mention.idSpan, true)
    }
    for (const statement of bench.document.statements) {
      if (statement.kind === 'style' && statement.target === id) {
        replace(statement.targetSpan, false)
      }
      if (statement.kind === 'class' || statement.kind === 'click') {
        for (const target of statement.targets) {
          if (target.id === id) {
            replace(target.span, false)
          }
        }
      }
    }
    return spliced(bench, splices, (before) => {
      const rename = (value: string) => (value === id ? wanted : value)
      for (const node of before.nodes) {
        if (node.id === id) {
          node.id = wanted
          if (!labelled) {
            node.text = wanted
          }
        }
      }
      for (const edge of before.edges) {
        edge.start = rename(edge.start)
        edge.end = rename(edge.end)
      }
      for (const group of before.groups) {
        group.nodes = group.nodes.map(rename)
      }
      mapTooltips(before, rename)
      return expectation(before)
    })
  })

export type MermaidFlowNewNode = {
  label: string
  shape?: MermaidFlowBracketShape
  /** The name to give it; the next free one when left out. */
  id?: string
  /** The group to put it in, by id; null or left out for none. Not with `linkFrom` or `linkTo`. */
  group?: string | null
  /** An existing box to link it from, which also decides its group. */
  linkFrom?: string
  /** An existing box to link it to, which also decides its group. */
  linkTo?: string
  /** How that link is drawn and what it says. */
  look?: MermaidFlowLinkLook
  linkLabel?: string
}

/** Add a box — on its own, in a group, or already linked to another box. */
export const addMermaidFlowNode = (options: MermaidFlowNewNode): MermaidFlowEdit =>
  operation((bench, reading) => {
    const id = options.id?.trim() ?? nextMermaidFlowId(reading)
    const problem = mermaidFlowIdProblem(id, reading)
    if (problem) {
      return refuse(problem)
    }
    const shape = options.shape ?? 'square'
    const [open, close] = MERMAID_FLOW_BRACKET_SHAPES[shape]
    const written = writeLabel(options.label, 'text')
    const box = `${id}${open}${written.source}${close}`
    const node = {
      id,
      text: written.text,
      type: shape as string,
      labelType: written.type as string,
      classes: [] as string[],
      styles: [] as string[],
    }
    const anchor = options.linkFrom ?? options.linkTo
    if (options.linkFrom !== undefined && options.linkTo !== undefined) {
      return refuse('A new box can be linked from one box or to one, not both at once.')
    }

    if (anchor === undefined) {
      const block = options.group ? bench.groupStatement(options.group).index : null
      const place = bench.endOfBlock(block)
      return spliced(bench, [bench.linesAfter(place.line, place.indent, [box])], (before) => {
        before.nodes.push({ ...node })
        if (options.group) {
          before.groups.find((group) => group.id === options.group)?.nodes.push(id)
        }
        return expectation(before, {
          created: [{ kind: 'node', id }],
          relabelled: [{ kind: 'node', id }],
          reordered: [id],
        })
      })
    }

    requireNode(reading, anchor)
    if (options.group !== undefined) {
      return refuse('A box added with a link goes in the group of the box it is linked to.')
    }
    // In the anchor's own block, straight after the last statement there that
    // mentions the anchor: the new box joins its group, and nothing else moves.
    const block = bench.blockOfNode(anchor, reading)
    const groupId = block === null ? null : (bench.document.statements[block] as MermaidFlowGroupStatement).id
    const place = bench.afterMentionsIn(block, new Set([anchor]))
    const look = options.look ?? DEFAULT_MERMAID_FLOW_LINK_LOOK
    const linkLabel = options.linkLabel?.trim() ? writeLabel(options.linkLabel, 'text') : null
    const arrow = mermaidFlowArrow(look) + (linkLabel ? `|${linkLabel.source}|` : '')
    const line = options.linkFrom !== undefined ? `${anchor} ${arrow} ${box}` : `${box} ${arrow} ${anchor}`
    const insertion = bench.linesAfter(place.line, place.indent, [line])
    const index = bench.edgesBefore(insertion.start)
    const edge =
      options.linkFrom !== undefined ? newEdge(anchor, id, look, linkLabel) : newEdge(id, anchor, look, linkLabel)
    const splices = [insertion, ...bench.renumberLinkStyles((old) => (old >= index ? old + 1 : old))]
    return spliced(bench, splices, (before) => {
      before.nodes.push({ ...node })
      before.edges.splice(index, 0, { ...edge, classes: [] })
      if (groupId !== null) {
        before.groups.find((group) => group.id === groupId)?.nodes.push(id)
      }
      return expectation(before, {
        created: [
          { kind: 'node', id },
          { kind: 'edge', index },
        ],
        relabelled: [
          { kind: 'node', id },
          { kind: 'edge', index },
        ],
        reordered: [id],
      })
    })
  })

// ---------------------------------------------------------------------------
// Rewriting statements that lose a box or a link
// ---------------------------------------------------------------------------

/** One statement with one of its pairs taken out and, optionally, something put in its place. */
function withoutPair(
  bench: Workbench,
  statement: MermaidFlowVertexStatement,
  link: number,
  start: number,
  end: number,
  instead: IrStatement | null,
): IrStatement[][] {
  const ir = bench.ir(statement)
  const starts = ir.groups[link]
  const ends = ir.groups[link + 1]
  const arrow = ir.links[link]
  const boxes = (group: IrNode[]): IrStatement => ({ groups: [[...group]], links: [] })
  // Mermaid makes a fan's links start by start, and for each start end by end.
  // `keepEnd` leaves the far box of the pair that went where the pair was, so
  // that it is still mentioned before the boxes that came after it.
  const rowsWith = (keepEnd: boolean): IrStatement[] => {
    const made: IrStatement[] = []
    const row = (from: IrNode[], to: IrNode[]) => {
      if (from.length > 0 && to.length > 0) {
        made.push({ groups: [from, to], links: [arrow] })
      }
    }
    row(starts.slice(0, start), ends)
    row([starts[start]], ends.slice(0, end))
    if (keepEnd) {
      made.push(boxes([ends[end]]))
    }
    if (instead) {
      made.push(instead)
    }
    row([starts[start]], ends.slice(end + 1))
    row(starts.slice(start + 1), ends)
    return made
  }
  const rows = rowsWith(false)

  const head: IrStatement | null =
    link > 0 ? { groups: ir.groups.slice(0, link + 1), links: ir.links.slice(0, link) } : null
  const tail: IrStatement | null =
    link + 1 < ir.links.length ? { groups: ir.groups.slice(link + 1), links: ir.links.slice(link + 1) } : null
  const all: IrStatement = { groups: [ir.groups.flat()], links: [] }
  const chains = (first: IrStatement | null, middle: IrStatement[], last: IrStatement | null): IrStatement[] =>
    mergeBoxOnly([...(first ? [first] : []), ...middle, ...(last ? [last] : [])])
  return [
    // Only the links that remain.
    chains(head, rows, tail),
    // …with the boxes of the link that went left where they stood, in case
    // nothing else mentions them; the ones that turn out not to be needed are
    // pruned afterwards.
    chains(head ?? boxes(starts), rowsWith(true), tail),
    // …or kept at either end.
    chains(head ?? boxes(starts), rows, tail ?? boxes(ends)),
    // …or every box of the statement declared first, in the order it had.
    chains(all, [...(head ? [head] : []), ...rows], tail),
  ]
}

/** One statement with every mention of a box taken out, as the chains that remain. */
function withoutNode(bench: Workbench, statement: MermaidFlowVertexStatement, id: string): IrStatement[][] {
  const ir = bench.ir(statement)
  const groups = ir.groups.map((group) => group.filter((node) => node.id !== id))
  const segments: IrStatement[] = []
  let current: IrStatement | null = null
  groups.forEach((group, index) => {
    if (group.length === 0) {
      current = null
      return
    }
    if (current === null) {
      current = { groups: [group], links: [] }
      segments.push(current)
    } else {
      current.groups.push(group)
      current.links.push(ir.links[index - 1])
    }
  })
  const linked = segments.filter((segment) => segment.links.length > 0)
  const all: IrStatement = { groups: [groups.flat()], links: [] }
  return [mergeBoxOnly(linked), mergeBoxOnly(segments), mergeBoxOnly([all, ...linked])]
}

/** Each way of rewriting each statement, turned into ways of rewriting all of them together. */
function together(perStatement: Map<MermaidFlowVertexStatement, IrStatement[][]>): Rewrite[] {
  const levels = Math.max(0, ...[...perStatement.values()].map((ways) => ways.length))
  const result: Rewrite[] = []
  for (let level = 0; level < levels; level++) {
    const rewrite: Rewrite = new Map()
    for (const [statement, ways] of perStatement) {
      rewrite.set(statement, ways[Math.min(level, ways.length - 1)])
    }
    result.push(rewrite)
  }
  return result
}

const siteOf = (bench: Workbench, reading: MermaidFlowReading, index: number) => {
  if (!Number.isInteger(index) || index < 0 || index >= reading.edges.length) {
    return refuse(`There is no link number ${index}.`)
  }
  const site = bench.document.edges[index]
  const statement = bench.document.statements[site.statement] as MermaidFlowVertexStatement
  return { site, statement, link: statement.links[site.link] }
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type MermaidFlowNewLink = { look?: MermaidFlowLinkLook; label?: string }

/** Link two boxes that exist. */
export const addMermaidFlowLink = (from: string, to: string, options: MermaidFlowNewLink = {}): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, from)
    requireNode(reading, to)
    const look = options.look ?? DEFAULT_MERMAID_FLOW_LINK_LOOK
    const label = options.label?.trim() ? writeLabel(options.label, 'text') : null
    const arrow = mermaidFlowArrow(look) + (label ? `|${label.source}|` : '')
    // In the block both boxes are inside, so that neither is pulled into a
    // group it is not in; after the last statement there that mentions either.
    const block = bench.commonBlock(bench.blockOfNode(from, reading), bench.blockOfNode(to, reading))
    const place = bench.afterMentionsIn(block, new Set([from, to]))
    const insertion = bench.linesAfter(place.line, place.indent, [`${from} ${arrow} ${to}`])
    const index = bench.edgesBefore(insertion.start)
    const edge = newEdge(from, to, look, label)
    // A box whose first mention comes later in the text is now mentioned here first.
    const reordered = [from, to].filter((id) => bench.createdAt(id) >= insertion.start)
    const splices = [insertion, ...bench.renumberLinkStyles((old) => (old >= index ? old + 1 : old))]
    return spliced(bench, splices, (before) => {
      before.edges.splice(index, 0, { ...edge, classes: [] })
      return expectation(before, {
        created: [{ kind: 'edge', index }],
        relabelled: [{ kind: 'edge', index }],
        reordered,
      })
    })
  })

/** Take a link out. The boxes it joined stay. */
export const removeMermaidFlowLink = (index: number): MermaidFlowEdit =>
  operation((bench, reading) => {
    const { site, statement } = siteOf(bench, reading, index)
    const expect: Expect = (before) => {
      before.edges.splice(index, 1)
      return expectation(before)
    }
    const others = [
      ...bench.renumberLinkStyles((old) => (old === index ? null : old > index ? old - 1 : old)),
      ...bench.forgetLinks([index], reading),
    ]
    const ways = withoutPair(bench, statement, site.link, site.start, site.end, null).map(
      (way): Rewrite => new Map([[statement, way]]),
    )
    return { text: settle(bench, ways, others, expect, 'remove this link'), expect }
  })

/** Point a link at another box, at either end. */
export const retargetMermaidFlowLink = (index: number, ends: { from?: string; to?: string }): MermaidFlowEdit =>
  operation((bench, reading) => {
    const { site, statement } = siteOf(bench, reading, index)
    const edge = reading.edges[index]
    const from = ends.from ?? edge.start
    const to = ends.to ?? edge.end
    requireNode(reading, from)
    requireNode(reading, to)
    if (from === edge.start && to === edge.end) {
      return { text: bench.source, expect: (before) => expectation(before) }
    }
    // The line stays where it is, so a box it now names must not be pulled
    // into the group the line is written in.
    for (const id of [from, to]) {
      const home = bench.blockOfNode(id, reading)
      if (statement.parent !== null && !bench.ancestors(home).includes(statement.parent)) {
        return refuse(
          `This link is written inside a group "${id}" is not in; remove it and add a new one.`,
          statement.line,
        )
      }
    }
    const ir = bench.ir(statement)
    const instead: IrStatement = {
      groups: [
        [from === edge.start ? ir.groups[site.link][site.start] : bareNode(from)],
        [to === edge.end ? ir.groups[site.link + 1][site.end] : bareNode(to)],
      ],
      links: [ir.links[site.link]],
    }
    const moved = [from, to].filter((id) => id !== edge.start && id !== edge.end)
    const expect: Expect = (before) => {
      before.edges[index].start = from
      before.edges[index].end = to
      return expectation(before, { reordered: moved })
    }
    const ways = withoutPair(bench, statement, site.link, site.start, site.end, instead).map(
      (way): Rewrite => new Map([[statement, way]]),
    )
    return { text: settle(bench, ways, [], expect, 'move this link'), expect }
  })

export type MermaidFlowLinkChange = {
  stroke?: MermaidFlowLinkStroke
  ends?: MermaidFlowLinkEnds
  length?: number
  /** The link's text; an empty string takes it away. Left out, the text stays as it is. */
  label?: string
}

/** Change how a link is drawn, or what it says. */
export const restyleMermaidFlowLink = (index: number, change: MermaidFlowLinkChange): MermaidFlowEdit =>
  operation((bench, reading) => {
    const { site, statement, link } = siteOf(bench, reading, index)
    const edge = reading.edges[index]
    const current = mermaidFlowLinkLookOf(edge)
    if (!current) {
      return refuse('This link is drawn in a way the builder does not know; edit it in the code.', statement.line)
    }
    const look: MermaidFlowLinkLook = {
      stroke: change.stroke ?? current.stroke,
      ends: change.ends ?? current.ends,
      length: change.length ?? current.length,
    }
    if (look.stroke === 'invisible') {
      look.ends = 'none'
    }
    const sameLook = look.stroke === current.stroke && look.ends === current.ends && look.length === current.length
    bench.requireClean(link.span, 'This link')

    const relabel = change.label !== undefined
    const wantsText = relabel ? (change.label as string).trim() !== '' : link.label !== null
    const expectWith =
      (label: WrittenLabel | null): Expect =>
      (before) => {
        const target = before.edges[index]
        target.type = look.stroke === 'invisible' ? 'arrow_open' : ENDS_TO_TYPE[look.ends]
        target.stroke = look.stroke
        target.length = Math.max(1, Math.min(MAX_LINK_LENGTH, Math.round(look.length)))
        if (relabel) {
          target.text = label ? label.text : ''
          target.labelType = label ? label.type : 'text'
        }
        return expectation(before, relabel ? { relabelled: [{ kind: 'edge', index }] } : {})
      }

    // Only the text changes, and the link has text written where it can be replaced.
    if (sameLook && relabel && wantsText && link.label && link.edges.length === 1) {
      const plain = link.form === 'inline' ? PLAIN_INLINE_LABEL : PLAIN_LABEL
      const written = writeLabel(change.label as string, link.label.type, plain)
      // Text written inside the arrow itself has to stay plain, or stay in the
      // quotes it already has; anything else is moved between pipes, below.
      if (link.form === 'pipe' || written.type === 'text' || link.label.type !== 'text') {
        return spliced(bench, [{ ...link.label.inner, text: written.source }], expectWith(written))
      }
    }

    // Otherwise the link is written again, keeping its id and — unless it was asked to change — its text.
    const kept = link.label ? bench.cut(link.label.inner).trim() : ''
    let label: WrittenLabel | null = null
    let labelSource = ''
    if (relabel) {
      label = wantsText ? writeLabel(change.label as string, 'text') : null
      labelSource = label ? `|${label.source}|` : ''
    } else if (link.label) {
      // The text as it was written, moved between pipes: quotes and all.
      labelSource = `|${link.label.type === 'text' ? writeLabel(kept, 'text').source : kept}|`
    }
    const arrow = `${link.id ? link.id + '@' : ''}${mermaidFlowArrow(look)}${labelSource}`
    const expect = expectWith(label)
    if (link.edges.length === 1) {
      // One space either side, unless one is already there: a link written
      // with an id (`A e1@--> B`) has its leading space outside it.
      const lead = /[ \t]$/.test(bench.source.slice(0, link.span.start)) ? '' : ' '
      const trail = /^[ \t]/.test(bench.source.slice(link.span.end)) ? '' : ' '
      return spliced(bench, [{ ...link.span, text: `${lead}${arrow}${trail}` }], expect)
    }
    // The link stands for several edges: this one is written on a line of its own.
    const ir = bench.ir(statement)
    const instead: IrStatement = {
      groups: [[ir.groups[site.link][site.start]], [ir.groups[site.link + 1][site.end]]],
      links: [arrow],
    }
    const ways = withoutPair(bench, statement, site.link, site.start, site.end, instead).map(
      (way): Rewrite => new Map([[statement, way]]),
    )
    return { text: settle(bench, ways, [], expect, 'change this link'), expect }
  })

// ---------------------------------------------------------------------------
// Deleting a box
// ---------------------------------------------------------------------------

/** Take a box out, with every link to or from it and every line that styles it. */
export const deleteMermaidFlowNode = (id: string): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, id)
    if (reading.groups.some((group) => group.id === id)) {
      return refuse(`"${id}" is also a group; remove it in the code.`)
    }
    const gone = new Set<number>()
    reading.edges.forEach((edge, index) => {
      if (edge.start === id || edge.end === id) {
        gone.add(index)
      }
    })
    const others: Splice[] = bench.renumberLinkStyles((old) => {
      if (gone.has(old)) {
        return null
      }
      let shift = 0
      for (const index of gone) {
        shift += index < old ? 1 : 0
      }
      return old - shift
    })
    others.push(...bench.forget(new Set([id]), 'A line that names this box'), ...bench.forgetLinks(gone, reading))
    const perStatement = new Map<MermaidFlowVertexStatement, IrStatement[][]>()
    for (const statement of bench.vertexStatements) {
      if (bench.mentions(statement, new Set([id]))) {
        perStatement.set(statement, withoutNode(bench, statement, id))
      }
    }
    const expect: Expect = (before) => {
      before.nodes = before.nodes.filter((node) => node.id !== id)
      before.edges = before.edges.filter((_edge, index) => !gone.has(index))
      for (const group of before.groups) {
        group.nodes = group.nodes.filter((member) => member !== id)
      }
      mapTooltips(before, (key) => (key === id ? null : key))
      return expectation(before)
    }
    return { text: settle(bench, together(perStatement), others, expect, 'remove this box'), expect }
  })

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export type MermaidFlowNewGroup = {
  title: string
  /** The boxes to put in it. They must all be in the same group now, or in none. */
  members: string[]
  id?: string
}

/** Put boxes in a new group. Nothing moves: the group is written where they can be named. */
export const addMermaidFlowGroup = (options: MermaidFlowNewGroup): MermaidFlowEdit =>
  operation((bench, reading) => {
    const id = options.id?.trim() ?? nextMermaidFlowId(reading, 'group')
    const problem = mermaidFlowIdProblem(id, reading)
    if (problem) {
      return refuse(problem)
    }
    const members = [...new Set(options.members)]
    for (const member of members) {
      requireNode(reading, member)
    }
    const blocks = [...new Set(members.map((member) => bench.blockOfNode(member, reading)))]
    if (blocks.length > 1) {
      return refuse('These boxes are in different groups; a new group can only hold boxes that are together now.')
    }
    const block = blocks.length === 1 ? blocks[0] : null
    const parentId = block === null ? null : (bench.document.statements[block] as MermaidFlowGroupStatement).id
    const place = bench.endOfBlock(block)
    const title = writeLabel(options.title, 'text')
    const inner = place.indent + (place.indent.includes('\t') ? '\t' : '  ')
    const insertion = bench.linesAfter(place.line, '', [
      `${place.indent}subgraph ${id}[${title.source}]`,
      ...members.map((member) => inner + member),
      `${place.indent}end`,
    ])
    return amongCountedGroups(bench, [insertion], (before) => {
      const parent = before.groups.find((group) => group.id === parentId)
      if (parent) {
        parent.nodes = parent.nodes.filter((member) => !members.includes(member))
        parent.nodes.push(id)
      }
      before.groups.push({
        id,
        title: title.text,
        nodes: [...members],
        dir: undefined,
        labelType: title.type,
        classes: [],
      })
      return expectation(before, {
        created: [{ kind: 'group', id }],
        relabelled: [{ kind: 'group', id }],
      })
    })
  })

/** Take a group away and leave what is in it where it is. */
export const removeMermaidFlowGroup = (id: string): MermaidFlowEdit =>
  operation((bench, reading) => {
    const group = bench.groupStatement(id)
    if (!reading.groups.some((candidate) => candidate.id === id)) {
      return refuse(`There is no group called "${id}".`)
    }
    const linked = bench.vertexStatements.find((statement) => bench.mentions(statement, new Set([id])))
    if (linked) {
      return refuse(`A link goes to or from the group "${id}"; remove that link first.`, linked.line)
    }
    const openingLine = bench.lineOf(group.opening.start)
    const closingLine = bench.lineOf(group.closing.start)
    const lines = bench.document.lines
    const alone = (line: number, span: MermaidSourceSpan) =>
      /^[ \t]*$/.test(bench.source.slice(lines[line].start, span.start)) &&
      /^[ \t]*;?[ \t]*$/.test(bench.source.slice(span.end, lines[line].end))
    if (closingLine <= openingLine || !alone(openingLine, group.opening) || !alone(closingLine, group.closing)) {
      return refuse('This group is written on one line with other things; remove it in the code.', openingLine)
    }
    // What belonged to the group alone goes with it: its direction, its style.
    const splices: Splice[] = [
      bench.withoutLine(openingLine),
      bench.withoutLine(closingLine),
      ...bench.forget(new Set([id]), 'A line that names this group'),
    ]
    for (const statement of bench.document.statements) {
      if (statement.kind === 'direction' && statement.parent === group.index) {
        splices.push(bench.replaceStatement(statement, []))
      }
    }
    return amongCountedGroups(bench, splices, (before) => {
      const removed = before.groups.find((candidate) => candidate.id === id)
      before.groups = before.groups.filter((candidate) => candidate.id !== id)
      // A `style` line for a group makes mermaid keep a box of the same name
      // to carry the style. It went with the line.
      before.nodes = before.nodes.filter((node) => node.id !== id)
      const parent = before.groups.find((candidate) => candidate.nodes.includes(id))
      if (parent && removed) {
        parent.nodes = [...parent.nodes.filter((member) => member !== id), ...removed.nodes]
      }
      mapTooltips(before, (key) => (key === id ? null : key))
      return expectation(before)
    })
  })

/** Give a group another title. */
export const retitleMermaidFlowGroup = (id: string, title: string): MermaidFlowEdit =>
  operation((bench, reading) => {
    const group = bench.groupStatement(id)
    if (!reading.groups.some((candidate) => candidate.id === id)) {
      return refuse(`There is no group called "${id}".`)
    }
    const expectWith =
      (written: WrittenLabel): Expect =>
      (before) => {
        const target = before.groups.find((candidate) => candidate.id === id)
        if (target) {
          target.title = written.text
          target.labelType = written.type
        }
        return expectation(before, { relabelled: [{ kind: 'group', id }] })
      }
    if (group.title) {
      bench.requireClean(group.title.inner, 'This title')
      const written = writeLabel(title, group.title.type)
      return spliced(bench, [{ ...group.title.inner, text: written.source }], expectWith(written))
    }
    if (!group.name) {
      return refuse('This group has no name to change; edit it in the code.', group.line)
    }
    bench.requireClean(group.name.inner, 'This group’s name')
    // The name is the id, or a title mermaid made an id for. Either way the id
    // is written out and the title goes in brackets after it, so that changing
    // the title cannot change which group this is.
    const written = writeLabel(title, 'text')
    return spliced(bench, [{ ...group.name.inner, text: `${id}[${written.source}]` }], expectWith(written))
  })

/**
 * Move a box into a group, into another group, or out of every group.
 *
 * Into a group from none is one new line: the box is named inside the group.
 * Out of a group, the box has to stop being named there, so each statement
 * that names it in that group is written again without it; the box is then
 * declared where it is going, and its links are written again after the
 * outermost group, where they pull nothing into a group.
 */
export const moveMermaidFlowNode = (id: string, toGroup: string | null): MermaidFlowEdit =>
  operation((bench, reading) => {
    requireNode(reading, id)
    if (reading.groups.some((group) => group.id === id)) {
      return refuse(`"${id}" is also a group; move it in the code.`)
    }
    const from = bench.blockOfNode(id, reading)
    const to = toGroup === null ? null : bench.groupStatement(toGroup).index
    if (toGroup !== null && !reading.groups.some((group) => group.id === toGroup)) {
      return refuse(`There is no group called "${toGroup}".`)
    }
    if (from === to) {
      return { text: bench.source, expect: (before) => expectation(before) }
    }
    const fromId = from === null ? null : (bench.document.statements[from] as MermaidFlowGroupStatement).id
    const membership = (before: MermaidFlowReading) => {
      for (const group of before.groups) {
        if (group.id === fromId) {
          group.nodes = group.nodes.filter((member) => member !== id)
        }
        if (group.id === toGroup) {
          group.nodes.push(id)
        }
      }
    }

    if (from === null) {
      const place = bench.endOfBlock(to)
      return spliced(bench, [bench.linesAfter(place.line, place.indent, [id])], (before) => {
        membership(before)
        return expectation(before, { reordered: [id] })
      })
    }

    // Statements inside groups that name the box. All of them have to let go of it.
    const inside = bench.vertexStatements.filter(
      (statement) => statement.parent !== null && bench.mentions(statement, new Set([id])),
    )
    const stray = inside.find((statement) => statement.parent !== from)
    if (stray) {
      return refuse(`"${id}" is also written inside another group; move it in the code.`, stray.line)
    }
    refuseShapeData(bench, id, 'move it')

    // Its links written there go, and are written again further down.
    const moved: number[] = []
    for (const statement of inside) {
      statement.links.forEach((link, linkIndex) => {
        link.edges.forEach((edge) => {
          const site = bench.document.edges[edge]
          const start = statement.groups[linkIndex][site.start].id
          const end = statement.groups[linkIndex + 1][site.end].id
          if (start === id || end === id) {
            moved.push(edge)
          }
        })
      })
    }
    moved.sort((a, b) => a - b)

    // How it is declared where it is going: by the text of its last labelled mention, classes included.
    const mentions = inside.flatMap((statement) => statement.groups.flat().filter((mention) => mention.id === id))
    const decorated = mentions.filter((mention) => bench.cut(mention.full) !== id)
    if (new Set(decorated.map((mention) => bench.cut(mention.full))).size > 1) {
      return refuse(`"${id}" is written more than one way inside its group; move it in the code.`, inside[0].line)
    }
    const declaration = decorated.length > 0 ? bench.cut(decorated[0].full) : id

    const outermost = bench.ancestors(to ?? from)[0]
    const outer = bench.document.statements[outermost] as MermaidFlowGroupStatement
    const outerClosing = bench.lineOf(outer.closing.start)
    const linkLines = moved.map((edge) => {
      const site = bench.document.edges[edge]
      const statement = bench.document.statements[site.statement] as MermaidFlowVertexStatement
      const start = statement.groups[site.link][site.start].id
      const end = statement.groups[site.link + 1][site.end].id
      return `${start} ${bench.cut(statement.links[site.link].span).trim()} ${end}`
    })
    // The links keep their order among themselves and land after everything
    // written up to the end of the outermost group.
    const landing = bench.document.lines[outerClosing].end
    const stay = reading.edges.map((_edge, index) => index).filter((index) => !moved.includes(index))
    const before = stay.filter(
      (index) => bench.document.statements[bench.document.edges[index].statement].span.start < landing,
    )
    const order = [...before, ...moved, ...stay.slice(before.length)]
    const renumbered = bench.renumberLinkStyles((old) => order.indexOf(old))
    const othersWith = (declared: boolean): Splice[] => {
      const outside = bench.indentOfLine(outer.line)
      if (to === null) {
        const lines = declared ? [declaration, ...linkLines] : linkLines
        return [...(lines.length > 0 ? [bench.linesAfter(outerClosing, outside, lines)] : []), ...renumbered]
      }
      const place = bench.endOfBlock(to)
      return [
        bench.linesAfter(place.line, place.indent, [declaration]),
        ...(linkLines.length > 0 ? [bench.linesAfter(outerClosing, outside, linkLines)] : []),
        ...renumbered,
      ]
    }

    const neighbours = new Set<string>([id])
    for (const edge of moved) {
      neighbours.add(reading.edges[edge].start)
      neighbours.add(reading.edges[edge].end)
    }
    const expect: Expect = (reading_) => {
      membership(reading_)
      reading_.edges = order.map((index) => reading_.edges[index])
      return expectation(reading_, { reordered: [...neighbours] })
    }
    const perStatement = new Map<MermaidFlowVertexStatement, IrStatement[][]>()
    for (const statement of inside) {
      perStatement.set(statement, withoutNode(bench, statement, id))
    }
    // Out of every group, a box that is written somewhere outside one already
    // needs no line of its own after the group: try without, and add it only
    // if the diagram reads differently for the lack of it.
    if (to === null && declaration === id) {
      try {
        return { text: settle(bench, together(perStatement), othersWith(false), expect, 'move this box'), expect }
      } catch (error) {
        if (!(error instanceof MermaidEditRefusal)) {
          throw error
        }
      }
    }
    return { text: settle(bench, together(perStatement), othersWith(true), expect, 'move this box'), expect }
  })

// ---------------------------------------------------------------------------
// The diagram as a whole
// ---------------------------------------------------------------------------

/** Turn the whole diagram to flow another way. */
export const setMermaidFlowDirection = (direction: MermaidFlowDirection): MermaidFlowEdit =>
  operation((bench) => {
    const header = bench.document.header
    if (!header) {
      return refuse('This diagram has no header line.')
    }
    const expect: Expect = (before) => {
      before.direction = direction === 'TD' ? 'TB' : direction
      return expectation(before)
    }
    if (header.direction) {
      bench.requireClean(header.direction.span, 'The direction')
      return spliced(bench, [{ ...header.direction.span, text: direction }], expect)
    }
    return spliced(
      bench,
      [{ start: header.keywordSpan.end, end: header.keywordSpan.end, text: ` ${direction}` }],
      expect,
    )
  })

/** The element an edit plan is about, for a caller that wants to select what it just made. */
export type { MermaidFlowElementRef }
