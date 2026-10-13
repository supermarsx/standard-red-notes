/**
 * Standard Red Notes — a LOSSLESS reading of a mermaid diagram's text, and the
 * machinery that reads it with mermaid's own grammar.
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
 * Mermaid's, literally. A grammar file such as `MermaidFlowGrammar.ts` is
 * generated from the installed package: a diagram kind's lexer rules,
 * conditions and actions, and its LALR table. This module runs them, after
 * applying to the text the same rewrites mermaid applies before it parses, with
 * every character traced back to the source it stands for. So a token ends
 * where mermaid's token ends, and a statement is the statement mermaid's parser
 * reduces.
 *
 * WHAT IS PER DIAGRAM KIND, AND WHAT IS NOT
 *
 * Nothing in this file knows what a flowchart is. A kind of diagram is a
 * `MermaidSourceLanguage`: its grammar, one handler per production (what the
 * production MEANS, and where it was written), and a reader the handlers fill.
 * `MermaidFlowDoc.ts` is the flowchart's. A second kind — mermaid parses
 * sequence, state, class and ER diagrams with jison grammars too — is a second
 * grammar file and a second set of handlers over the same pieces, the same
 * rewrites, the same lexer and the same parser driver.
 *
 * WHAT IT DOES NOT DO
 *
 * It does not sanitise labels (mermaid runs them through DOMPurify), it does
 * not read YAML — not the frontmatter and not the inside of `@{ … }` — and it
 * does not apply configuration.
 */

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
   * True when the piece does not stand for its characters one to one. Either it
   * begins or ends inside an entity code (`#quot;`), which mermaid replaces
   * with a longer placeholder before lexing; or it has text inside it that
   * mermaid removed — a link token runs across line ends, so a comment line
   * between a box and the arrow that continues its statement is INSIDE the
   * link's piece. Such a piece is never edited.
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

export type MermaidSourceProblemKind =
  /** The text is not the kind of diagram this reader reads. */
  | 'other-kind'
  /** A character mermaid's lexer has no rule for. */
  | 'lexical'
  /** A token mermaid's grammar does not allow there. */
  | 'syntax'
  /** The text parses and mermaid then refuses it (in a flowchart: a `linkStyle` past the last link, an unnamed group). */
  | 'rejected'
  /** A construct the reader follows only part of the way (in a flowchart: shape data on a link or a group). */
  | 'unsure'

export type MermaidSourceProblem = {
  kind: MermaidSourceProblemKind
  message: string
  offset: number
  /** Counted from 0. */
  line: number
}

/** A text as read: its pieces, and what a kind's reader made of it. */
export type MermaidSourceDocument<Result> = {
  source: string
  /** The whole text, in order, with no gap and no overlap. */
  pieces: MermaidSourcePiece[]
  lines: MermaidSourceLine[]
  /** Why this text was not read to the end; null when it was. */
  problem: MermaidSourceProblem | null
  /** What the kind's reader made of it; null whenever there is a problem. */
  result: Result | null
  /** The text mermaid's parser is handed for this source. */
  parsedText: string
}

/**
 * A mermaid grammar as data, as `scripts/GenerateMermaidFlowGrammar.mjs` writes
 * it from the installed package.
 */
