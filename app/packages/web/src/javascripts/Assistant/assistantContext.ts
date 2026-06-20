// Assembles the "context" the AI assistant operates on: the note content that is
// prepended to a conversation so the model can answer about the user's notes
// without first having to call tools. The user chooses the SCOPE (see
// AssistantContextScope); this module turns a chosen scope + a set of notes into
// a single bounded context string plus a summary of exactly what was included.
//
// Everything here is a PURE function of its inputs (note title/text records and a
// character budget) so it can be unit-tested in isolation. Resolving a scope into
// the actual notes from `application.items` lives in assistantContextSource.ts.

/** Which notes the assistant should be given as context. */
export type AssistantContextScope =
  /** Just the active note (default). */
  | 'current-note'
  /** A digest of every note in the app ("notebook"). */
  | 'all-notes'
  /** A specific set: the notes of a chosen tag/folder, or a manual selection. */
  | 'collection'

/** A single note's content for context assembly. */
export interface ContextNote {
  uuid: string
  title: string
  /** Already plain text (Super notes extracted best-effort before they reach here). */
  text: string
}

export interface BuildAssistantContextOptions {
  /**
   * Max characters of assembled context. The assistant respects this so broad
   * scopes (e.g. "all notes") cannot blow past a reasonable token budget. As a
   * rough rule of thumb ~4 chars ≈ 1 token, so the default 12k cap is ~3k tokens.
   */
  budget?: number
  /** Optional human label for the collection (e.g. a tag/folder title). */
  collectionLabel?: string
}

/** A description of the context that was built, for the request and the UI. */
export interface BuiltAssistantContext {
  /** The text block to feed the model. Empty string when there is nothing to send. */
  text: string
  /** The scope this context was built for. */
  scope: AssistantContextScope
  /** Number of notes actually represented (after the budget cut). */
  noteCount: number
  /** Number of notes that were dropped entirely because the budget ran out. */
  omittedNoteCount: number
  /** Total characters of the assembled `text` block. */
  characters: number
  /** True if any note content was truncated or any note was dropped. */
  truncated: boolean
}

/** ~4 chars per token; 12k chars ≈ 3k tokens of context, a conservative default. */
export const DEFAULT_ASSISTANT_CONTEXT_BUDGET = 12_000

/**
 * Minimum slice of the budget a single note gets so that, with many notes, every
 * note still contributes at least a title + a small snippet rather than the first
 * note eating the whole budget.
 */
const MIN_PER_NOTE_CHARS = 120

const ellipsize = (value: string, max: number): { text: string; truncated: boolean } => {
  if (max <= 0) {
    return { text: '', truncated: value.length > 0 }
  }
  if (value.length <= max) {
    return { text: value, truncated: false }
  }
  return { text: `${value.slice(0, Math.max(0, max - 1))}…`, truncated: true }
}

const normalizeText = (text: string): string => text.replace(/\r\n?/g, '\n').trim()

/**
 * Build a bounded context string for the given scope and notes.
 *
 * - `current-note`: the single note gets (almost) the whole budget.
 * - `all-notes` / `collection`: notes share the budget. Each note is allotted an
 *   even share (floored at MIN_PER_NOTE_CHARS); within its share a note keeps its
 *   title and as much of its body as fits, truncating with an ellipsis. Once the
 *   budget is exhausted, remaining notes are dropped and reported as omitted.
 *
 * The returned `text` is safe to prepend to a prompt; the caller decides how to
 * frame it (e.g. inside a system message). The summary fields drive the UI's
 * data-exposure notice ("Sending N notes / ~X chars").
 */
export function buildAssistantContext(
  scope: AssistantContextScope,
  notes: ContextNote[],
  options: BuildAssistantContextOptions = {},
): BuiltAssistantContext {
  const budget = options.budget && options.budget > 0 ? Math.floor(options.budget) : DEFAULT_ASSISTANT_CONTEXT_BUDGET

  const cleaned = notes
    .map((note) => ({
      uuid: note.uuid,
      title: (note.title ?? '').trim(),
      text: normalizeText(note.text ?? ''),
    }))
    // A note with neither a meaningful title nor body adds nothing. Filter on the
    // raw title BEFORE defaulting it, so empty notes are dropped rather than shown
    // as "Untitled note".
    .filter((note) => note.title.length > 0 || note.text.length > 0)
    .map((note) => ({ ...note, title: note.title || 'Untitled note' }))

  if (cleaned.length === 0) {
    return { text: '', scope, noteCount: 0, omittedNoteCount: 0, characters: 0, truncated: false }
  }

  // Per-note share of the budget. For a single note (current-note) this is the
  // whole budget; for many notes it is an even slice, floored so each note can
  // still say something.
  const perNoteBudget = Math.max(MIN_PER_NOTE_CHARS, Math.floor(budget / cleaned.length))

  const blocks: string[] = []
  let used = 0
  let noteCount = 0
  let truncated = false

  for (const note of cleaned) {
    if (used >= budget) {
      break
    }
    const remaining = budget - used
    const header = `## ${note.title}`
    // Reserve room for the header + a blank separating line; body gets the rest of
    // this note's share, but never more than what is left of the overall budget.
    const headerCost = header.length + 1
    const bodyAllowance = Math.max(0, Math.min(perNoteBudget, remaining) - headerCost)

    let block = header
    if (note.text.length > 0 && bodyAllowance > 0) {
      const { text, truncated: bodyTruncated } = ellipsize(note.text, bodyAllowance)
      if (text.length > 0) {
        block += `\n${text}`
      }
      truncated = truncated || bodyTruncated
    } else if (note.text.length > 0) {
      // No room for the body at all — title only counts as a truncation.
      truncated = true
    }

    blocks.push(block)
    used += block.length + 2 // +2 for the join separator between blocks
    noteCount += 1
  }

  const omittedNoteCount = cleaned.length - noteCount
  if (omittedNoteCount > 0) {
    truncated = true
  }

  const heading = contextHeading(scope, cleaned.length, options.collectionLabel)
  const body = blocks.join('\n\n')
  const footer =
    omittedNoteCount > 0
      ? `\n\n(Context truncated: ${omittedNoteCount} more note${omittedNoteCount === 1 ? '' : 's'} not shown.)`
      : ''
  const text = `${heading}\n\n${body}${footer}`

  return {
    text,
    scope,
    noteCount,
    omittedNoteCount,
    characters: text.length,
    truncated,
  }
}

function contextHeading(scope: AssistantContextScope, totalNotes: number, collectionLabel?: string): string {
  switch (scope) {
    case 'current-note':
      return 'The user is asking about the current note. Its content follows.'
    case 'all-notes':
      return `Context: a digest of the user's notes (${totalNotes} note${totalNotes === 1 ? '' : 's'}). Content may be truncated.`
    case 'collection':
      return collectionLabel
        ? `Context: the user's notes in "${collectionLabel}" (${totalNotes} note${totalNotes === 1 ? '' : 's'}). Content may be truncated.`
        : `Context: a selected collection of ${totalNotes} note${totalNotes === 1 ? '' : 's'}. Content may be truncated.`
  }
}
