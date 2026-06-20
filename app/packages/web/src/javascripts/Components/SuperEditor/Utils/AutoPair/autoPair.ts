/**
 * Auto-pairing of brackets and quotes — pure, editor-agnostic decision logic.
 *
 * Given the character the user just typed, the current single-line slice of text
 * around the caret, and the current selection, this module decides what should
 * happen:
 *
 *   - InsertPair    : an opener was typed with a collapsed caret -> insert the
 *                     opener + its closer and place the caret between them.
 *   - WrapSelection : an opener was typed while text was selected -> wrap the
 *                     selection in opener…closer, keeping the inner text selected.
 *   - TypeOver      : a closer was typed and the very next character is that same
 *                     closer -> just move the caret past it (don't duplicate).
 *   - DeletePair    : Backspace was pressed with a collapsed caret sitting exactly
 *                     between an empty matching pair -> delete both characters.
 *   - None          : do nothing special; let the editor handle the key normally.
 *
 * The functions here operate purely on a string + selection offsets so they can
 * be unit-tested in isolation and reused by both the Lexical (Super) editor and
 * the plain <textarea> editor. The Lexical plugin passes the text content and
 * offsets of the current paragraph/line; the textarea passes the relevant slice
 * of its value. Offsets are relative to whatever string `text` is.
 */

/** Map of opening bracket -> its matching closing bracket. */
export const BRACKET_PAIRS: Readonly<Record<string, string>> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '<': '>',
}

/**
 * Characters that are their own closer (symmetric). Typing `"` inserts `"` after
 * the caret. The backtick is included for code spans.
 */
export const QUOTE_CHARS: ReadonlyArray<string> = ['"', "'", '`']

/**
 * The set of openers we react to. `<` is intentionally OMITTED from the auto-pair
 * openers by default: in prose `a < b` and typing `<` for "less than" is common,
 * and HTML/JSX angle-bracket pairing is more annoying than helpful in a notes
 * app. It still lives in BRACKET_PAIRS (so callers can opt in) but is not part of
 * the default opener set or the closer-typeover set.
 */
const DEFAULT_OPENERS: ReadonlyArray<string> = ['(', '[', '{', ...QUOTE_CHARS]

/** Closers we will "type over". Mirrors DEFAULT_OPENERS (brackets + quotes). */
const DEFAULT_CLOSERS: ReadonlyArray<string> = [')', ']', '}', ...QUOTE_CHARS]

export type AutoPairAction =
  | { type: 'none' }
  /** Insert `open` + `close`; caret goes between them. */
  | { type: 'insert-pair'; open: string; close: string }
  /** Wrap the current selection: `open` + selected text + `close`; keep inner selected. */
  | { type: 'wrap-selection'; open: string; close: string }
  /** A duplicate closer was typed; just advance the caret one char to the right. */
  | { type: 'type-over' }
  /** Backspace inside an empty pair; delete the char before and after the caret. */
  | { type: 'delete-pair' }

export type Selection = {
  /** Offset of the selection start within `text`. */
  start: number
  /** Offset of the selection end within `text`. `end === start` means collapsed. */
  end: number
}

export type AutoPairContext = {
  /** The full string the offsets are relative to (e.g. the current line / paragraph). */
  text: string
  selection: Selection
}

/** Is the given character a quote/backtick (symmetric pair)? */
export function isQuoteChar(char: string): boolean {
  return QUOTE_CHARS.includes(char)
}

/** Word-ish character test used to suppress apostrophe pairing inside words. */
function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char)
}

/**
 * Decide whether typing `char` should trigger auto-pairing, and how.
 *
 * `char` is the single character the user typed (the printable key). Backspace is
 * handled separately by {@link decideBackspace}.
 */
