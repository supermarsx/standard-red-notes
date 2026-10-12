/**
 * Standard Red Notes — a LOSSLESS, POSITIONAL reading of a mermaid flowchart's
 * text.
 *
 * WHY THIS EXISTS
 *
 * The visual builder edits a diagram by changing its text. The builder it
 * replaces parsed the text into a small model and wrote the WHOLE text back
 * from that model, so everything the model did not carry was either refused
 * (half of ordinary flowcharts) or silently changed (a slanted box became a
 * plain one). This module is the other way round: the text is never
 * regenerated. It is split into pieces that cover it without a gap, each piece
 * knows where it sits, and an edit replaces a few characters and leaves every
 * other character exactly where it was. Printing a document gives back the text
 * it was read from, for ANY text — a diagram mermaid rejects, half a diagram, a
 * diagram of another kind.
 *
 * WHOSE GRAMMAR
 *
 * Mermaid's, literally. `MermaidFlowGrammar.ts` is generated from the installed
 * package: the flowchart lexer's rules, conditions and actions, and its LALR
 * table. This module runs them. So a token ends where mermaid's token ends, and
 * a statement is the statement mermaid's parser reduces — including the parts
 * nobody would guess: a link's whitespace may contain a newline, so a line that
 * starts with `-->` continues the statement above it; `x--> C` at the start of
 * a line is a cross-ended link, not a box called `x`; a line that merely
 * CONTAINS the words `direction TB` is a direction statement.
 *
 * What is ours is the meaning given to each production: the handlers below do
 * what mermaid's own parser actions do (the calls into its FlowDB), against a
 * small imitation of that database, and additionally remember WHERE each thing
 * was written. The imitation is where this module can be wrong, and it is
 * checked two ways: `MermaidFlowEngineContract.mjs` compares it with the real
 * library over a corpus and over every one-character deletion of it, and at run
 * time `compareMermaidFlowReadings` compares it with mermaid's own reading of
 * the very diagram being edited — a difference refuses the edit.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not sanitise labels (mermaid runs them through DOMPurify), it does
 * not read the YAML inside `@{ … }`, and it does not apply configuration. Where
 * one of those decides something, the reading says "not known here" rather
 * than guessing, and the comparison with mermaid's reading skips exactly that.
 */
import { MERMAID_FLOW_GRAMMAR, type MermaidFlowGrammarData } from './MermaidFlowGrammar'

// ---------------------------------------------------------------------------
// The public model
// ---------------------------------------------------------------------------

/** A half-open `[start, end)` range of the source text. */
export type MermaidSourceSpan = { start: number; end: number }

/**
 * What a piece of the text is. `token` and `skipped` are what mermaid's lexer
 * consumed (a `skipped` match switches the lexer's state and hands the parser
 * nothing: a quote, the `}` that ends shape data). The rest is text mermaid
 * removes before it parses: a frontmatter block, a `%%{…}%%` directive, a `%%`
 * comment line, whitespace, the `;` it drops from a style line. `unread` is
 * whatever follows the point where the lexer gave up.
 */
export type MermaidSourcePieceKind =
  'token' | 'skipped' | 'frontmatter' | 'directive' | 'comment' | 'space' | 'semicolon' | 'unread'

export type MermaidSourcePiece = {
  kind: MermaidSourcePieceKind
  /** The piece's own characters, exactly as they are in the source. */
  text: string
  start: number
  end: number
  /** For a token: the name mermaid's grammar gives it (`NODE_STRING`, `LINK`, …). */
  token?: string
  /**
   * True when the piece does not stand for its characters one to one — it
   * begins or ends inside an entity code (`#quot;`), which mermaid replaces
   * with a longer placeholder before lexing. Such a piece is never edited.
   */
  irregular?: boolean
}

export type MermaidSourceLine = {
  /** Offset of the line's first character. */
  start: number
  /** Offset just past its last character, terminator excluded. */
  end: number
  /** The terminator as written: `\n`, `\r\n`, `\r`, or empty on the last line. */
  eol: string
}

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

