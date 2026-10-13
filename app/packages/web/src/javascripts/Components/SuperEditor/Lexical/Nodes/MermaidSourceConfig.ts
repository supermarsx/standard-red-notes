/**
 * Standard Red Notes — a diagram's own configuration, read out of its text and
 * written back into it.
 *
 * Mermaid takes a diagram's options from two places in the diagram's TEXT: a
 * YAML frontmatter block with a `config:` key, and `%%{init: …}%%` directive
 * lines (which win over the frontmatter). Customising a diagram here means
 * writing into that frontmatter, never into the block's stored settings,
 * because the text is the one thing every export carries, every older build of
 * this app keeps verbatim, and every other mermaid tool reads the same way.
 *
 * That makes this file the one place in the product that edits somebody's
 * diagram text on behalf of a control, so its contract is narrow on purpose:
 *
 *  - IT NEVER RE-EMITS A LINE IT DID NOT WRITE. A patch inserts a line, replaces
 *    the value on one line, or deletes a line. Every other line of the
 *    frontmatter, and every line after it, is left byte for byte as it was —
 *    its indentation, its spacing, its line ending.
 *  - IT REFUSES WHAT IT CANNOT READ EXACTLY, and says why. The reader below is a
 *    deliberately small subset of YAML: block mappings of plain keys, with
 *    scalar values on one line. A comment, an anchor, a tag, a flow collection,
 *    a multi-line scalar, a sequence, a duplicate key, a key mermaid does not
 *    define at the top level — each is a named refusal, and the text is
 *    returned to nobody. Guessing at YAML is how a control silently eats a
 *    diagram.
 *  - A VALUE IT IS NOT SURE OF IS REPORTED AS UNKNOWN, never as absent. The
 *    toolbar needs "what theme is this drawn in" synchronously, which is why
 *    this reader exists beside mermaid's own; where the two could disagree the
 *    answer is "this diagram sets its own options", not a guess.
 *    `scripts/MermaidConfigContract.mjs` runs this file against the installed
 *    mermaid over a corpus and fails if they ever read a text differently.
 *
 * WHAT THE APP RENDERS IS `text.trim()` (MermaidNode's render), so that is the
 * text this reads: leading blank lines do not stop a frontmatter being one, and
 * a frontmatter with nothing after it is not one — mermaid's pattern needs a
 * line break after the closing fence and `trim` has just removed it.
 *
 * Pure: no React, no mermaid, no DOM.
 */

/** A value a control may write, and the only kinds this reader reports. */
export type MermaidConfigScalar = string | number | boolean

/** A key inside `config:`, as the keys leading to it: `['flowchart', 'curve']`. */
export type MermaidConfigPath = readonly string[]

/** One edit. `value: undefined` removes the key (and any parent left empty). */
export type MermaidConfigChange = { path: MermaidConfigPath; value: MermaidConfigScalar | undefined }

/**
 * Why a text was not read, or not changed — one code per shape, so a caller and
 * a test can tell them apart without parsing a sentence.
 */
export type MermaidConfigRefusalCode =
  | 'empty-diagram'
  | 'frontmatter-not-closed'
  | 'frontmatter-fence-indented'
  | 'frontmatter-empty'
  | 'frontmatter-without-diagram'
  | 'yaml-comment'
  | 'yaml-anchor'
  | 'yaml-alias'
  | 'yaml-tag'
  | 'yaml-flow-collection'
  | 'yaml-multi-line-scalar'
  | 'yaml-sequence'
  | 'yaml-complex-key'
  | 'yaml-quoted-key'
  | 'yaml-document-marker'
  | 'yaml-tab-indentation'
  | 'yaml-indentation'
  | 'yaml-duplicate-key'
  | 'yaml-unreadable-line'
  | 'yaml-unreadable-value'
  | 'unknown-top-level-key'
  | 'config-is-not-a-mapping'
  | 'key-holds-a-value'
  | 'key-holds-a-mapping'
  | 'directive-sets-key'
  | 'invalid-change'
  | 'value-mermaid-discards'

export type MermaidConfigRefusal = {
  code: MermaidConfigRefusalCode
  /** 1-based line of the diagram's text, when the refusal is about one line. */
  line?: number
  /** The key the refusal is about, dotted, when it is about one key. */
  key?: string
  /** A sentence for the person, complete on its own. */
  message: string
}

/** What the text says about one key. */
export type MermaidConfigValueReading =
  | { state: 'unset' }
  | { state: 'set'; value: MermaidConfigScalar; from: 'frontmatter' | 'directive'; line: number }
  /** The text may set it, in a form this reader will not vouch for. */
  | { state: 'unknown'; reason: string }

type FrontmatterEntry = {
  key: string
  /** Index into the text's lines. */
  line: number
  indent: number
  /** `undefined` for a key with nothing after its colon. */
  scalar: MermaidConfigScalar | null | undefined
  /** Characters of the line up to where its value starts (or would). */
  valueStart: number
  children: FrontmatterEntry[]
}

type Line = { text: string; eol: string }

