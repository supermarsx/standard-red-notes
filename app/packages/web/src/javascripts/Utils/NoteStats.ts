import { NoteType } from '@standardnotes/snjs'

export type NoteStats = {
  characters: number
  charactersNoSpaces: number
  words: number
  lines: number
  paragraphs: number
}

/**
 * Cap how much text we scan so that pathologically large notes can't lock up the
 * footer. 1M characters is well beyond any realistic hand-written note while still
 * being cheap to scan synchronously.
 */
export const NOTE_STATS_MAX_SCAN_LENGTH = 1_000_000

/**
 * Computes character/word/line/paragraph counts for a block of plain text.
 *
 * Definitions:
 *  - characters: total length of the (possibly truncated) text, spaces included.
 *  - charactersNoSpaces: characters with all whitespace removed.
 *  - words: runs of non-whitespace separated by whitespace (empty strings ignored).
 *  - lines: number of newline-separated lines (newline count + 1), or 0 when empty.
 *  - paragraphs: blocks separated by one or more blank lines, or 0 when empty.
 */
export function computePlaintextStats(rawText: string): NoteStats {
  const text = rawText.length > NOTE_STATS_MAX_SCAN_LENGTH ? rawText.slice(0, NOTE_STATS_MAX_SCAN_LENGTH) : rawText

  if (text.length === 0) {
    return { characters: 0, charactersNoSpaces: 0, words: 0, lines: 0, paragraphs: 0 }
  }

  const characters = text.length
  const charactersNoSpaces = text.replace(/\s/g, '').length

  const words = text.split(/\s+/).filter((token) => token.length > 0).length

  // Normalize line endings, then count lines as newline count + 1.
  const normalized = text.replace(/\r\n?/g, '\n')
  const lines = normalized.split('\n').length

  const paragraphs = normalized
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0).length

  return { characters, charactersNoSpaces, words, lines, paragraphs }
}

/**
 * Best-effort extraction of plain text from a note's stored `text`.
 *
 * For plain notes, `note.text` is already the plain text.
 *
 * For Super (Lexical) notes, `note.text` is Lexical editor-state JSON. Running the
 * real {@link HeadlessSuperConverter} would spin up a headless Lexical editor on
 * every keystroke, which is too heavy for a footer chip. Instead we pull the `text`
 * fields out of the serialized node tree (the same `"text"` keys Lexical text nodes
 * use) and join them on newlines, which is a close approximation of the visible
 * prose. This may slightly under/over-count for notes that lean heavily on tables,
 * code blocks, or embedded files, so the counts are documented as approximate.
 */
export function extractPlaintextFromNoteText(noteText: string, noteType: NoteType | undefined): string {
  if (noteType !== NoteType.Super) {
    return noteText
  }

  if (noteText.length === 0) {
    return ''
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(noteText)
  } catch {
    // Not valid JSON (e.g. a note mid-conversion); fall back to the raw string.
    return noteText
  }

  const pieces: string[] = []
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') {
      return
    }
    const record = node as Record<string, unknown>
    if (typeof record.text === 'string' && record.text.length > 0) {
      pieces.push(record.text)
    }
    const children = record.children
    if (Array.isArray(children)) {
      for (const child of children) {
        visit(child)
      }
    }
  }

  const root = (parsed as { root?: unknown })?.root
  visit(root ?? parsed)

  return pieces.join('\n')
}