export type MermaidFlowProblemKind =
  /** The text is not a flowchart at all. */
  | 'not-flowchart'
  /** A character mermaid's lexer has no rule for. */
  | 'lexical'
  /** A token mermaid's grammar does not allow there. */
  | 'syntax'
  /** The text parses and mermaid then refuses it (a `linkStyle` past the last link, an unnamed group). */
  | 'rejected'
  /** A construct this module reads but cannot follow all the way (shape data on a link or a group). */
  | 'unsure'

export type MermaidFlowProblem = {
  kind: MermaidFlowProblemKind
  message: string
  offset: number
  /** Counted from 0. */
  line: number
}

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
// The grammar, made runnable
// ---------------------------------------------------------------------------

type LexOperation =
  | { op: 'push'; state: string }
  | { op: 'pop' }
  | { op: 'token'; symbol: number }
  | { op: 'stranger'; name: string }
  | { op: 'empty' }
  | { op: 'breaks' }
  | { op: 'graph' }

const NO_ACTION = 0
const SHIFT = 1
const REDUCE = 2
const ACCEPT = 3
const GOTO = 4

type Production = {
  left: number
  length: number
  /** `vertex: idString SQS text SQE`; null for a production nothing reduces. */
  shape: string | null
}

type CompiledGrammar = {
  symbols: string[]
  symbolCount: number
  endOfInput: number
  /** Index 0 is unused: jison numbers productions from 1. */
  productions: Production[]
  actionKind: Uint8Array
  actionTarget: Int32Array
  rules: RegExp[]
  conditions: Map<string, number[]>
  lexOperations: LexOperation[][]
  handlers: (Handler | undefined)[]
  /** Reachable productions that have neither a handler nor a place on the pass-through list. */
  unhandled: string[]
}

function compileGrammar(data: MermaidFlowGrammarData): CompiledGrammar {
  const symbols = data.symbols
  const symbolCount = symbols.length
  const endOfInput = symbols.indexOf('$end')

  const productions: Production[] = [{ left: -1, length: 0, shape: null }]
  for (const entry of data.productions.split(' ')) {
    const [leftText, rightText] = entry.split('>')
    const left = Number(leftText)
    if (rightText.startsWith('?')) {
      productions.push({ left, length: Number(rightText.slice(1)), shape: null })
      continue
    }
    const right = rightText === '' ? [] : rightText.split(',').map(Number)
    const shape = `${symbols[left]}: ${right.map((symbol) => symbols[symbol]).join(' ')}`.trim()
    productions.push({ left, length: right.length, shape })
  }

  const stateCount = data.table.length
  const actionKind = new Uint8Array(stateCount * symbolCount)
  const actionTarget = new Int32Array(stateCount * symbolCount)
  data.table.forEach((row, state) => {
    for (const group of row.split(' ')) {
      if (group === '') {
        continue
      }
      const [action, symbolList] = group.split(':')
      const kind = action[0] === 's' ? SHIFT : action[0] === 'r' ? REDUCE : action[0] === 'g' ? GOTO : ACCEPT
      const target = kind === ACCEPT ? 0 : Number(action.slice(1))
      for (const symbol of symbolList.split(',')) {
        const cell = state * symbolCount + Number(symbol)
        actionKind[cell] = kind
        actionTarget[cell] = target
      }
    }
  })

  const conditions = new Map<string, number[]>()
  for (const [name, rules] of Object.entries(data.lexConditions)) {
    conditions.set(name, rules === '' ? [] : rules.split(',').map(Number))
  }

  const lexOperations = data.lexActions.map((action) =>
    action
      .split(' ')
      .filter((word) => word !== '')
      .map((word): LexOperation => {
        if (word === '-') {
          return { op: 'pop' }
        }
        if (word === 'e') {
          return { op: 'empty' }
        }
        if (word === 'b') {
          return { op: 'breaks' }
        }
        if (word === 'g') {
          return { op: 'graph' }
        }
        if (word.startsWith('+')) {
          return { op: 'push', state: word.slice(1) }
        }
        if (word.startsWith('=?')) {
          return { op: 'stranger', name: word.slice(2) }
        }
        return { op: 'token', symbol: Number(word.slice(1)) }
      }),
  )

  const unhandled: string[] = []
  const handlers = productions.map((production) => {
    if (production.shape === null) {
      return undefined
    }
    const handler = HANDLERS[production.shape]
    if (handler) {
      return handler
    }
    if (PASS_THROUGH.has(production.shape)) {
      return passThrough
    }
    unhandled.push(production.shape)
    return undefined
  })

  return {
    symbols,
    symbolCount,
    endOfInput,
    productions,
    actionKind,
    actionTarget,
    // Sticky, at an offset: the same match jison makes against a slice, for
    // rules that cannot look behind their first character (the generator
    // refuses any that could).
    rules: data.lexRules.map((body) => new RegExp(body, 'y')),
    conditions,
    lexOperations,
    handlers,
    unhandled,
  }
}