type ReadFrontmatter = {
  state: 'read'
  /** Line indexes of the two fences. */
  open: number
  close: number
  entries: FrontmatterEntry[]
}

export type MermaidSourceConfigReading = {
  /** Whether the text has a frontmatter, and whether this reader vouches for it. */
  frontmatter: { state: 'absent' } | ReadFrontmatter | { state: 'unreadable'; refusal: MermaidConfigRefusal }
  /**
   * What the `%%{init: …}%%` lines set, merged as mermaid merges them.
   * `unreadable` is a directive mermaid applies in a way this reader does not
   * reproduce — its keys are then unknown rather than absent.
   */
  directive:
    | { state: 'absent' }
    | { state: 'read'; config: Record<string, unknown>; line: number }
    | { state: 'unreadable'; line: number; reason: string }
  lines: readonly Line[]
}

const NEWLINE = String.fromCharCode(10)
const RETURN = String.fromCharCode(13)

/** Split into lines, each keeping its own terminator, so a join is the input. */
function splitLines(text: string): Line[] {
  const lines: Line[] = []
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    if (char !== NEWLINE && char !== RETURN) {
      continue
    }
    const eol = char === RETURN && text[index + 1] === NEWLINE ? RETURN + NEWLINE : char
    lines.push({ text: text.slice(start, index), eol })
    index += eol.length - 1
    start = index + 1
  }
  if (start < text.length) {
    lines.push({ text: text.slice(start), eol: '' })
  }
  return lines
}

const joinLines = (lines: readonly Line[]): string => lines.map((line) => line.text + line.eol).join('')

const isBlank = (text: string): boolean => text.trim() === ''
const isFence = (text: string): boolean => /^---\s*$/.test(text)

/** The top-level keys mermaid reads from a frontmatter; it ignores any other. */
const FRONTMATTER_TOP_LEVEL_KEYS: readonly string[] = ['title', 'displayMode', 'config']

/** A key this reader follows, and the only kind it writes. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

const dotted = (path: MermaidConfigPath): string => path.join('.')

const refusal = (
  code: MermaidConfigRefusalCode,
  message: string,
  where: { line?: number; key?: string } = {},
): MermaidConfigRefusal => ({ code, message, ...where })

/**
 * The sentence every "I will not rewrite this frontmatter" refusal ends with.
 * It says what was done (nothing) and what the person can do, so the reason in
 * front of it only has to name the thing.
 */
const LEFT_ALONE =
  'Options are only written into a frontmatter that can be kept exactly as it is, so nothing was changed.'

/**
 * What is wrong with a frontmatter this reader refuses, WITHOUT the "so nothing
 * was changed" every such refusal ends with. That ending is true of an attempt;
 * a panel that merely notices the frontmatter, before anything is tried, needs
 * the first half only.
 */
export function describeUnreadableFrontmatter(unreadable: MermaidConfigRefusal): string {
  return unreadable.message.endsWith(LEFT_ALONE)
    ? unreadable.message.slice(0, -LEFT_ALONE.length).trim()
    : unreadable.message
}

const onLine = (index: number): string => `line ${index + 1}`

// --- scalars ----------------------------------------------------------------

/** A number written the way JSON writes one — the only spelling read as a number. */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/
/**
 * Every OTHER spelling mermaid's YAML reader (js-yaml's JSON schema, as bundled
 * in mermaid 11.17.2) turns into a number: a leading `+`, a leading zero, the
 * `0b`/`0o`/`0x` forms, `.5`, `5.`, `.inf`, `.nan`. Read as "not sure" rather
 * than reimplemented: nobody writes a font size in octal.
 */
