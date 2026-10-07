/**
 * Standard Red Notes: normalise a markdown document's list indentation before it
 * is handed to `@lexical/markdown`.
 *
 * `@lexical/markdown` hard-codes `LIST_INDENT_SIZE = 4` and reads a row's level
 * as `floor(leadingSpaces / 4)` plus one level per leading TAB. Two-space
 * nesting is what most editors and generators emit, and under that rule it
 * HALF-FLATTENS: levels `0,1,2,3` arrive as `0,0,1,1`. Three-space nesting
 * collapses almost entirely. That constant lives in `node_modules`, so the fix
 * belongs on the way in: detect the document's OWN indent unit and restate every
 * list row's indentation in the units the transformer understands.
 *
 * What it does, and does not, touch:
 *
 *  - only lines the list transformers themselves recognise as rows (`-`/`*`/`+`,
 *    `1.`, and the `[x]`/`[ ]` task forms) have their LEADING WHITESPACE
 *    rewritten; nothing else on any line changes;
 *  - fenced code blocks are skipped wholesale, so a fenced markdown sample or a
 *    YAML block keeps its own indentation byte for byte;
 *  - a document whose unit is already four spaces, or that has no space-indented
 *    list row at all, is returned UNCHANGED — the same string — so input that
 *    already imported correctly takes no new behaviour. Tab-indented input is in
 *    that set: one tab is already one level to the transformer.
 *
 * The unit is the SMALLEST indentation any list row actually uses, which is what
 * the author's editor inserted per level, floored at two spaces because a
 * one-space indent is sloppiness rather than a nesting convention (CommonMark
 * reads it as a sibling, and so does this).
 *
 * A RAGGED row — one whose indentation is not a whole multiple of the unit — is
 * floored to the level below it: with a two-space unit, three spaces reads as
 * level 1. That is also how CommonMark resolves it, since a row indented past
 * its parent's marker but short of the next level is a child of that parent, not
 * of a level nobody opened. The minimum is deliberately used rather than the
 * greatest common divisor, which a single ragged row would collapse to 1 and
 * blow every level up with it.
 */

/**
 * The indent size `@lexical/markdown` assumes per nesting level. Mirrored rather
 * than imported: the constant is private to that package.
 */
export const MARKDOWN_LIST_INDENT_SIZE = 4

/**
 * The narrowest indent that counts as a deliberate nesting step. One space is
 * not a convention any editor emits.
 */
const MIN_DETECTED_INDENT_UNIT = 2

/**
 * The list openers, mirroring `ORDERED_LIST_REGEX`, `UNORDERED_LIST_REGEX` and
 * `CHECK_LIST_REGEX` in `@lexical/markdown`, so this rewrites exactly the lines
 * that package will read as list rows and no others.
 */
const LIST_ROW_PATTERNS: RegExp[] = [
  /^([ \t]*)\d+\.[ \t]/,
  /^([ \t]*)[-*+][ \t]/,
  /^([ \t]*)(?:[-*+][ \t])?[ \t]?\[(?:[ \t]|x)?\][ \t]/i,
]

/** ``` or ~~~ fence, open or close, at any indentation. */
const CODE_FENCE = /^[ \t]*(`{3,}|~{3,})/

type RowIndent = {
  /** Index into the line array. */
  line: number
  /** Leading spaces, with tabs counted separately. */
  spaces: number
  /** Leading tabs: `@lexical/markdown` already reads one tab as one level. */
  tabs: number
  /** Length of the leading-whitespace run this row's rewrite replaces. */
  width: number
}

const leadingWhitespaceOfListRow = (line: string): string | undefined => {
  for (const pattern of LIST_ROW_PATTERNS) {
    const match = pattern.exec(line)
    if (match) {
      return match[1]
    }
  }
  return undefined
}

/**
 * The leading whitespace of every list row outside a fenced code block.
 *
 * Fences are tracked by marker and length, so a ``` block cannot be closed by a
 * ~~~ one and a long fence cannot be closed by a shorter one.
 */
const collectListRowIndents = (lines: string[]): RowIndent[] => {
  const rows: RowIndent[] = []
  let fence: string | undefined
  for (let line = 0; line < lines.length; line += 1) {
    const text = lines[line]
    const fenceMatch = CODE_FENCE.exec(text)
    if (fenceMatch) {
      const marker = fenceMatch[1]
      if (fence === undefined) {
        fence = marker
      } else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = undefined
      }
      continue
    }
    if (fence !== undefined) {
      continue
    }
    const whitespace = leadingWhitespaceOfListRow(text)
    if (whitespace === undefined) {
      continue
    }
    let spaces = 0
    let tabs = 0
    for (const character of whitespace) {
      if (character === '\t') {
        tabs += 1
      } else {
        spaces += 1
      }
    }
    rows.push({ line, spaces, tabs, width: whitespace.length })
  }
  return rows
}

const indentUnitOf = (rows: RowIndent[]): number | undefined => {
  let smallest: number | undefined
  for (const row of rows) {
    if (row.spaces > 0 && (smallest === undefined || row.spaces < smallest)) {
      smallest = row.spaces
    }
  }
  return smallest === undefined ? undefined : Math.max(smallest, MIN_DETECTED_INDENT_UNIT)
}

/**
 * The document's own list-indent unit in spaces, or `undefined` when no list row
 * is space-indented at all (a flat list, or a tab-indented one, both of which
 * the transformer already reads correctly).
 */
export function detectMarkdownListIndentUnit(markdown: string): number | undefined {
  return indentUnitOf(collectListRowIndents(markdown.split('\n')))
}

/**
 * `markdown` with every list row's indentation restated in the four-space units
 * `@lexical/markdown` reads. Returns the input unchanged when there is nothing
 * to restate.
 */
export function normalizeMarkdownListIndentation(markdown: string): string {
  if (markdown.length === 0) {
    return markdown
  }
  const lines = markdown.split('\n')
  const rows = collectListRowIndents(lines)
  const unit = indentUnitOf(rows)
  if (unit === undefined || unit === MARKDOWN_LIST_INDENT_SIZE) {
    return markdown
  }
  for (const row of rows) {
    const level = row.tabs + Math.floor(row.spaces / unit)
    lines[row.line] = ' '.repeat(level * MARKDOWN_LIST_INDENT_SIZE) + lines[row.line].slice(row.width)
  }
  return lines.join('\n')
}