let compiledGrammar: CompiledGrammar | undefined
function grammar(): CompiledGrammar {
  if (!compiledGrammar) {
    compiledGrammar = compileGrammar(MERMAID_FLOW_GRAMMAR)
  }
  return compiledGrammar
}

/**
 * The productions of the embedded grammar this module gives no meaning to.
 * Empty, or the builder would be reading some statement by default rules; the
 * spec holds it at empty so that a regenerated grammar with a new production
 * is noticed before anything is edited with it.
 */
export function unhandledMermaidFlowProductions(): string[] {
  return [...grammar().unhandled]
}

// ---------------------------------------------------------------------------
// What mermaid does to the text before its parser sees it
// ---------------------------------------------------------------------------

/**
 * A text, and for each of its characters the range of the SOURCE it stands for.
 * Mermaid rewrites a diagram's text six times before parsing it; this is how a
 * token found in the rewritten text is traced back to the characters the user
 * actually typed.
 */
type MappedText = { text: string; from: number[]; to: number[] }
type Removal = MermaidSourceSpan & { kind: MermaidSourcePieceKind }
type MappedEdit = { at: number; until: number; insert: string; kind?: MermaidSourcePieceKind }

function applyMappedEdits(
  mapped: MappedText,
  edits: MappedEdit[],
  removals: Removal[],
  sourceLength: number,
): MappedText {
  if (edits.length === 0) {
    return mapped
  }
  let text = ''
  const from: number[] = []
  const to: number[] = []
  let cursor = 0
  const keep = (until: number) => {
    for (let index = cursor; index < until; index++) {
      from.push(mapped.from[index])
      to.push(mapped.to[index])
    }
    text += mapped.text.slice(cursor, until)
  }
  for (const edit of edits) {
    keep(edit.at)
    const start = edit.at < mapped.text.length ? mapped.from[edit.at] : sourceLength
    const end = edit.until > edit.at ? mapped.to[edit.until - 1] : start
    if (edit.insert === '') {
      if (end > start) {
        removals.push({ start, end, kind: edit.kind ?? 'space' })
      }
    } else {
      for (let index = 0; index < edit.insert.length; index++) {
        from.push(start)
        to.push(end)
      }
      text += edit.insert
    }
    cursor = edit.until
  }
  keep(mapped.text.length)
  return { text, from, to }
}

// Mermaid's own patterns, as it writes them (11.17.2: `frontMatterRegex` and
// `directiveRegex` in its utils chunk, `cleanupComments`, `cleanupText`,
// `encodeEntities`, and the flowchart parser's wrapper). Two are built from
// strings only because they contain a bare `{`, which a regex literal may not.
const FRONT_MATTER = /^([^\S\n\r]*)-{3}\s*[\n\r](.*?)[\n\r]\1-{3}\s*[\n\r]+/s
const DIRECTIVE = new RegExp(
  '%{2}{\\s*(?:(\\w+)\\s*:|(\\w+))\\s*(?:(\\w+)|((?:(?!}%{2}).|\\r?\\n)*))?\\s*(?:}%{2})?',
  'gi',
)
const COMMENT_LINE = new RegExp('^\\s*%%(?!{)[^\\n]+\\n?', 'gm')
const CARRIAGE_RETURN = /\r\n?/g
const TAG = /<(\w+)([^>]*)>/g
const TAG_ATTRIBUTE = /="([^"]*)"/g
const STYLE_WITH_HASH = /style.*:\S*#.*;/g
const CLASSDEF_WITH_HASH = /classDef.*:\S*#.*;/g
const ENTITY_CODE = /#\w+;/g
const SPACE_AFTER_BRACE = /\}\s*\n/g