const YAML_ONLY_NUMBER =
  /^(?:[-+]?(?:0b[01]+|0x[0-9a-fA-F]+|0o[0-7]+|[0-9]+)|[-+]?[0-9]+(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/
/** Spellings of true, false and null that YAML accepts and this reader does not vouch for. */
const YAML_ONLY_KEYWORD = /^(?:True|TRUE|False|FALSE|Null|NULL)$/

type ScalarReading =
  { ok: true; value: MermaidConfigScalar | null } | { ok: false; code: MermaidConfigRefusalCode; what: string }

const unreadable = (code: MermaidConfigRefusalCode, what: string): ScalarReading => ({ ok: false, code, what })

/** One value, as written after a key's colon, already trimmed. Never empty. */
function readScalar(raw: string): ScalarReading {
  const first = raw[0]
  if (first === '#') {
    return unreadable('yaml-comment', 'a YAML comment')
  }
  if (first === '&') {
    return unreadable('yaml-anchor', 'a YAML anchor')
  }
  if (first === '*') {
    return unreadable('yaml-alias', 'a YAML alias')
  }
  if (first === '!') {
    return unreadable('yaml-tag', 'a YAML tag')
  }
  if (first === '|' || first === '>') {
    return unreadable('yaml-multi-line-scalar', 'a value that runs over several lines')
  }
  if (first === '{' || first === '[') {
    return unreadable('yaml-flow-collection', 'a value written inline in braces or brackets')
  }
  if (first === '"') {
    const whole = /^"(?:[^"\\]|\\.)*"/.exec(raw)
    if (whole === null) {
      return unreadable('yaml-multi-line-scalar', 'a quoted value that does not end on its own line')
    }
    return readQuoted(raw, whole[0], () => JSON.parse(whole[0]) as unknown)
  }
  if (first === "'") {
    const whole = /^'(?:[^']|'')*'/.exec(raw)
    if (whole === null) {
      return unreadable('yaml-multi-line-scalar', 'a quoted value that does not end on its own line')
    }
    return readQuoted(raw, whole[0], () => whole[0].slice(1, -1).split("''").join("'"))
  }
  if ('%@`,]}'.includes(first) || /^[-?:](?:\s|$)/.test(raw)) {
    return unreadable('yaml-unreadable-value', 'a value this panel does not read')
  }
  if (/\s#/.test(raw)) {
    return unreadable('yaml-comment', 'a YAML comment')
  }
  if (/:(?:\s|$)/.test(raw)) {
    return unreadable('yaml-unreadable-value', 'a value with a colon in it that is not quoted')
  }
  if (raw === 'true' || raw === 'false') {
    return { ok: true, value: raw === 'true' }
  }
  if (raw === 'null' || raw === '~') {
    return { ok: true, value: null }
  }
  if (JSON_NUMBER.test(raw)) {
    return { ok: true, value: Number(raw) }
  }
  if (YAML_ONLY_NUMBER.test(raw) || YAML_ONLY_KEYWORD.test(raw)) {
    return unreadable('yaml-unreadable-value', `a value (${raw}) written in a form this panel does not read`)
  }
  return { ok: true, value: raw }
}

function readQuoted(raw: string, quoted: string, parse: () => unknown): ScalarReading {
  const after = raw.slice(quoted.length)
  if (/^\s+#/.test(after)) {
    return unreadable('yaml-comment', 'a YAML comment')
  }
  if (after.trim() !== '') {
    return unreadable('yaml-unreadable-value', 'a quoted value with something after it')
  }
  try {
    const value = parse()
    return typeof value === 'string'
      ? { ok: true, value }
      : unreadable('yaml-unreadable-value', 'a value this panel does not read')
  } catch {
    // YAML allows escapes JSON does not (`\x41`, `\e`), and a raw tab.
    return unreadable('yaml-unreadable-value', 'a quoted value with an escape this panel does not read')
  }
}

/** A line break, a tab, or any other control character: nothing a one-line value may carry. */
function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) {
      return true
    }
  }
  return false
}

/** Words a plain YAML scalar must not be, in any letter case, to stay a string everywhere. */
const RESERVED_PLAIN_WORDS: readonly string[] = ['true', 'false', 'null', 'yes', 'no', 'on', 'off', 'y', 'n']

/**
 * One value, as this file writes it. A simple word is written bare, as
 * mermaid's own documentation writes `theme: forest`; anything else is a JSON
 * string, which is also a YAML one and cannot be misread as a number, a
 * boolean or a comment.
 */
export function emitMermaidConfigScalar(value: MermaidConfigScalar): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (/^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !RESERVED_PLAIN_WORDS.includes(value.toLowerCase())) {
    return value
  }
  return JSON.stringify(value)
}

// --- the frontmatter ---------------------------------------------------------

type LineReading =
  | { kind: 'blank' }
  | { kind: 'entry'; entry: FrontmatterEntry }
  | { kind: 'refused'; code: MermaidConfigRefusalCode; what: string }

/** One line between the fences. */
function readFrontmatterLine(text: string, line: number): LineReading {
  if (/^[ \t]*$/.test(text)) {
    return { kind: 'blank' }
  }
  const indentation = /^[ \t]*/.exec(text)?.[0] ?? ''
  if (indentation.includes(String.fromCharCode(9))) {
    return { kind: 'refused', code: 'yaml-tab-indentation', what: 'a line indented with a tab' }
  }
  const rest = text.slice(indentation.length)
  const first = rest[0]
  if (first === '#') {
    return { kind: 'refused', code: 'yaml-comment', what: 'a YAML comment' }
  }
  if (/^-(?:\s|$)/.test(rest)) {
    return { kind: 'refused', code: 'yaml-sequence', what: 'a YAML list' }
  }
  if (/^\?(?:\s|$)/.test(rest)) {
    return { kind: 'refused', code: 'yaml-complex-key', what: 'a YAML complex key' }
  }
  if (/^(?:\.\.\.|---)(?:\s|$)/.test(rest)) {
    return { kind: 'refused', code: 'yaml-document-marker', what: 'a second YAML document' }
  }
  if (first === '"' || first === "'") {
    return { kind: 'refused', code: 'yaml-quoted-key', what: 'a key written in quotes' }
  }
  if (first === '{' || first === '[') {
    return { kind: 'refused', code: 'yaml-flow-collection', what: 'a value written inline in braces or brackets' }
  }
  if (first === '&') {
    return { kind: 'refused', code: 'yaml-anchor', what: 'a YAML anchor' }
  }
  if (first === '*') {
    return { kind: 'refused', code: 'yaml-alias', what: 'a YAML alias' }
  }
  if (first === '!') {
    return { kind: 'refused', code: 'yaml-tag', what: 'a YAML tag' }
  }
  const keyed = /^([^\s:]+)([ \t]*):(?:([ \t]+)(.*))?$/.exec(rest)
  if (keyed === null) {
    return { kind: 'refused', code: 'yaml-unreadable-line', what: 'a line that is not "key: value"' }
  }
  const key = keyed[1]
  if (!PLAIN_KEY.test(key)) {
    return { kind: 'refused', code: 'yaml-unreadable-line', what: `a key (${key}) this panel does not read` }
  }
  const value = (keyed[4] ?? '').trim()
  const valueStart = indentation.length + key.length + keyed[2].length + 1 + (keyed[3] ?? '').length
  if (value === '') {
    return {
      kind: 'entry',
      entry: { key, line, indent: indentation.length, scalar: undefined, valueStart, children: [] },
    }
  }
  const scalar = readScalar(value)
  if (!scalar.ok) {
    return { kind: 'refused', code: scalar.code, what: scalar.what }
  }
  return {
    kind: 'entry',
    entry: { key, line, indent: indentation.length, scalar: scalar.value, valueStart, children: [] },
  }
}