export function decideInsertion(char: string, ctx: AutoPairContext): AutoPairAction {
  const { text, selection } = ctx
  const hasSelection = selection.end > selection.start
  const isOpener = DEFAULT_OPENERS.includes(char)
  const isCloser = DEFAULT_CLOSERS.includes(char)
  const closerForOpener = BRACKET_PAIRS[char] ?? (isQuoteChar(char) ? char : undefined)

  // 1) Wrap a non-empty selection when an opener is typed.
  if (hasSelection) {
    if (isOpener && closerForOpener) {
      return { type: 'wrap-selection', open: char, close: closerForOpener }
    }
    return { type: 'none' }
  }

  const charBefore = selection.start > 0 ? text[selection.start - 1] : undefined
  const charAfter = selection.start < text.length ? text[selection.start] : undefined

  // 2) Type-over: a closer was typed and the next char is the same closer.
  // (Brackets only — for quotes the same char is both opener and closer, handled
  // below in the symmetric branch.)
  if (isCloser && !isQuoteChar(char) && charAfter === char) {
    return { type: 'type-over' }
  }

  // 3) Quote handling (symmetric, char is both opener and closer).
  if (isQuoteChar(char)) {
    // Type-over: caret sits right before an identical quote -> step past it.
    if (charAfter === char) {
      return { type: 'type-over' }
    }
    // Suppress apostrophe/quote pairing when typing immediately after a word
    // character (contractions like don't, it's) or directly before a word
    // character (no useful pair to open there). This avoids the most annoying
    // false-positives while keeping standalone quoting working.
    if (isWordChar(charBefore) || isWordChar(charAfter)) {
      return { type: 'none' }
    }
    return { type: 'insert-pair', open: char, close: char }
  }

  // 4) Bracket opener with collapsed caret -> insert pair.
  if (isOpener && closerForOpener) {
    return { type: 'insert-pair', open: char, close: closerForOpener }
  }

  return { type: 'none' }
}

/**
 * Decide whether Backspace with a collapsed caret should delete a surrounding
 * empty pair. Returns `delete-pair` only when the caret sits exactly between a
 * matching open/close (e.g. `(|)`, `[|]`, `"|"`).
 */
export function decideBackspace(ctx: AutoPairContext): AutoPairAction {
  const { text, selection } = ctx
  if (selection.end !== selection.start) {
    return { type: 'none' }
  }
  const charBefore = selection.start > 0 ? text[selection.start - 1] : undefined
  const charAfter = selection.start < text.length ? text[selection.start] : undefined
  if (charBefore === undefined || charAfter === undefined) {
    return { type: 'none' }
  }
  // Bracket pair: before is an opener whose closer equals after.
  if (BRACKET_PAIRS[charBefore] === charAfter) {
    return { type: 'delete-pair' }
  }
  // Quote pair: identical quote chars surrounding the caret.
  if (isQuoteChar(charBefore) && charBefore === charAfter) {
    return { type: 'delete-pair' }
  }
  return { type: 'none' }
}

/**
 * Apply an auto-pair action to a plain string + selection, returning the new
 * string and selection. Used directly by the textarea editor and by tests; the
 * Lexical plugin instead applies the action via selection APIs but mirrors this
 * behaviour exactly.
 *
 * For `type-over` and `delete-pair`, `typedChar` is ignored. For `insert-pair`
 * and `wrap-selection`, the action already carries the open/close characters.
 */
export function applyAction(action: AutoPairAction, ctx: AutoPairContext): AutoPairContext {
  const { text, selection } = ctx
  switch (action.type) {
    case 'insert-pair': {
      const before = text.slice(0, selection.start)
      const after = text.slice(selection.end)
      const newText = before + action.open + action.close + after
      const caret = selection.start + action.open.length
      return { text: newText, selection: { start: caret, end: caret } }
    }
    case 'wrap-selection': {
      const before = text.slice(0, selection.start)
      const inner = text.slice(selection.start, selection.end)
      const after = text.slice(selection.end)
      const newText = before + action.open + inner + action.close + after
      // Keep the inner text selected.
      const innerStart = selection.start + action.open.length
      const innerEnd = innerStart + inner.length
      return { text: newText, selection: { start: innerStart, end: innerEnd } }
    }
    case 'type-over': {
      const caret = selection.start + 1
      return { text, selection: { start: caret, end: caret } }
    }
    case 'delete-pair': {
      const before = text.slice(0, selection.start - 1)
      const after = text.slice(selection.start + 1)
      const newText = before + after
      const caret = selection.start - 1
      return { text: newText, selection: { start: caret, end: caret } }
    }
    case 'none':
    default:
      return ctx
  }
}