function preprocess(source: string): { mapped: MappedText; removals: Removal[] } {
  const removals: Removal[] = []
  let mapped: MappedText = { text: source, from: [], to: [] }
  for (let index = 0; index < source.length; index++) {
    mapped.from.push(index)
    mapped.to.push(index + 1)
  }
  const step = (edits: MappedEdit[]) => {
    mapped = applyMappedEdits(mapped, edits, removals, source.length)
  }
  const each = (pattern: RegExp, toEdits: (match: RegExpExecArray) => MappedEdit[]) => {
    const edits: MappedEdit[] = []
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(mapped.text)) !== null) {
      if (match[0] === '') {
        pattern.lastIndex++
        continue
      }
      edits.push(...toEdits(match))
    }
    step(edits)
  }

  // cleanupText: one newline convention, and `="…"` inside a tag becomes `='…'`.
  each(CARRIAGE_RETURN, (match) => [{ at: match.index, until: match.index + match[0].length, insert: '\n' }])
  each(TAG, (match) => {
    const edits: MappedEdit[] = []
    const attributesAt = match.index + 1 + match[1].length
    TAG_ATTRIBUTE.lastIndex = 0
    let attribute: RegExpExecArray | null
    while ((attribute = TAG_ATTRIBUTE.exec(match[2])) !== null) {
      const open = attributesAt + attribute.index + 1
      const close = attributesAt + attribute.index + attribute[0].length - 1
      edits.push({ at: open, until: open + 1, insert: "'" }, { at: close, until: close + 1, insert: "'" })
    }
    return edits
  })

  // extractFrontMatter: one block, and only at the very start.
  const frontMatter = FRONT_MATTER.exec(mapped.text)
  if (frontMatter) {
    step([{ at: 0, until: frontMatter[0].length, insert: '', kind: 'frontmatter' }])
  }

  // removeDirectives, then cleanupComments and its trimStart.
  each(DIRECTIVE, (match) => [{ at: match.index, until: match.index + match[0].length, insert: '', kind: 'directive' }])
  each(COMMENT_LINE, (match) => [
    { at: match.index, until: match.index + match[0].length, insert: '', kind: 'comment' },
  ])
  const leading = mapped.text.length - mapped.text.trimStart().length
  if (leading > 0) {
    step([{ at: 0, until: leading, insert: '', kind: 'space' }])
  }

  // encodeEntities: the `;` that ends a style line with a `#colour` goes (it
  // would otherwise close an entity code), then every `#name;` becomes a
  // placeholder that survives the lexer.
  const dropLast = (match: RegExpExecArray): MappedEdit[] => {
    const last = match.index + match[0].length - 1
    return [{ at: last, until: last + 1, insert: '', kind: 'semicolon' }]
  }
  each(STYLE_WITH_HASH, dropLast)
  each(CLASSDEF_WITH_HASH, dropLast)
  each(ENTITY_CODE, (match) => {
    const inner = match[0].slice(1, -1)
    const isNumber = /^\+?\d+$/.test(inner)
    return [
      {
        at: match.index,
        until: match.index + match[0].length,
        insert: (isNumber ? 'ﬂ°°' : 'ﬂ°') + inner + '¶ß',
      },
    ]
  })

  // Diagram.fromText appends a newline; the flowchart parser's wrapper then
  // strips whitespace between a `}` and the end of its line.
  step([{ at: mapped.text.length, until: mapped.text.length, insert: '\n' }])
  each(SPACE_AFTER_BRACE, (match) => {
    if (match[0].length <= 2) {
      return []
    }
    return [{ at: match.index + 1, until: match.index + match[0].length - 1, insert: '', kind: 'space' }]
  })

  return { mapped, removals }
}