function readFrontmatter(lines: readonly Line[]): MermaidSourceConfigReading['frontmatter'] {
  const open = lines.findIndex((line) => !isBlank(line.text))
  if (open === -1 || lines[open].text.trim() !== '---') {
    return { state: 'absent' }
  }
  const refuse = (code: MermaidConfigRefusalCode, what: string, line: number) =>
    ({
      state: 'unreadable',
      refusal: refusal(code, `The diagram’s frontmatter has ${what} on ${onLine(line)}. ${LEFT_ALONE}`, {
        line: line + 1,
      }),
    }) as const
  if (lines[open].text !== lines[open].text.trimStart()) {
    return refuse('frontmatter-fence-indented', 'an indented opening "---"', open)
  }
  let close = -1
  for (let index = open + 1; index < lines.length; index++) {
    if (isFence(lines[index].text)) {
      close = index
      break
    }
  }
  if (close === -1) {
    return {
      state: 'unreadable',
      refusal: refusal(
        'frontmatter-not-closed',
        `The diagram’s frontmatter opens with "---" on ${onLine(open)} and is never closed. ${LEFT_ALONE}`,
        { line: open + 1 },
      ),
    }
  }
  if (close === open + 1) {
    // Mermaid's pattern needs a line break on each side of the body, so two
    // fences in a row are not a frontmatter to it — and the text is then a
    // diagram that starts with `---`, which is nothing this file should extend.
    return {
      state: 'unreadable',
      refusal: refusal(
        'frontmatter-empty',
        `The diagram starts with two "---" lines and nothing between them, which mermaid does not read as a frontmatter. ${LEFT_ALONE}`,
        { line: open + 1 },
      ),
    }
  }
  if (!lines.slice(close + 1).some((line) => !isBlank(line.text))) {
    return {
      state: 'unreadable',
      refusal: refusal(
        'frontmatter-without-diagram',
        `There is a frontmatter here and no diagram after it, so mermaid does not read it as one. ${LEFT_ALONE}`,
        { line: close + 1 },
      ),
    }
  }

  const entries: FrontmatterEntry[] = []
  const stack: FrontmatterEntry[] = []
  for (let index = open + 1; index < close; index++) {
    const text = lines[index].text
    const previous = stack[stack.length - 1]
    const spaces = text.length - text.trimStart().length
    if (previous !== undefined && previous.scalar !== undefined && !isBlank(text) && spaces > previous.indent) {
      // More-indented text under a key that already has a value is YAML's way
      // of continuing that value on the next line — whatever the text looks
      // like, `key: value` included.
      return refuse('yaml-multi-line-scalar', 'a value that runs over several lines', previous.line)
    }
    const reading = readFrontmatterLine(text, index)
    if (reading.kind === 'blank') {
      continue
    }
    if (reading.kind === 'refused') {
      return refuse(reading.code, reading.what, index)
    }
    const entry = reading.entry
    while (stack.length > 0 && stack[stack.length - 1].indent >= entry.indent) {
      stack.pop()
    }
    const parent = stack[stack.length - 1]
    const siblings = parent === undefined ? entries : parent.children
    if (siblings.length > 0 && siblings[0].indent !== entry.indent) {
      return refuse('yaml-indentation', 'indentation this panel cannot follow', index)
    }
    if (siblings.some((sibling) => sibling.key === entry.key)) {
      return refuse('yaml-duplicate-key', `the key "${entry.key}" twice`, index)
    }
    siblings.push(entry)
    stack.push(entry)
  }

  for (const entry of entries) {
    if (!FRONTMATTER_TOP_LEVEL_KEYS.includes(entry.key)) {
      return {
        state: 'unreadable',
        refusal: refusal(
          'unknown-top-level-key',
          `The diagram’s frontmatter has a top-level key "${entry.key}" on ${onLine(entry.line)} that mermaid does not define. ${LEFT_ALONE}`,
          { line: entry.line + 1, key: entry.key },
        ),
      }
    }
    if (entry.key === 'config' && entry.scalar !== undefined) {
      return {
        state: 'unreadable',
        refusal: refusal(
          'config-is-not-a-mapping',
          `The diagram’s frontmatter gives "config" a single value on ${onLine(entry.line)} instead of a list of options. ${LEFT_ALONE}`,
          { line: entry.line + 1, key: 'config' },
        ),
      }
    }
    if (entry.key !== 'config' && entry.children.length > 0) {
      return refuse('yaml-unreadable-value', `"${entry.key}" holding other keys`, entry.line)
    }
  }
  return { state: 'read', open, close, entries }
}