export type MermaidGrammarData = {
  /** The mermaid version this was generated from. */
  mermaid: string
  /** Symbol names by symbol number, terminals and non-terminals alike. */
  symbols: string[]
  /** The symbol numbers that are terminals, comma separated. */
  terminals: string
  /** `left>symbol,symbol` per production, space separated, production 1 first; `left>?n` is one nothing reduces. */
  productions: string
  /** Per parser state: `s<state>` shift, `r<production>` reduce, `g<state>` goto, `a` accept, each `:symbols`. */
  table: string[]
  /** Lexer rule bodies, to be run sticky at an offset. */
  lexRules: string[]
  /** Per lexer condition, the rules it tries, in order. */
  lexConditions: Record<string, string>
  /**
   * Per lexer rule: `+state` push, `-` pop, `=n` return symbol n, `=?NAME`
   * return a name the parser has no symbol for, `e` hand the parser an empty
   * value, `b` turn line breaks in the value into `<br/>`, `g` push `dir` the
   * first time it fires in a text.
   */
  lexActions: string[]
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

/** One entry of the parser's stack: a symbol, the pieces it covers, and its value. */
export type MermaidSourceEntry = { symbol: number; first: number; last: number; value: unknown }

/** What a production means: given the entries it reduces and the kind's reader, its value. */
export type MermaidSourceHandler<Reader> = (kids: MermaidSourceEntry[], reader: Reader) => unknown

/** A grammar ready to run, with one kind's handlers bound to its productions. */
export type MermaidCompiledGrammar<Reader> = {
  /** The mermaid version the grammar was generated from. */
  mermaid: string
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
  handlers: (MermaidSourceHandler<Reader> | undefined)[]
  /** Reachable productions that have neither a handler nor a place on the pass-through list. */
  unhandled: string[]
}

/** The value of a production that only passes its first symbol's value on, as jison's default action does. */
const passThrough = (kids: MermaidSourceEntry[]): unknown => kids[0]?.value

/**
 * Make a grammar runnable for one kind of diagram. `handlers` are keyed by the
 * production's shape (`vertex: idString SQS text SQE`), not by its number, so a
 * grammar that renumbers its productions cannot hand one production's tokens to
 * another's handler; `passThrough` lists the shapes that need none. A reachable
 * production in neither is reported in `unhandled`, and a grammar with any is
 * not read with at all.
 */
export function compileMermaidGrammar<Reader>(
  data: MermaidGrammarData,
  handlers: Readonly<Record<string, MermaidSourceHandler<Reader>>>,
  passThroughShapes: ReadonlySet<string>,
): MermaidCompiledGrammar<Reader> {
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
  const bound = productions.map((production): MermaidSourceHandler<Reader> | undefined => {
    if (production.shape === null) {
      return undefined
    }
    if (Object.prototype.hasOwnProperty.call(handlers, production.shape)) {
      return handlers[production.shape]
    }
    if (passThroughShapes.has(production.shape)) {
      return passThrough
    }
    unhandled.push(production.shape)
    return undefined
  })

  return {
    mermaid: data.mermaid,
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
    handlers: bound,
    unhandled,
  }
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
// `directiveRegex` in its utils chunk, `cleanupComments`, `cleanupText` and
// `encodeEntities`). Every kind of diagram goes through these. Two are built
// from strings only because they contain a bare `{`, which a regex literal may
// not.
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

/**
 * Something one kind's parser wrapper takes out of the text after the rewrites
 * every kind shares: a global pattern, and for each match the part of it to
 * remove (offsets within the match), or null to leave the match alone.
 */
export type MermaidSourceRewrite = {
  pattern: RegExp
  remove: (match: RegExpExecArray) => { from: number; to: number } | null
}

function preprocess(
  source: string,
  rewrites: readonly MermaidSourceRewrite[],
): { mapped: MappedText; removals: Removal[] } {
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

  // Diagram.fromText appends a newline. What follows is whatever this kind's
  // own parser wrapper does to the text on top of that.
  step([{ at: mapped.text.length, until: mapped.text.length, insert: '\n' }])
  for (const rewrite of rewrites) {
    each(rewrite.pattern, (match) => {
      const removed = rewrite.remove(match)
      if (removed === null || removed.to <= removed.from) {
        return []
      }
      return [{ at: match.index + removed.from, until: match.index + removed.to, insert: '', kind: 'space' }]
    })
  }

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

/**
 * Jison's lexer, as jison generates it with no options: in the current
 * condition, the FIRST rule that matches at the position wins, and its action
 * runs. The actions are the closed vocabulary the generator translates; the
 * `graph` one is the flowchart lexer's "the first graph keyword of a text
 * opens the direction condition".
 */
function lex<Reader>(text: string, compiled: MermaidCompiledGrammar<Reader>): LexResult {
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
// What a reader of one kind of diagram is given
// ---------------------------------------------------------------------------

/** Thrown by a handler where mermaid itself would throw, or where the reader cannot follow it. */
export class MermaidReadFailure extends Error {
  kind: MermaidSourceProblemKind
  constructor(kind: MermaidSourceProblemKind, message: string) {
    super(message)
    this.kind = kind
  }
}

/**
 * What every kind's reader starts from: the source, its pieces, and how to
 * turn the entries a production reduces into ranges of the source.
 */
export class MermaidSourceReader {
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

  span(entry: MermaidSourceEntry): MermaidSourceSpan {
    return this.range(entry.first, entry.last)
  }

  /** `span`, with the whitespace at either end left out. */
  trimmed(entry: MermaidSourceEntry): MermaidSourceSpan {
    const span = this.span(entry)
    return this.trimmedRange(span.start, span.end)
  }

  trimmedRange(from: number, until: number): MermaidSourceSpan {
    const written = this.source.slice(from, until)
    const start = from + (written.length - written.trimStart().length)
    const end = until - (written.length - written.trimEnd().length)
    return end >= start ? { start, end } : { start: from, end: from }
  }

  between(left: MermaidSourceEntry, right: MermaidSourceEntry): MermaidSourceSpan {
    return { start: this.span(left).end, end: this.span(right).start }
  }
}

/**
 * One kind of diagram, as this module needs to know it: how to tell the text is
 * that kind, the grammar with its handlers, what its parser wrapper takes out
 * of the text, and the reader its handlers fill.
 */
export type MermaidSourceLanguage<Reader extends MermaidSourceReader, Result> = {
  /** Does the text mermaid's parser is handed begin as this kind of diagram does? */
  recognises: RegExp
  /** Said when it does not. */
  otherKind: string
  grammar: MermaidCompiledGrammar<Reader>
  rewrites: readonly MermaidSourceRewrite[]
  begin: (source: string, pieces: MermaidSourcePiece[]) => Reader
  /** What the reader made of a text that was read to the end. */
  finish: (reader: Reader, lines: MermaidSourceLine[]) => Result
}

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

/**
 * The tokens this module's lexer makes of a source, as mermaid's own lexer
 * would report them: the token's name (null for a match that hands the parser
 * nothing) and the characters matched, in the text mermaid's parser is handed.
 * For the contract test, which runs mermaid's lexer over the same text and
 * expects the same list; nothing in the app calls it.
 */
export function lexMermaidSource<Reader extends MermaidSourceReader, Result>(
  source: string,
  language: MermaidSourceLanguage<Reader, Result>,
): { token: string | null; text: string }[] {
  const compiled = language.grammar
  const { mapped } = preprocess(source, language.rewrites)
  const { matches } = lex(mapped.text, compiled)
  return matches
    .filter((match) => match.symbol !== EOF_SENTINEL)
    .map((match) => ({
      token: match.symbol === -1 ? null : (match.stranger ?? compiled.symbols[match.symbol]),
      text: mapped.text.slice(match.at, match.until),
    }))
}

/**
 * Read a text as one kind of diagram. Never throws for any text, and never
 * loses a character: whatever `source` is, the pieces of the result print back
 * to it.
 */
export function parseMermaidSource<Reader extends MermaidSourceReader, Result>(
  source: string,
  language: MermaidSourceLanguage<Reader, Result>,
): MermaidSourceDocument<Result> {
  const compiled = language.grammar
  const lines = splitLines(source)
  const { mapped, removals } = preprocess(source, language.rewrites)
  removals.sort((a, b) => a.start - b.start)
  const { matches, failedAt } = lex(mapped.text, compiled)

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
    // And a match whose characters are not next to each other in the source
    // has text mermaid removed INSIDE it — a comment line between a box and
    // the arrow that continues its statement on the next line.
    let holdsRemovedText = false
    for (let index = match.at; index + 1 < match.until && !holdsRemovedText; index++) {
      const sameRegion = mapped.from[index] === mapped.from[index + 1] && mapped.to[index] === mapped.to[index + 1]
      holdsRemovedText = !sameRegion && mapped.to[index] !== mapped.from[index + 1]
    }
    if (wantedStart !== start || sharesStart || sharesEnd || holdsRemovedText) {
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

  const document: MermaidSourceDocument<Result> = {
    source,
    pieces,
    lines,
    problem: null,
    result: null,
    parsedText: mapped.text,
  }
  const fail = (kind: MermaidSourceProblemKind, message: string, offset: number): MermaidSourceDocument<Result> => {
    document.problem = { kind, message, offset, line: mermaidSourceLineAt(lines, Math.min(offset, source.length)) }
    return document
  }

  if (!language.recognises.test(mapped.text)) {
    return fail('other-kind', language.otherKind, 0)
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
  const reader = language.begin(source, pieces)
  const states: number[] = [0]
  const entries: MermaidSourceEntry[] = []
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
        if (error instanceof MermaidReadFailure) {
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

  document.result = language.finish(reader, lines)
  return document
}

/** The text a document was read from, rebuilt from its pieces. */
export function printMermaidSourceDocument(document: { pieces: readonly MermaidSourcePiece[] }): string {
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
// Changing a text, a few characters at a time
// ---------------------------------------------------------------------------

/** One replacement: the characters `[start, end)` of the source become `text`. */
export type MermaidSourceSplice = { start: number; end: number; text: string }

/** `source` with the splices applied, or null when two of them overlap. */
export function applyMermaidSourceSplices(source: string, splices: readonly MermaidSourceSplice[]): string | null {
  const ordered = splices
    .map((splice, order) => ({ ...splice, order }))
    .sort((a, b) => a.start - b.start || a.end - b.end || a.order - b.order)
  let result = ''
  let cursor = 0
  for (const splice of ordered) {
    if (splice.start < cursor || splice.end < splice.start) {
      return null
    }
    result += source.slice(cursor, splice.start) + splice.text
    cursor = splice.end
  }
  return result + source.slice(cursor)
}

/** Thrown inside an operation to refuse it: the reason, and the line it is about when there is one. */
export class MermaidEditRefusal extends Error {
  /** Counted from 0. */
  line: number | undefined
  constructor(reason: string, line?: number) {
    super(reason)
    this.line = line
  }
}

/**
 * What any operation on any kind of diagram asks of the text it is about to
 * change: where a line starts, how it is indented, whether a range can be
 * rewritten at all, and how to add lines without disturbing the ones around.
 */
export class MermaidSourceBench {
  readonly source: string
  readonly pieces: readonly MermaidSourcePiece[]
  readonly lines: readonly MermaidSourceLine[]
  /** The line ending the text uses: its first one, or a plain newline when it has none. */
  readonly eol: string

  constructor(document: {
    source: string
    pieces: readonly MermaidSourcePiece[]
    lines: readonly MermaidSourceLine[]
  }) {
    this.source = document.source
    this.pieces = document.pieces
    this.lines = document.lines
    this.eol = document.lines.find((line) => line.eol !== '')?.eol ?? '\n'
  }

  cut(span: MermaidSourceSpan): string {
    return this.source.slice(span.start, span.end)
  }

  lineOf(offset: number): number {
    return mermaidSourceLineAt(this.lines, offset)
  }

  indentOfLine(line: number): string {
    const { start, end } = this.lines[line]
    return /^[ \t]*/.exec(this.source.slice(start, end))?.[0] ?? ''
  }

  /** Every character of the span is a token standing for itself: no comment inside, no half entity code. */
  isClean(span: MermaidSourceSpan): boolean {
    for (const piece of this.pieces) {
      if (piece.end <= span.start || piece.start >= span.end || piece.end === piece.start) {
        continue
      }
      if ((piece.kind !== 'token' && piece.kind !== 'skipped') || piece.irregular) {
        return false
      }
    }
    return true
  }

  requireClean(span: MermaidSourceSpan, what: string): void {
    if (!this.isClean(span)) {
      throw new MermaidEditRefusal(
        `${what} is written in a way the builder will not rewrite; edit it in the code.`,
        this.lineOf(span.start),
      )
    }
  }

  /** New lines after line `line`, each with this indentation. */
  linesAfter(line: number, indent: string, texts: readonly string[]): MermaidSourceSplice {
    const { end, eol } = this.lines[line]
    if (eol === '') {
      return { start: end, end, text: texts.map((text) => this.eol + indent + text).join('') }
    }
    const at = end + eol.length
    return { start: at, end: at, text: texts.map((text) => indent + text + eol).join('') }
  }

  /** A whole line taken out, with its line ending — or, for the last line, the one before it. */
  withoutLine(line: number): MermaidSourceSplice {
    const { start, end, eol } = this.lines[line]
    if (eol !== '') {
      return { start, end: end + eol.length, text: '' }
    }
    return { start: line > 0 ? this.lines[line - 1].end : start, end, text: '' }
  }
}
