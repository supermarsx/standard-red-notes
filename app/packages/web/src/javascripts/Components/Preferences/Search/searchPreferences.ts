import { PreferencePaneId } from '@standardnotes/services'
import { PREFERENCES_SEARCH_KEYWORDS } from './PreferencesSearchIndex'

/**
 * A single pane that the user can search for. Only the fields needed to build a
 * searchable index are required, so this stays decoupled from the full
 * `PreferencesMenuItem` / `SelectableMenuItem` shapes and is easy to unit test.
 */
export interface SearchablePane {
  id: PreferencePaneId
  label: string
}

/**
 * The label of a section/keyword inside a pane that matched the query. When the
 * match came from the pane title itself this is undefined.
 */
export interface PreferencesSearchResult {
  id: PreferencePaneId
  /** The human title of the pane (as shown in the menu). */
  label: string
  /**
   * The most relevant matching keyword/section label for the query, if the match
   * came from a keyword rather than the pane title. Useful to render as a
   * secondary "jump to" hint.
   */
  matchedKeyword?: string
  /** Higher is a better match. Used purely for ranking. */
  score: number
}

const normalize = (value: string): string => value.trim().toLowerCase()

/**
 * Lightweight fuzzy check: returns true when every character of `query` appears
 * in `target` in order (subsequence match). This lets "drkmd" match "dark mode"
 * while still being cheap and dependency-free.
 */
const isSubsequence = (query: string, target: string): boolean => {
  let queryIndex = 0
  for (let i = 0; i < target.length && queryIndex < query.length; i++) {
    if (target[i] === query[queryIndex]) {
      queryIndex++
    }
  }
  return queryIndex === query.length
}

const WORD_START_BONUS = 8
const SUBSTRING_BONUS = 5
const SUBSEQUENCE_BONUS = 1

/**
 * Scores how well a single candidate string matches the query. Returns 0 when
 * there is no match at all.
 *
 * Ranking priority (highest first):
 *  - exact equality
 *  - the candidate starts with the query (prefix)
 *  - a word inside the candidate starts with the query
 *  - the query appears anywhere as a substring
 *  - the query is a fuzzy subsequence of the candidate
 *
 * Shorter candidates that match win ties (a precise hit on a short label beats a
 * loose hit on a long one).
 */
const scoreCandidate = (query: string, candidate: string): number => {
  const target = normalize(candidate)
  if (target.length === 0) {
    return 0
  }

  if (target === query) {
    return 100
  }

  let score = 0

  if (target.startsWith(query)) {
    score = 20 + WORD_START_BONUS
  } else if (target.split(/[\s/-]+/).some((word) => word.startsWith(query))) {
    score = 15 + WORD_START_BONUS
  } else if (target.includes(query)) {
    score = 10 + SUBSTRING_BONUS
  } else if (isSubsequence(query, target)) {
    score = SUBSEQUENCE_BONUS
  } else {
    return 0
  }

  // Prefer tighter matches: the closer the candidate length is to the query
  // length, the better. Caps the adjustment so it never overrides the tier.
  const lengthPenalty = Math.min(4, (target.length - query.length) / 8)
  return score - lengthPenalty
}

/**
 * Pure search/match function: given a query and the set of available panes,
 * returns the matching panes ranked best-first.
 *
 * A pane matches when the query matches its title or any of its keywords/section
 * labels (case-insensitive substring or fuzzy subsequence). The result keeps the
 * single best-scoring matched keyword (when the title itself didn't match) so the
 * UI can show a "jump to <section>" hint.
 *
 * An empty/whitespace query returns an empty array — callers should treat that
 * as "show the full, unfiltered menu".
 */
export const searchPreferences = (rawQuery: string, panes: SearchablePane[]): PreferencesSearchResult[] => {
  const query = normalize(rawQuery)
  if (query.length === 0) {
    return []
  }

  const results: PreferencesSearchResult[] = []

  for (const pane of panes) {
    const titleScore = scoreCandidate(query, pane.label)

    let bestKeyword: string | undefined
    let bestKeywordScore = 0
    const keywords = PREFERENCES_SEARCH_KEYWORDS[pane.id] ?? []
    for (const keyword of keywords) {
      const keywordScore = scoreCandidate(query, keyword)
      if (keywordScore > bestKeywordScore) {
        bestKeywordScore = keywordScore
        bestKeyword = keyword
      }
    }

    const score = Math.max(titleScore, bestKeywordScore)
    if (score <= 0) {
      continue
    }

    results.push({
      id: pane.id,
      label: pane.label,
      // Only surface a keyword hint when it (not the title) drove the match.
      matchedKeyword: bestKeywordScore > titleScore ? bestKeyword : undefined,
      score,
    })
  }

  return results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    return a.label.localeCompare(b.label)
  })
}