// --- init directives ---------------------------------------------------------

/**
 * Mermaid's own two patterns, copied from 11.17.2 (`diagram-api/regexes.ts` and
 * `utils.ts`) rather than paraphrased: what counts as a directive is whatever
 * mermaid says it is, including the odd corners. The contract script compares
 * this reader with the library over a corpus, so a copy that has drifted fails
 * there.
 */
const DIRECTIVE_SOURCE = '%{2}{\\s*(?:(\\w+)\\s*:|(\\w+))\\s*(?:(\\w+)|((?:(?!}%{2}).|\\r?\\n)*))?\\s*(?:}%{2})?'
const DIRECTIVE_WITHOUT_OPEN_SOURCE =
  '\\s*(?:(\\w+)(?=:):|(\\w+))\\s*(?:(\\w+)|((?:(?!}%{2}).|\\r?\\n)*))?\\s*(?:}%{2})?'
const INIT_DIRECTIVE_TYPE = /(?:init\b)|(?:initialize\b)/

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Later directives win, key by key, as mermaid's `assignWithDepth` merges them. */
function mergeDeep(into: Record<string, unknown>, from: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(from)) {
    const existing = into[key]
    into[key] = isPlainObject(value) && isPlainObject(existing) ? mergeDeep({ ...existing }, value) : value
  }
  return into
}

