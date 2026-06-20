import { NoteType } from '@standardnotes/snjs'
import { extractPlaintextFromNoteText } from '@/Utils/NoteStats'

export type SplitMode = 'headings' | 'hr' | 'delimiter'

export type SplitNoteOptions = {
  mode: SplitMode
  /** Required (and used) only when `mode === 'delimiter'`. */
  delimiter?: string
  /**
   * The note's type. Super notes have their plaintext extracted before
   * splitting (see {@link splitNoteContent}); plain notes are split as-is.
   */
  noteType: NoteType | undefined
}

export type NotePart = {
  title: string
  content: string
}

/** Matches a Markdown ATX heading line, e.g. `#`, `## Heading`, up to 6 `#`. */
const ATX_HEADING_REGEX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/

/**
 * Matches a Markdown thematic break (horizontal rule) on its own line:
 * three or more of `-`, `*`, or `_`, optionally separated by spaces.
 * e.g. `---`, `***`, `___`, `- - -`.
 */
const THEMATIC_BREAK_REGEX = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/

/**
 * Derives a human title from a block of content: the first non-empty line,
 * with any leading Markdown heading markers stripped. Falls back to
 * `Part N` when there is no usable first line.
 */
function deriveTitle(content: string, partNumber: number): string {
  const nonEmptyLines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  for (const line of nonEmptyLines) {
    const headingMatch = line.match(ATX_HEADING_REGEX)
    // Strip a leading ATX heading marker so the title reads as plain prose.
    const cleaned = headingMatch ? (headingMatch[2] ?? '').trim() : line
    if (cleaned.length > 0) {
      return cleaned
    }
    // An empty heading (e.g. "# ") yields no title; fall through to the next line.
  }

  return `Part ${partNumber}`
}

/**
 * Turns an array of raw section strings into trimmed, non-empty parts with
 * derived titles. When `headingTitles` is provided, each section's title comes
 * from the corresponding entry (the heading text) rather than the first line;
 * a `null`/empty entry falls back to first-line derivation.
 */
function buildParts(sections: string[], headingTitles?: (string | null)[]): NotePart[] {
  const parts: NotePart[] = []

  sections.forEach((section, index) => {
    const content = section.trim()
    if (content.length === 0) {
      return
    }

    const partNumber = parts.length + 1
    const explicitTitle = headingTitles?.[index]?.trim()
    const title = explicitTitle && explicitTitle.length > 0 ? explicitTitle : deriveTitle(content, partNumber)

    parts.push({ title, content })
  })

  return parts
}

function splitByHeadings(text: string): NotePart[] {
  const lines = text.split('\n')

  const sections: string[] = []
  const titles: (string | null)[] = []

  let currentLines: string[] = []
  let currentTitle: string | null = null
  let started = false

  const flush = () => {
    // Only push a section once we've started one OR there's leading content.
    if (started || currentLines.length > 0) {
      sections.push(currentLines.join('\n'))
      titles.push(currentTitle)
    }
    currentLines = []
    currentTitle = null
  }

  for (const line of lines) {
    const headingMatch = line.match(ATX_HEADING_REGEX)
    if (headingMatch) {
      // Close out the leading/previous section before starting a new one.
      flush()
      started = true
      currentTitle = (headingMatch[2] ?? '').trim() || null
      currentLines = [line]
    } else {
      currentLines.push(line)
    }
  }
  flush()

  return buildParts(sections, titles)
}

function splitByThematicBreak(text: string): NotePart[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let currentLines: string[] = []

  for (const line of lines) {
    if (THEMATIC_BREAK_REGEX.test(line)) {
      sections.push(currentLines.join('\n'))
      currentLines = []
    } else {
      currentLines.push(line)
    }
  }
  sections.push(currentLines.join('\n'))

  return buildParts(sections)
}

function splitByDelimiter(text: string, delimiter: string): NotePart[] {
  // A literal string split (not a regex) so users can paste any delimiter.
  const sections = text.split(delimiter)
  return buildParts(sections)
}

/**
 * Splits a note's text into multiple `{ title, content }` parts.
 *
 * Modes:
 *  - `headings`: split at Markdown ATX headings (`#`..`######`). Each section's
 *    title is the heading text; content runs until the next heading. Content
 *    before the first heading becomes a leading part (title from its first line).
 *  - `hr`: split at thematic breaks (`---`/`***`/`___` on their own line).
 *  - `delimiter`: split at a literal user-provided string.
 *
 * Titles for non-heading parts come from the part's first non-empty line, or
 * `Part N` as a fallback. Empty/whitespace-only parts are dropped, and every
 * part's content is trimmed.
 *
 * Super notes: the stored `text` is Lexical JSON, which is not safe to split
 * structurally here, so we extract the visible plaintext (via
 * {@link extractPlaintextFromNoteText}) and split THAT. Callers should create
 * the resulting parts as PLAIN notes and tell the user.
 */
export function splitNoteContent(text: string, options: SplitNoteOptions): NotePart[] {
  const plaintext = extractPlaintextFromNoteText(text ?? '', options.noteType)

  // Normalize line endings so our line-oriented regexes are predictable.
  const normalized = plaintext.replace(/\r\n?/g, '\n')

  switch (options.mode) {
    case 'headings':
      return splitByHeadings(normalized)
    case 'hr':
      return splitByThematicBreak(normalized)
    case 'delimiter': {
      const delimiter = options.delimiter ?? ''
      if (delimiter.length === 0) {
        // No delimiter to split on: treat the whole note as a single part so
        // the caller can report "nothing to split on".
        return buildParts([normalized])
      }
      return splitByDelimiter(normalized, delimiter)
    }
    default:
      return buildParts([normalized])
  }
}
