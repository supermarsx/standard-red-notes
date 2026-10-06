/**
 * Which renderer a shared note needs.
 *
 * A share payload used to carry only `{ title, text }`, and the viewer ran
 * EVERY note through the plain-editor markdown renderer. For a Super note that
 * is not a degraded rendering, it is no rendering at all: `note.text` for a
 * Super note is the serialized Lexical editor state, so the reader was shown
 * `{"root":{"children":[{"children":[{"detail":0,"format":0,…` as paragraph
 * text. Measured in headless Chrome against a note holding headings, lists, a
 * checklist, a table, a code block, a quote, a divider, a collapsible section,
 * a callout, a formula, a mermaid diagram and a gantt chart: 7 320 characters
 * of JSON on screen, zero `<ul>`, zero `<table>`, zero `<svg>`.
 *
 * The format is therefore resolved before anything is rendered. `noteType` is
 * read when the payload carries one; a payload that does not (every link
 * created before the field existed) is SNIFFED, and the sniff only ever
 * promotes to `super`, which is the one format that can be recognised from its
 * own bytes with certainty.
 */

/** The renderers the shared viewer can dispatch to. */
export type SharedNoteFormat = 'super' | 'markdown' | 'plain' | 'html' | 'code'

/**
 * `NoteType` values (app/packages/features Domain/Component/NoteType.ts) mapped
 * onto the renderers above. Spelled out rather than imported so the public
 * viewer does not pull the features package — and so an unknown/new note type
 * falls through to the markdown renderer rather than throwing at a reader.
 */
const NOTE_TYPE_TO_FORMAT: Record<string, SharedNoteFormat> = {
  super: 'super',
  markdown: 'markdown',
  'rich-text': 'html',
  code: 'code',
  'plain-text': 'plain',
  // `task`, `spreadsheet`, `authentication` and `unknown` are deliberately
  // absent: their content is not any of the five, and markdown is the least
  // destructive way to show text we cannot structure.
}

/**
 * True when `text` is a serialized Lexical editor state.
 *
 * Deliberately strict — a `root` with a `children` ARRAY. A markdown note that
 * merely happens to be JSON (an API response pasted into a note, say) has no
 * such shape, and misrouting it into the Super renderer would show the reader
 * an empty document instead of their text.
 */
export function looksLikeSuperText(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') || !trimmed.includes('"root"')) {
    return false
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  const root = (parsed as { root?: unknown } | null)?.root as { children?: unknown } | undefined
  return typeof root === 'object' && root !== null && Array.isArray(root.children)
}

/**
 * Resolve the renderer for one shared note.
 *
 * A declared `noteType` wins, EXCEPT that Super text is always rendered by the
 * Super renderer: a note converted to Super keeps whatever editor identifier it
 * had until the next save, and showing a reader raw Lexical JSON because of a
 * stale hint is the exact failure this function exists to end.
 */
export function resolveSharedNoteFormat(noteType: unknown, text: string): SharedNoteFormat {
  if (looksLikeSuperText(text)) {
    return 'super'
  }

  if (typeof noteType === 'string') {
    const declared = NOTE_TYPE_TO_FORMAT[noteType]
    if (declared !== undefined) {
      // A declared `super` whose text is not Super JSON is not Super. Falling
      // through to markdown shows the text; trusting the label shows nothing.
      return declared === 'super' ? 'markdown' : declared
    }
  }

  return 'markdown'
}