function readDirectives(lines: readonly Line[], bodyStart: number): MermaidSourceConfigReading['directive'] {
  // Mermaid reads the text with every line ending as a line feed.
  const body = lines
    .slice(bodyStart)
    .map((line) => line.text)
    .join(NEWLINE)
  if (!body.includes('%%{')) {
    return { state: 'absent' }
  }
  const offsetLine = (offset: number): number => bodyStart + body.slice(0, offset).split(NEWLINE).length
  const leading = body.length - body.trimStart().length
  const commentWithoutDirectives = new RegExp(
    `[%]{2}(?![{]${DIRECTIVE_WITHOUT_OPEN_SOURCE})(?=[}][%]{2}).*${NEWLINE}`,
    'ig',
  )
  const trimmed = body.trim()
  const prepared = trimmed.replace(commentWithoutDirectives, '').replace(/'/gm, '"')
  // Stripping a comment moves every offset after it, and then a line number
  // would be a guess. The form it strips (`%%}%%…`) is not one anybody writes.
  const offsetsHold = prepared.length === trimmed.length
  const pattern = new RegExp(DIRECTIVE_SOURCE, 'gi')
  const found: { args: unknown; line: number }[] = []
  let match: RegExpExecArray | null
  while ((match = pattern.exec(prepared)) !== null) {
    if (match.index === pattern.lastIndex) {
      pattern.lastIndex++
    }
    const type = match[1] ?? match[2]
    if (type === undefined || !INIT_DIRECTIVE_TYPE.test(type)) {
      continue
    }
    const line = offsetsHold ? offsetLine(leading + match.index) : bodyStart + 1
    let args: unknown = null
    if (match[3]) {
      args = match[3].trim()
    } else if (match[4]) {
      try {
        args = JSON.parse(match[4].trim())
      } catch {
        // Mermaid catches this, logs it, and then applies NO init directive at
        // all — not even a well-formed one elsewhere in the text.
        return { state: 'absent' }
      }
    }
    found.push({ args, line })
  }
  if (found.length === 0) {
    return { state: 'absent' }
  }
  const line = found[0].line
  const config: Record<string, unknown> = {}
  for (const directive of found) {
    if (directive.args === null && found.length > 1) {
      continue
    }
    if (!isPlainObject(directive.args)) {
      return found.length === 1 && directive.args === null
        ? { state: 'absent' }
        : { state: 'unreadable', line, reason: 'an init directive that is not a list of options' }
    }
    if ('config' in directive.args) {
      // Mermaid renames this key to the diagram's own type, which only its
      // detectors can name.
      return { state: 'unreadable', line, reason: 'an init directive with a "config" key' }
    }
    mergeDeep(config, directive.args)
  }
  return { state: 'read', config, line }
}

// --- reading -----------------------------------------------------------------

/** Read a diagram's text once; ask it about keys with `readMermaidConfigValue`. */
export function readMermaidSourceConfig(text: string): MermaidSourceConfigReading {
  const lines = splitLines(typeof text === 'string' ? text : '')
  const frontmatter = readFrontmatter(lines)
  // An unreadable frontmatter has no known end. The directive scan then covers
  // the whole text, which can only find MORE than mermaid would.
  const bodyStart = frontmatter.state === 'read' ? frontmatter.close + 1 : 0
  return { frontmatter, directive: readDirectives(lines, bodyStart), lines }
}

function findEntry(entries: readonly FrontmatterEntry[], path: MermaidConfigPath): FrontmatterEntry | undefined {
  let level = entries
  let entry: FrontmatterEntry | undefined
  for (const key of path) {
    entry = level.find((candidate) => candidate.key === key)
    if (entry === undefined) {
      return undefined
    }
    level = entry.children
  }
  return entry
}

/**
 * Does an init directive decide this key? Mermaid lays the directive over the
 * frontmatter key by key, so it decides a key exactly when it names it — or
 * when it puts a single value where one of the key's parents should be, which
 * replaces everything under that parent.
 */
function directiveValue(
  directive: MermaidSourceConfigReading['directive'],
  path: MermaidConfigPath,
): { touched: false } | { touched: true; value: unknown; line: number } {
  if (directive.state !== 'read') {
    return { touched: false }
  }
  let value: unknown = directive.config
  for (const key of path) {
    if (!isPlainObject(value)) {
      return { touched: true, value: undefined, line: directive.line }
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      return { touched: false }
    }
    value = value[key]
  }
  return { touched: true, value, line: directive.line }
}

/**
 * Mermaid's own filter on a theme variable a text supplies (`sanitizeDirective`,
 * 11.17.2): a value with any character outside this set is replaced by an empty
 * string before it is used. So `fontSize: "calc(1px + 2px)"` is in the text and
 * sets nothing, and reporting it as the diagram's font size would be wrong.
 *
 * THE ONE COPY of that set in this app. The reader uses it to say "mermaid
 * discards this" instead of reporting a value that sets nothing; the writer
 * uses it to refuse to write one; and `scripts/MermaidConfigContract.mjs` holds
 * it to the installed library character by character, because an upgrade can
 * move it.
 */
const THEME_VARIABLE_MERMAID_KEEPS = /^[\d "#%(),.;A-Za-z]+$/

/**
 * Would mermaid keep this value for this key, as written? Two of its own
 * filters say no, and only ever to a string: a theme variable with a character
 * outside the set above is blanked, and ANY option whose value contains an
 * angle bracket or a `url(data:` is deleted outright (`sanitize`, config.ts).
 */
export function mermaidKeepsConfigValue(path: MermaidConfigPath, value: MermaidConfigScalar): boolean {
  if (typeof value !== 'string') {
    return true
  }
  if (value.includes('<') || value.includes('>') || value.includes('url(data:')) {
    return false
  }
  return path[0] !== 'themeVariables' || THEME_VARIABLE_MERMAID_KEEPS.test(value)
}

function asMermaidKeepsIt(
  path: MermaidConfigPath,
  reading: Extract<MermaidConfigValueReading, { state: 'set' }>,
): MermaidConfigValueReading {
  if (!mermaidKeepsConfigValue(path, reading.value)) {
    return {
      state: 'unknown',
      reason: `Line ${reading.line} gives "${dotted(path)}" a value mermaid discards.`,
    }
  }
  return reading
}

/**
 * What the text sets one `config` key to, as mermaid will apply it: a directive
 * over the frontmatter. `unknown` whenever either could be setting it in a way
 * this reader does not vouch for.
 */
export function readMermaidConfigValue(
  reading: MermaidSourceConfigReading,
  path: MermaidConfigPath,
): MermaidConfigValueReading {
  const { directive, frontmatter } = reading
  if (directive.state === 'unreadable') {
    return { state: 'unknown', reason: `Line ${directive.line} is ${directive.reason}.` }
  }
  const fromDirective = directiveValue(directive, path)
  if (fromDirective.touched) {
    const value = fromDirective.value
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return asMermaidKeepsIt(path, { state: 'set', value, from: 'directive', line: fromDirective.line })
    }
    // A directive's `null` replaces what the frontmatter says, and mermaid then
    // drops the key: the option is unset whatever the frontmatter holds.
    return value === null
      ? { state: 'unset' }
      : {
          state: 'unknown',
          reason: `Line ${fromDirective.line} is an init directive that sets "${dotted(path)}" to something other than a single value.`,
        }
  }
  if (frontmatter.state === 'absent') {
    return { state: 'unset' }
  }
  if (frontmatter.state === 'unreadable') {
    return { state: 'unknown', reason: frontmatter.refusal.message }
  }
  const entry = findEntry(frontmatter.entries, ['config', ...path])
  if (entry === undefined || (entry.scalar ?? null) === null) {
    // Mermaid drops a key whose value is null.
    return entry !== undefined && entry.children.length > 0
      ? { state: 'unknown', reason: `"${dotted(path)}" holds other keys on line ${entry.line + 1}.` }
      : { state: 'unset' }
  }
  return asMermaidKeepsIt(path, {
    state: 'set',
    value: entry.scalar as MermaidConfigScalar,
    from: 'frontmatter',
    line: entry.line + 1,
  })
}

/**
 * Every `config` key the frontmatter sets to a value, dotted, in the order
 * written. Empty for a text with no frontmatter or one this reader refuses.
 */
export function listMermaidFrontmatterConfig(
  reading: MermaidSourceConfigReading,
): { key: string; value: MermaidConfigScalar; line: number }[] {
  if (reading.frontmatter.state !== 'read') {
    return []
  }
  const listed: { key: string; value: MermaidConfigScalar; line: number }[] = []
  const walk = (entries: readonly FrontmatterEntry[], prefix: string) => {
    for (const entry of entries) {
      const key = prefix === '' ? entry.key : `${prefix}.${entry.key}`
      if (entry.scalar !== undefined && entry.scalar !== null) {
        listed.push({ key, value: entry.scalar, line: entry.line + 1 })
      }
      walk(entry.children, key)
    }
  }
  walk(findEntry(reading.frontmatter.entries, ['config'])?.children ?? [], '')
  return listed
}

// --- writing -----------------------------------------------------------------

export type MermaidConfigPatchResult = { ok: true; text: string } | { ok: false; refusal: MermaidConfigRefusal }

/** The last line that belongs to an entry: its own, or its last descendant's. */
function lastLineOf(entry: FrontmatterEntry): number {
  return entry.children.length === 0 ? entry.line : lastLineOf(entry.children[entry.children.length - 1])
}

/** How far one level is indented in this frontmatter; two spaces when it has no nesting yet. */
function indentStep(entries: readonly FrontmatterEntry[]): number {
  for (const entry of entries) {
    if (entry.children.length > 0) {
      return entry.children[0].indent - entry.indent
    }
  }
  return 2
}

function applyChange(lines: Line[], change: MermaidConfigChange, eol: string): MermaidConfigRefusal | null {
  const key = dotted(change.path)
  const frontmatter = readFrontmatter(lines)
  if (frontmatter.state === 'unreadable') {
    return frontmatter.refusal
  }
  if (change.value === undefined) {
    return frontmatter.state === 'absent' ? null : removeKey(lines, frontmatter, change.path)
  }

  let block = frontmatter
  if (block.state === 'absent') {
    // A new block goes in front of everything, leading blank lines included,
    // so taking it away again leaves the text as it was to the byte.
    lines.unshift({ text: '---', eol }, { text: '---', eol })
    block = { state: 'read', open: 0, close: 1, entries: [] }
  }
  const step = indentStep(block.entries)
  const inserted = (at: number, text: string) => {
    lines.splice(at, 0, { text, eol })
  }

  let siblings = block.entries
  let parent: FrontmatterEntry | undefined
  let insertAt = block.entries.length === 0 ? block.open + 1 : lastLineOf(block.entries[block.entries.length - 1]) + 1
  let indent = block.entries.length === 0 ? 0 : block.entries[0].indent
  const fullPath = ['config', ...change.path]
  for (let depth = 0; depth < fullPath.length; depth++) {
    const name = fullPath[depth]
    const isLeaf = depth === fullPath.length - 1
    const existing = siblings.find((candidate) => candidate.key === name)
    if (existing === undefined) {
      // Nothing below here exists yet: write the rest of the path as new lines.
      for (let rest = depth; rest < fullPath.length; rest++) {
        const last = rest === fullPath.length - 1
        const text =
          ' '.repeat(indent) + fullPath[rest] + ':' + (last ? ' ' + emitMermaidConfigScalar(change.value) : '')
        inserted(insertAt, text)
        insertAt++
        indent += step
      }
      return null
    }
    if (isLeaf) {
      if (existing.children.length > 0) {
        return refusal(
          'key-holds-a-mapping',
          `"${key}" holds other options on ${onLine(existing.line)} of the diagram’s frontmatter, so it cannot be given a single value here. Nothing was changed.`,
          { line: existing.line + 1, key },
        )
      }
      const line = lines[existing.line]
      const head = existing.scalar === undefined ? line.text.trimEnd() + ' ' : line.text.slice(0, existing.valueStart)
      lines[existing.line] = { text: head + emitMermaidConfigScalar(change.value), eol: line.eol }
      return null
    }
    if (existing.scalar !== undefined && existing.scalar !== null) {
      return refusal(
        'key-holds-a-value',
        `"${fullPath.slice(1, depth + 1).join('.')}" is given a single value on ${onLine(existing.line)} of the diagram’s frontmatter, so "${key}" cannot be written under it. Nothing was changed.`,
        { line: existing.line + 1, key },
      )
    }
    parent = existing
    siblings = parent.children
    insertAt = lastLineOf(parent) + 1
    indent = siblings.length > 0 ? siblings[0].indent : parent.indent + step
  }
  return null
}

function removeKey(lines: Line[], block: ReadFrontmatter, path: MermaidConfigPath): MermaidConfigRefusal | null {
  const chain: FrontmatterEntry[] = []
  let siblings = block.entries
  for (const name of ['config', ...path]) {
    const entry = siblings.find((candidate) => candidate.key === name)
    if (entry === undefined) {
      return null
    }
    chain.push(entry)
    siblings = entry.children
  }
  const leaf = chain[chain.length - 1]
  if (leaf.children.length > 0) {
    return refusal(
      'key-holds-a-mapping',
      `"${dotted(path)}" holds other options on ${onLine(leaf.line)} of the diagram’s frontmatter, so it was not removed. Nothing was changed.`,
      { line: leaf.line + 1, key: dotted(path) },
    )
  }
  // The key's own line, then each parent that held nothing else — `config:`
  // itself included, which is what takes the block away when it was only ours.
  const doomed = [leaf.line]
  for (let depth = chain.length - 2; depth >= 0 && chain[depth].children.length === 1; depth--) {
    doomed.push(chain[depth].line)
  }
  const emptied =
    doomed.length === chain.length && block.entries.length === 1 && block.close - block.open - 1 === doomed.length
  if (emptied) {
    // Nothing is left between the fences, not even a blank line, so the fences
    // go too. (With a blank line left it is still a frontmatter to mermaid, and
    // it stays: it was there before this file wrote anything.)
    lines.splice(block.open, block.close - block.open + 1)
    return null
  }
  for (const index of doomed.sort((a, b) => b - a)) {
    lines.splice(index, 1)
  }
  return null
}

/**
 * The refusal for a key an init directive decides, or `null` when none does.
 * Exported because a control that takes an option AWAY asks the same question:
 * removing `theme` from the frontmatter is always possible, and does nothing
 * visible while a directive still names one.
 */
export function mermaidDirectiveRefusal(
  reading: MermaidSourceConfigReading,
  path: MermaidConfigPath,
): MermaidConfigRefusal | null {
  const key = dotted(path)
  if (reading.directive.state === 'unreadable') {
    return refusal(
      'directive-sets-key',
      `Line ${reading.directive.line} is ${reading.directive.reason}, which may set "${key}" itself, and a directive wins over the frontmatter. Nothing was changed; edit that line instead.`,
      { line: reading.directive.line, key },
    )
  }
  const fromDirective = directiveValue(reading.directive, path)
  if (!fromDirective.touched) {
    return null
  }
  const line = fromDirective.line
  return refusal(
    'directive-sets-key',
    `Line ${line} is an init directive that sets "${key}" itself, and a directive wins over the frontmatter. Nothing was changed; edit or remove "${key}" on that line to choose it here.`,
    { line, key },
  )
}

/**
 * Apply changes to the diagram's frontmatter `config:` and return the new text
 * — or refuse, with the reason, and return none. All of the changes or none of
 * them: a refusal on the third leaves the first two unwritten.
 *
 * A change that names a key an init directive already sets is refused, because
 * the directive wins and the control would appear to do nothing. Removing a key
 * is never refused on that ground: removal only promises that the FRONTMATTER
 * no longer sets it.
 */
export function patchMermaidSourceConfig(
  text: string,
  changes: readonly MermaidConfigChange[],
): MermaidConfigPatchResult {
  for (const change of changes) {
    const valid =
      change.path.length > 0 &&
      change.path.every((key) => PLAIN_KEY.test(key)) &&
      (typeof change.value !== 'number' || Number.isFinite(change.value)) &&
      (typeof change.value !== 'string' || !hasControlCharacter(change.value))
    if (!valid) {
      return {
        ok: false,
        refusal: refusal('invalid-change', `"${dotted(change.path)}" is not an option this panel can write.`, {
          key: dotted(change.path),
        }),
      }
    }
    if (change.value !== undefined && !mermaidKeepsConfigValue(change.path, change.value)) {
      // Written, it would sit in the diagram's text looking like a setting and
      // do nothing: mermaid throws it away before use.
      return {
        ok: false,
        refusal: refusal(
          'value-mermaid-discards',
          `Mermaid discards the value ${JSON.stringify(change.value)} for "${dotted(
            change.path,
          )}", so it would be written and then ignored. Nothing was changed.`,
          { key: dotted(change.path) },
        ),
      }
    }
  }
  if (changes.length === 0) {
    return { ok: true, text }
  }
  if (text.trim() === '') {
    return {
      ok: false,
      refusal: refusal('empty-diagram', 'There is no diagram here yet, so there is nothing to give options to.'),
    }
  }
  const reading = readMermaidSourceConfig(text)
  if (reading.frontmatter.state === 'unreadable') {
    return { ok: false, refusal: reading.frontmatter.refusal }
  }
  for (const change of changes) {
    const refused = change.value === undefined ? null : mermaidDirectiveRefusal(reading, change.path)
    if (refused !== null) {
      return { ok: false, refusal: refused }
    }
  }

  const lines = splitLines(text)
  const eol = lines.find((line) => line.eol !== '')?.eol ?? NEWLINE
  for (const change of changes) {
    const refused = applyChange(lines, change, eol)
    if (refused !== null) {
      return { ok: false, refusal: refused }
    }
  }
  return { ok: true, text: joinLines(lines) }
}