// ---------------------------------------------------------------------------
// The lexer
// ---------------------------------------------------------------------------

type LexedMatch = {
  /** Offsets in the preprocessed text. */
  at: number
  until: number
  /** The symbol handed to the parser; -1 for a match that hands it nothing. */
  symbol: number
  /** What the parser receives as the token's value (mermaid's `yytext`). */
  value: string
  /** A token name mermaid's lexer returns and its grammar has no symbol for. */
  stranger?: string
}

type LexResult = { matches: LexedMatch[]; failedAt: number | null }

const EOF_SENTINEL = -2

function lexFlowchart(text: string, compiled: CompiledGrammar): LexResult {
  const matches: LexedMatch[] = []
  const stack: string[] = ['INITIAL']
  let position = 0
  let done = false
  let firstGraph = true
  // Every match consumes a character or changes state, except a handful that
  // can match nothing; this is a ceiling no real text approaches.
  let budget = text.length * 4 + 64

  while (budget-- > 0) {
    if (done) {
      matches.push({ at: position, until: position, symbol: EOF_SENTINEL, value: '' })
      return { matches, failedAt: null }
    }
    if (position >= text.length) {
      done = true
    }
    const rules = compiled.conditions.get(stack[stack.length - 1]) ?? []
    let matchedRule = -1
    let matchedText = ''
    for (const rule of rules) {
      const pattern = compiled.rules[rule]
      pattern.lastIndex = position
      const found = pattern.exec(text)
      if (found) {
        matchedRule = rule
        matchedText = found[0]
        break
      }
    }
    if (matchedRule < 0) {
      if (position >= text.length) {
        matches.push({ at: position, until: position, symbol: EOF_SENTINEL, value: '' })
        return { matches, failedAt: null }
      }
      return { matches, failedAt: position }
    }

    let symbol = -1
    let value = matchedText
    let stranger: string | undefined
    for (const operation of compiled.lexOperations[matchedRule]) {
      switch (operation.op) {
        case 'push':
          stack.push(operation.state)
          break
        case 'pop':
          if (stack.length > 1) {
            stack.pop()
          }
          break
        case 'graph':
          if (firstGraph) {
            firstGraph = false
            stack.push('dir')
          }
          break
        case 'empty':
          value = ''
          break
        case 'breaks':
          value = value.replace(/\n\s*/g, '<br/>')
          break
        case 'token':
          symbol = operation.symbol
          break
        case 'stranger':
          symbol = -3
          stranger = operation.name
          break
      }
    }
    matches.push({ at: position, until: position + matchedText.length, symbol, value, stranger })
    position += matchedText.length
  }
  return { matches, failedAt: position }
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

/** Thrown where mermaid itself would throw, or where the imitation cannot follow it. */
class ReadFailure extends Error {
  kind: MermaidFlowProblemKind
  constructor(kind: MermaidFlowProblemKind, message: string) {
    super(message)
    this.kind = kind
  }
}

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
        throw new ReadFailure('unsure', `"${id}" is a group given shape data over several lines`)
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
      throw new ReadFailure('rejected', `more than ${MAX_EDGES} links, which mermaid refuses`)
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
      throw new ReadFailure('rejected', `linkStyle ${position} names a link that does not exist`)
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
      throw new ReadFailure('rejected', 'a group with no name, which mermaid refuses')
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
        throw new ReadFailure('unsure', 'a group holds something this reader does not know')
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

/** One entry of the parser's stack: a symbol, the pieces it covers, and its value. */
type Entry = { symbol: number; first: number; last: number; value: unknown }

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

type Handler = (kids: Entry[], reader: Reader) => unknown

const passThrough: Handler = (kids) => kids[0]?.value

class Reader {
  db = new FlowDatabase()
  header: MermaidFlowHeader | null = null
  top: DocumentValue | null = null
  /** Edge sites in mermaid's order; the statement is filled in once it has an index. */
  sites: { owner: VertexStatementValue; link: number; start: number; end: number }[] = []

  // Declared and assigned by hand: the contract script runs this file through
  // Node's type stripping, which has no parameter properties.
  readonly source: string
  readonly pieces: MermaidSourcePiece[]

  constructor(source: string, pieces: MermaidSourcePiece[]) {
    this.source = source
    this.pieces = pieces
  }

  /** The source range of the pieces `[first, last)`; empty, at the right place, when there are none. */
  range(first: number, last: number): MermaidSourceSpan {
    if (last > first) {
      return { start: this.pieces[first].start, end: this.pieces[last - 1].end }
    }
    const at = first < this.pieces.length ? this.pieces[first].start : this.source.length
    return { start: at, end: at }
  }

  span(entry: Entry): MermaidSourceSpan {
    return this.range(entry.first, entry.last)
  }

  /** `span`, with the whitespace at either end left out. */
  trimmed(entry: Entry): MermaidSourceSpan {
    const span = this.span(entry)
    return this.trimmedRange(span.start, span.end)
  }

  trimmedRange(from: number, until: number): MermaidSourceSpan {
    const written = this.source.slice(from, until)
    const start = from + (written.length - written.trimStart().length)
    const end = until - (written.length - written.trimEnd().length)
    return end >= start ? { start, end } : { start: from, end: from }
  }

  between(left: Entry, right: Entry): MermaidSourceSpan {
    return { start: this.span(left).end, end: this.span(right).start }
  }

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
    throw new ReadFailure('unsure', 'a link form mermaid’s lexer never produces')
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
// Reading a source
// ---------------------------------------------------------------------------

function splitLines(source: string): MermaidSourceLine[] {
  const lines: MermaidSourceLine[] = []
  const terminator = /\r\n|\n|\r/g
  let start = 0
  let match: RegExpExecArray | null
  while ((match = terminator.exec(source)) !== null) {
    lines.push({ start, end: match.index, eol: match[0] })
    start = match.index + match[0].length
  }
  lines.push({ start, end: source.length, eol: '' })
  return lines
}

/** The index of the line an offset falls on. */
export function mermaidSourceLineAt(lines: readonly MermaidSourceLine[], offset: number): number {
  let low = 0
  let high = lines.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (lines[middle].start <= offset) {
      low = middle
    } else {
      high = middle - 1
    }
  }
  return low
}

/** The pieces for everything up to `until`, which no token covers: text mermaid removed. */
function fillRemoved(
  source: string,
  pieces: MermaidSourcePiece[],
  removals: Removal[],
  from: number,
  until: number,
): void {
  let cursor = from
  for (const removal of removals) {
    if (removal.end <= cursor || removal.start >= until) {
      continue
    }
    const start = Math.max(removal.start, cursor)
    const end = Math.min(removal.end, until)
    if (start > cursor) {
      pieces.push({ kind: 'unread', text: source.slice(cursor, start), start: cursor, end: start })
    }
    pieces.push({ kind: removal.kind, text: source.slice(start, end), start, end })
    cursor = end
  }
  if (cursor < until) {
    pieces.push({ kind: 'unread', text: source.slice(cursor, until), start: cursor, end: until })
  }
}

const FLOWCHART_START = /^\s*(?:graph|flowchart)(?![\w-])/

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

/**
 * The tokens this module's lexer makes of a source, as mermaid's own lexer
 * would report them: the token's name (null for a match that hands the parser
 * nothing) and the characters matched, in the text mermaid's parser is handed.
 * For the contract test, which runs mermaid's lexer over the same text and
 * expects the same list; nothing in the app calls it.
 */
export function lexMermaidFlowSource(source: string): { token: string | null; text: string }[] {
  const compiled = grammar()
  const { mapped } = preprocess(source)
  const { matches } = lexFlowchart(mapped.text, compiled)
  return matches
    .filter((match) => match.symbol !== EOF_SENTINEL)
    .map((match) => ({
      token: match.symbol === -1 ? null : (match.stranger ?? compiled.symbols[match.symbol]),
      text: mapped.text.slice(match.at, match.until),
    }))
}

/**
 * Read a diagram's text. Never throws, and never loses a character: whatever
 * `source` is, the pieces of the result print back to it.
 */
export function parseMermaidFlowSource(source: string): MermaidFlowDocument {
  const compiled = grammar()
  const lines = splitLines(source)
  const { mapped, removals } = preprocess(source)
  removals.sort((a, b) => a.start - b.start)
  const { matches, failedAt } = lexFlowchart(mapped.text, compiled)

  // Pieces: every lexer match traced back to the characters it stands for,
  // and between them whatever mermaid took out before lexing.
  const pieces: MermaidSourcePiece[] = []
  const tokens: { symbol: number; piece: number; value: string; stranger?: string }[] = []
  let cursor = 0
  for (const match of matches) {
    if (match.symbol === EOF_SENTINEL) {
      tokens.push({ symbol: compiled.endOfInput, piece: -1, value: '' })
      continue
    }
    const isEmpty = match.until === match.at
    const wantedStart = match.at < mapped.text.length ? mapped.from[match.at] : source.length
    const wantedEnd = isEmpty ? wantedStart : mapped.to[match.until - 1]
    const start = Math.max(wantedStart, cursor)
    const end = Math.max(wantedEnd, start)
    if (start > cursor) {
      fillRemoved(source, pieces, removals, cursor, start)
    }
    // A match that begins or ends part-way through a placeholder shares its
    // source characters with a neighbour; neither can be edited on its own.
    const sharesStart =
      !isEmpty &&
      match.at > 0 &&
      mapped.from[match.at - 1] === mapped.from[match.at] &&
      mapped.to[match.at - 1] === mapped.to[match.at]
    const sharesEnd =
      !isEmpty &&
      match.until < mapped.text.length &&
      mapped.from[match.until] === mapped.from[match.until - 1] &&
      mapped.to[match.until] === mapped.to[match.until - 1]
    const piece: MermaidSourcePiece = {
      kind: match.symbol === -1 ? 'skipped' : 'token',
      text: source.slice(start, end),
      start,
      end,
    }
    if (match.symbol !== -1) {
      piece.token = match.stranger ?? compiled.symbols[match.symbol]
      tokens.push({ symbol: match.symbol, piece: pieces.length, value: match.value, stranger: match.stranger })
    }
    if (wantedStart !== start || sharesStart || sharesEnd) {
      piece.irregular = true
    }
    pieces.push(piece)
    cursor = end
  }
  if (cursor < source.length) {
    if (failedAt === null) {
      fillRemoved(source, pieces, removals, cursor, source.length)
    } else {
      pieces.push({ kind: 'unread', text: source.slice(cursor), start: cursor, end: source.length })
    }
  }

  const document: MermaidFlowDocument = {
    source,
    pieces,
    lines,
    problem: null,
    header: null,
    statements: [],
    edges: [],
    reading: null,
    parsedText: mapped.text,
  }
  const fail = (kind: MermaidFlowProblemKind, message: string, offset: number): MermaidFlowDocument => {
    document.problem = { kind, message, offset, line: mermaidSourceLineAt(lines, Math.min(offset, source.length)) }
    return document
  }

  if (!FLOWCHART_START.test(mapped.text)) {
    return fail('not-flowchart', 'This is not a flowchart.', 0)
  }
  if (failedAt !== null) {
    const offset = failedAt < mapped.text.length ? mapped.from[failedAt] : source.length
    return fail('lexical', 'Mermaid cannot read this text from here.', offset)
  }
  if (compiled.unhandled.length > 0) {
    return fail('unsure', `The builder does not know this grammar: ${compiled.unhandled[0]}`, 0)
  }

  // The LALR driver, as jison writes it, over tokens that are already lexed
  // (mermaid's lexer does not depend on its parser, so lexing first is the same).
  const reader = new Reader(source, pieces)
  const states: number[] = [0]
  const entries: Entry[] = []
  let next = 0
  const offsetOfToken = (index: number): number => {
    const token = tokens[Math.min(index, tokens.length - 1)]
    return token.piece >= 0 ? pieces[token.piece].start : source.length
  }
  for (;;) {
    const token = tokens[Math.min(next, tokens.length - 1)]
    const state = states[states.length - 1]
    if (token.symbol < 0) {
      return fail('syntax', `Mermaid does not expect "${token.stranger ?? ''}" here.`, offsetOfToken(next))
    }
    const cell = state * compiled.symbolCount + token.symbol
    const kind = compiled.actionKind[cell]
    if (kind === SHIFT) {
      states.push(compiled.actionTarget[cell])
      const piece = token.piece >= 0 ? token.piece : pieces.length
      entries.push({
        symbol: token.symbol,
        first: piece,
        last: token.piece >= 0 ? piece + 1 : piece,
        value: token.value,
      })
      next++
      continue
    }
    if (kind === REDUCE) {
      const production = compiled.productions[compiled.actionTarget[cell]]
      const kids = production.length > 0 ? entries.splice(entries.length - production.length) : []
      states.length -= production.length
      const upcoming = token.piece >= 0 ? token.piece : pieces.length
      const first = kids.length > 0 ? kids[0].first : upcoming
      const last = kids.length > 0 ? kids[kids.length - 1].last : upcoming
      const handler = compiled.handlers[compiled.actionTarget[cell]]
      let value: unknown
      try {
        value = handler ? handler(kids, reader) : kids[0]?.value
      } catch (error) {
        if (error instanceof ReadFailure) {
          const at = kids.length > 0 ? reader.range(first, last).start : offsetOfToken(next)
          return fail(error.kind, error.message, at)
        }
        throw error
      }
      entries.push({ symbol: production.left, first, last, value })
      const goto = states[states.length - 1] * compiled.symbolCount + production.left
      if (compiled.actionKind[goto] !== GOTO) {
        return fail('syntax', 'Mermaid cannot read this statement.', offsetOfToken(next))
      }
      states.push(compiled.actionTarget[goto])
      continue
    }
    if (kind === ACCEPT) {
      break
    }
    if (kind === NO_ACTION || kind === GOTO) {
      const at = offsetOfToken(next)
      const piece = token.piece >= 0 ? pieces[token.piece] : undefined
      const written = piece?.text.trim() ?? ''
      const shown =
        written !== ''
          ? `"${written.length > 24 ? written.slice(0, 24) + '…' : written}"`
          : piece?.token === 'NEWLINE'
            ? 'the line to end'
            : 'the text to end'
      return fail('syntax', `Mermaid does not expect ${shown} here.`, at)
    }
  }

  const { statements, edges } = finishStatements(reader, lines)
  document.header = reader.header
  document.statements = statements
  document.edges = edges
  document.reading = reader.db.reading()
  return document
}

/** The text a document was read from, rebuilt from its pieces. */
export function printMermaidFlowDocument(document: Pick<MermaidFlowDocument, 'pieces'>): string {
  let text = ''
  for (const piece of document.pieces) {
    text += piece.text
  }
  return text
}

// ---------------------------------------------------------------------------
// Labels: what is written, what mermaid keeps, what a person sees
// ---------------------------------------------------------------------------

const BASIC_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/**
 * A label as a person reads it, from either side of mermaid: the text mermaid
 * keeps for a label (entity codes as placeholders, `&` already written
 * `&amp;` by its sanitiser, a line break as `<br>`), or the text someone typed
 * into the builder. Both come out the same when they would draw the same, which
 * is the only question the builder asks of a label.
 */
export function plainMermaidLabel(value: string): string {
  // What mermaid's `encodeEntities` does to a typed `#name;` (nothing, to text
  // mermaid already holds), then what its `decodeEntities` does on the way to
  // the screen.
  const encoded = value.replace(
    /#(\w+);/g,
    (_whole, inner: string) => (/^\+?\d+$/.test(inner) ? 'ﬂ°°' : 'ﬂ°') + inner + '¶ß',
  )
  const decoded = encoded.replace(/ﬂ°°/g, '&#').replace(/ﬂ°/g, '&').replace(/¶ß/g, ';')
  return decoded
    .replace(/<br\s*\/?>/gi, '<br/>')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, inner: string) => {
      if (inner[0] === '#') {
        const code = inner[1].toLowerCase() === 'x' ? parseInt(inner.slice(2), 16) : parseInt(inner.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
      }
      return BASIC_ENTITIES[inner.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()
}

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
