// Pure, dependency-free relevance scoring for the notes-list "Relevance" sort.
//
// Notes are end-to-end encrypted and decrypted only in the browser, so ranking
// must run client-side over already-decrypted text. This module computes a
// single relevance score for a note against a search query using transparent,
// unit-testable heuristics (no external service, no async):
//
//  - Field weighting: a hit in the TITLE counts far more than a hit in the body.
//  - Match quality: an exact whole-word match > a prefix match > a fuzzy
//    (substring-inside-a-word) match.
//  - Term coverage: notes that contain MORE of the distinct query terms rank
//    above notes that only match one term, regardless of raw frequency.
//  - Term frequency: among notes with equal coverage, more occurrences rank
//    higher, but with diminishing returns (log) so a long note that merely
//    repeats a word doesn't dominate a focused short note.
//
// The function is intentionally synchronous and pure so it can be reused both by
// the live content-list ordering and by unit tests.

export interface RelevanceScorable {
  /** Note title (already decrypted plaintext). */
  title: string
  /** Note body as readable plaintext (Super notes must be pre-extracted). */
  text: string
}

const TITLE_WEIGHT = 10
const BODY_WEIGHT = 1

// Match-quality multipliers, applied on top of the field weight.
const EXACT_MATCH = 1
const PREFIX_MATCH = 0.6
const FUZZY_MATCH = 0.3

// Each additional distinct query term a note covers is worth a flat bonus so
// coverage dominates raw frequency.
const COVERAGE_BONUS = 25

/** Lowercase alphanumeric runs of length > 1, matching the SearchIndex tokenizer. */
export function relevanceTokenize(value: string): string[] {
  const matches = value.toLowerCase().match(/[a-z0-9]+/g)
  return matches ? matches.filter((token) => token.length > 1) : []
}

/**
 * Score how well a single field (title or body) matches one query term.
 *
 * Returns the best per-occurrence quality found for the term in the field:
 *  - EXACT when the term appears as a whole token,
 *  - else PREFIX when a token starts with the term,
 *  - else FUZZY when a token merely contains the term,
 *  - else 0 (term absent from this field).
 * The quality is multiplied by a frequency factor with diminishing returns.
 */
function scoreFieldForTerm(fieldTokens: string[], term: string): number {
  let occurrences = 0
  let bestQuality = 0
  for (const token of fieldTokens) {
    if (token === term) {
      occurrences += 1
      bestQuality = Math.max(bestQuality, EXACT_MATCH)
    } else if (token.startsWith(term)) {
      occurrences += 1
      bestQuality = Math.max(bestQuality, PREFIX_MATCH)
    } else if (token.includes(term)) {
      occurrences += 1
      bestQuality = Math.max(bestQuality, FUZZY_MATCH)
    }
  }
  if (occurrences === 0) {
    return 0
  }
  // Diminishing returns on frequency: 1 + ln(occurrences).
  const frequencyFactor = 1 + Math.log(occurrences)
  return bestQuality * frequencyFactor
}

/**
 * Compute a relevance score (>= 0) for a note against a free-text query.
 * Higher is more relevant. A note with no query-term matches scores 0.
 *
 * Pure and synchronous so it is trivially unit-testable and reusable.
 */
export function scoreNoteRelevance(note: RelevanceScorable, query: string): number {
  const queryTerms = [...new Set(relevanceTokenize(query))]
  if (queryTerms.length === 0) {
    return 0
  }

  const titleTokens = relevanceTokenize(note.title ?? '')
  const bodyTokens = relevanceTokenize(note.text ?? '')

  let score = 0
  let coveredTerms = 0

  for (const term of queryTerms) {
    const titleScore = scoreFieldForTerm(titleTokens, term)
    const bodyScore = scoreFieldForTerm(bodyTokens, term)

    if (titleScore > 0 || bodyScore > 0) {
      coveredTerms += 1
    }

    score += titleScore * TITLE_WEIGHT + bodyScore * BODY_WEIGHT
  }

  if (coveredTerms === 0) {
    return 0
  }

  // Reward covering more of the distinct query terms so multi-term coverage
  // outranks a single heavily-repeated term.
  score += coveredTerms * COVERAGE_BONUS

  return score
}

/**
 * Rank a set of notes by descending relevance to the query, returning their
 * uuids in best-match-first order. Notes scoring 0 (no match) are dropped.
 *
 * Pure: ties are broken by the caller-supplied order (stable sort), so the
 * caller can keep e.g. date order among equally-relevant notes.
 */
export function rankNotesByRelevance<T extends RelevanceScorable & { uuid: string }>(
  notes: T[],
  query: string,
): string[] {
  const scored = notes
    .map((note, index) => ({ uuid: note.uuid, index, score: scoreNoteRelevance(note, query) }))
    .filter((entry) => entry.score > 0)

  scored.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.index - b.index
  })

  return scored.map((entry) => entry.uuid)
}
