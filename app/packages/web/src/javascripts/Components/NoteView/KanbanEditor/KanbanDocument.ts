/**
 * Kanban board note document model (full-note editor).
 *
 * A Kanban note stores an ordered list of columns, each with an ordered list of
 * cards. The data shape intentionally mirrors the Super editor's KanbanNode
 * block for familiarity, but this is an independent, whole-note editor — not a
 * Lexical block.
 *
 * Exactly like the Canvas, Base, Sandbox, and Calendar note types, the
 * serialized document is stored verbatim in `note.text` (the same slot Super
 * stores its Lexical JSON in). This keeps a Kanban note round-tripping and
 * syncing like any other note with no models/snjs changes — the note is marked
 * as a kanban board purely via `note.editorIdentifier`.
 */

export const KANBAN_DOCUMENT_VERSION = 1

export type KanbanCard = {
  id: string
  text: string
}

export type KanbanColumn = {
  id: string
  title: string
  /** Optional CSS color string for the column header accent. */
  color?: string
  cards: KanbanCard[]
}

export type KanbanDocument = {
  version: number
  title: string
  columns: KanbanColumn[]
}

export const createEmptyKanbanDocument = (): KanbanDocument => ({
  version: KANBAN_DOCUMENT_VERSION,
  title: '',
  columns: [],
})

/** A small starter board so a fresh Kanban note isn't a blank slate. */
export const createKanbanStarter = (): KanbanDocument => ({
  version: KANBAN_DOCUMENT_VERSION,
  title: '',
  columns: [
    { id: createKanbanId('col'), title: 'To Do', cards: [] },
    { id: createKanbanId('col'), title: 'In Progress', cards: [] },
    { id: createKanbanId('col'), title: 'Done', cards: [] },
  ],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const sanitizeCard = (raw: unknown): KanbanCard | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  return {
    id: candidate.id,
    text: isString(candidate.text) ? candidate.text : '',
  }
}

const sanitizeColumn = (raw: unknown): KanbanColumn | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  const rawCards = Array.isArray(candidate.cards) ? candidate.cards : []
  const cards: KanbanCard[] = []
  const seenCardIds = new Set<string>()
  for (const rawCard of rawCards) {
    const card = sanitizeCard(rawCard)
    if (card && !seenCardIds.has(card.id)) {
      seenCardIds.add(card.id)
      cards.push(card)
    }
  }
  return {
    id: candidate.id,
    title: isString(candidate.title) ? candidate.title : '',
    color: isString(candidate.color) ? candidate.color : undefined,
    cards,
  }
}

/**
 * Parse note text into a KanbanDocument. Never throws: empty, legacy plain text,
 * or otherwise malformed JSON all fall back to an empty board. The second return
 * value reports whether the input was recoverable kanban JSON so the editor can
 * surface a non-destructive notice when content was discarded.
 */
export const parseKanbanDocument = (
  text: string | undefined | null,
): { document: KanbanDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyKanbanDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyKanbanDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyKanbanDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A kanban document must at least expose a columns array; otherwise it is
  // probably some other note format being switched into Kanban, so treat it as a
  // fresh board but flag it as not-recovered.
  const looksLikeKanban = Array.isArray(candidate.columns)
  if (!looksLikeKanban) {
    return { document: createEmptyKanbanDocument(), recovered: false }
  }

  const columns: KanbanColumn[] = []
  const seenColumnIds = new Set<string>()
  for (const rawColumn of candidate.columns as unknown[]) {
    const column = sanitizeColumn(rawColumn)
    if (column && !seenColumnIds.has(column.id)) {
      seenColumnIds.add(column.id)
      columns.push(column)
    }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : KANBAN_DOCUMENT_VERSION,
      title: isString(candidate.title) ? candidate.title : '',
      columns,
    },
    recovered: true,
  }
}

/** Serialize a KanbanDocument to the string stored in `note.text`. */
export const serializeKanbanDocument = (document: KanbanDocument): string => {
  return JSON.stringify({
    version: document.version ?? KANBAN_DOCUMENT_VERSION,
    title: document.title ?? '',
    columns: document.columns,
  })
}

/** Total card count across all columns (used for previews). */
export const countCards = (document: KanbanDocument): number =>
  document.columns.reduce((sum, column) => sum + column.cards.length, 0)

let idCounter = 0
/** Lightweight unique id generator for columns/cards (no crypto dependency). */
export function createKanbanId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
