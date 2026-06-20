/**
 * Flashcards note document model (full-note editor).
 *
 * A Flashcards note stores a deck as an ordered list of cards, each with a
 * front and back, plus lightweight spaced-repetition-lite metadata
 * (`knownCount`, `lastReviewed`).
 *
 * Exactly like the Canvas, Base, Sandbox, Calendar, Kanban, and Timeline note
 * types, the serialized document is stored verbatim in `note.text` (the same
 * slot Super stores its Lexical JSON in). This keeps a Flashcards note
 * round-tripping and syncing like any other note with no models/snjs changes —
 * the note is marked as flashcards purely via `note.editorIdentifier`.
 */

export const FLASHCARDS_DOCUMENT_VERSION = 1

export type Flashcard = {
  id: string
  front: string
  back: string
  /** How many times the card has been marked "Got it"; higher = better known. */
  knownCount?: number
  /** Epoch millis of the last study review (for ordering / display). */
  lastReviewed?: number
}

export type FlashcardsDocument = {
  version: number
  cards: Flashcard[]
}

export const createEmptyFlashcardsDocument = (): FlashcardsDocument => ({
  version: FLASHCARDS_DOCUMENT_VERSION,
  cards: [],
})

/** A small starter deck so a fresh Flashcards note isn't a blank slate. */
export const createFlashcardsStarter = (): FlashcardsDocument => ({
  version: FLASHCARDS_DOCUMENT_VERSION,
  cards: [
    { id: createFlashcardsId('card'), front: 'Front of the card', back: 'Back of the card' },
  ],
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const sanitizeCard = (raw: unknown): Flashcard | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    return null
  }
  const card: Flashcard = {
    id: candidate.id,
    front: isString(candidate.front) ? candidate.front : '',
    back: isString(candidate.back) ? candidate.back : '',
  }
  // Only persist a non-negative integer known count; ignore garbage values.
  if (isFiniteNumber(candidate.knownCount) && candidate.knownCount >= 0) {
    card.knownCount = Math.floor(candidate.knownCount)
  }
  if (isFiniteNumber(candidate.lastReviewed) && candidate.lastReviewed >= 0) {
    card.lastReviewed = candidate.lastReviewed
  }
  return card
}

/**
 * Parse note text into a FlashcardsDocument. Never throws: empty, legacy plain
 * text, or otherwise malformed JSON all fall back to an empty deck. The second
 * return value reports whether the input was recoverable flashcards JSON so the
 * editor can surface a non-destructive notice when content was discarded.
 */
export const parseFlashcardsDocument = (
  text: string | undefined | null,
): { document: FlashcardsDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyFlashcardsDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyFlashcardsDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyFlashcardsDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A flashcards document must at least expose a cards array; otherwise it is
  // probably some other note format being switched into Flashcards, so treat it
  // as a fresh deck but flag it as not-recovered.
  const looksLikeFlashcards = Array.isArray(candidate.cards)
  if (!looksLikeFlashcards) {
    return { document: createEmptyFlashcardsDocument(), recovered: false }
  }

  const cards: Flashcard[] = []
  const seenIds = new Set<string>()
  for (const rawCard of candidate.cards as unknown[]) {
    const card = sanitizeCard(rawCard)
    if (card && !seenIds.has(card.id)) {
      seenIds.add(card.id)
      cards.push(card)
    }
  }

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : FLASHCARDS_DOCUMENT_VERSION,
      cards,
    },
    recovered: true,
  }
}

/** Serialize a FlashcardsDocument to the string stored in `note.text`. */
export const serializeFlashcardsDocument = (document: FlashcardsDocument): string => {
  return JSON.stringify({
    version: document.version ?? FLASHCARDS_DOCUMENT_VERSION,
    cards: document.cards.map((card) => ({
      id: card.id,
      front: card.front ?? '',
      back: card.back ?? '',
      ...(card.knownCount !== undefined ? { knownCount: card.knownCount } : {}),
      ...(card.lastReviewed !== undefined ? { lastReviewed: card.lastReviewed } : {}),
    })),
  })
}

/** Number of cards considered "known" (marked Got it at least once). */
export const countKnownCards = (document: FlashcardsDocument): number =>
  document.cards.reduce((sum, card) => sum + ((card.knownCount ?? 0) > 0 ? 1 : 0), 0)

/**
 * Spaced-repetition-lite ordering. Returns the cards in study priority order:
 * lower `knownCount` first (cards marked "Again" / never gotten bubble up),
 * tie-broken by least-recently-reviewed (older `lastReviewed` first, with
 * never-reviewed treated as oldest), tie-broken by original deck order for
 * stability.
 */
export const orderCardsForStudy = (cards: Flashcard[]): Flashcard[] => {
  return cards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => {
      const knownA = a.card.knownCount ?? 0
      const knownB = b.card.knownCount ?? 0
      if (knownA !== knownB) {
        return knownA - knownB
      }
      const reviewedA = a.card.lastReviewed ?? 0
      const reviewedB = b.card.lastReviewed ?? 0
      if (reviewedA !== reviewedB) {
        return reviewedA - reviewedB
      }
      return a.index - b.index
    })
    .map((entry) => entry.card)
}

let idCounter = 0
/** Lightweight unique id generator for cards (no crypto dependency). */
export function createFlashcardsId(prefix: string): string {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
