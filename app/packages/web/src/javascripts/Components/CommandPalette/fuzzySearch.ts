/**
 * A small, dependency-free fuzzy matcher used by the command palette.
 *
 * Given a query and a target string it answers two questions:
 *   1. Does every character of the query appear, in order, somewhere in the target?
 *   2. How "good" is that match, so results can be ranked?
 *
 * The matcher is intentionally pure (no app/DOM/network access) so it can be
 * unit tested in isolation and reused for both commands and notes.
 */

export type FuzzyMatchRange = [number, number]

export interface FuzzyMatch {
  /** True when the whole query was found in order within the target. */
  matched: boolean
  /** Higher is better. Only meaningful when `matched` is true. */
  score: number
  /**
   * Inclusive-exclusive ranges of matched characters in the target, suitable
   * for highlighting. Adjacent matched characters are merged into one range.
   */
  ranges: FuzzyMatchRange[]
}

const NO_MATCH: FuzzyMatch = { matched: false, score: 0, ranges: [] }

// Scoring weights. Tuned so that, for the same set of matched characters:
//   - a contiguous run of the query beats a scattered match
//   - a match at the start of the target (or at a word boundary) ranks higher
//   - shorter targets rank higher when otherwise equal (more "exact")
const SCORE_MATCH = 16
const SCORE_CONSECUTIVE = 18
const SCORE_START_OF_STRING = 24
const SCORE_WORD_BOUNDARY = 12
const PENALTY_LEADING_GAP = 3 // per character skipped before the first match
const PENALTY_GAP = 1 // per character skipped between matched characters

const WORD_BOUNDARY_BEFORE = /[\s\-_/.([{]/

function isWordBoundary(target: string, index: number): boolean {
  if (index === 0) {
    return true
  }
  return WORD_BOUNDARY_BEFORE.test(target[index - 1] as string)
}

function mergeIntoRanges(ranges: FuzzyMatchRange[], index: number): void {
  const last = ranges[ranges.length - 1]
  if (last && last[1] === index) {
    last[1] = index + 1
  } else {
    ranges.push([index, index + 1])
  }
}

/**
 * Compute a fuzzy match of `rawQuery` against `rawTarget`.
 *
 * Matching is case-insensitive. An empty query matches everything with a
 * neutral score of 0 (callers typically short-circuit the empty-query case).
 */
export function fuzzyMatch(rawQuery: string, rawTarget: string): FuzzyMatch {
  const query = rawQuery.toLowerCase().trim()
  if (query.length === 0) {
    return { matched: true, score: 0, ranges: [] }
  }

  const target = rawTarget.toLowerCase()
  if (query.length > target.length) {
    return NO_MATCH
  }

  // Fast path: a contiguous substring match is always the strongest kind of
  // match, so reward it heavily and skip the per-character walk.
  const directIndex = target.indexOf(query)
  if (directIndex !== -1) {
    let score = SCORE_MATCH * query.length + SCORE_CONSECUTIVE * (query.length - 1)
    if (directIndex === 0) {
      score += SCORE_START_OF_STRING
    } else if (isWordBoundary(rawTarget, directIndex)) {
      score += SCORE_WORD_BOUNDARY
    } else {
      score -= PENALTY_LEADING_GAP * directIndex
    }
    // Prefer shorter targets among equally-good prefix matches.
    score -= Math.max(0, target.length - query.length)
    return {
      matched: true,
      score,
      ranges: [[directIndex, directIndex + query.length]],
    }
  }

  // Subsequence walk: every query char must appear in order.
  const ranges: FuzzyMatchRange[] = []
  let score = 0
  let queryIndex = 0
  let previousMatchIndex = -1

  for (let targetIndex = 0; targetIndex < target.length && queryIndex < query.length; targetIndex++) {
    if (target[targetIndex] !== query[queryIndex]) {
      continue
    }

    let charScore = SCORE_MATCH
    if (previousMatchIndex === -1) {
      score -= PENALTY_LEADING_GAP * targetIndex
    } else {
      const gap = targetIndex - previousMatchIndex - 1
      if (gap === 0) {
        charScore += SCORE_CONSECUTIVE
      } else {
        score -= PENALTY_GAP * gap
      }
    }

    if (targetIndex === 0) {
      charScore += SCORE_START_OF_STRING
    } else if (isWordBoundary(rawTarget, targetIndex)) {
      charScore += SCORE_WORD_BOUNDARY
    }

    score += charScore
    mergeIntoRanges(ranges, targetIndex)
    previousMatchIndex = targetIndex
    queryIndex++
  }

  if (queryIndex < query.length) {
    return NO_MATCH
  }

  score -= Math.max(0, target.length - query.length)
  return { matched: true, score, ranges }
}

export interface RankableItem {
  /** Primary text the query is matched against and highlighted in. */
  text: string
  /** Optional extra terms (synonyms/keywords) that can satisfy a match but are not highlighted. */
  keywords?: string[]
}

export interface FuzzyRankResult<T extends RankableItem> {
  item: T
  score: number
  /** Ranges within `item.text` to highlight, or undefined when the match came from a keyword. */
  ranges?: FuzzyMatchRange[]
}

/**
 * Filter and rank `items` by how well they fuzzy-match `query`, best first.
 *
 * For each item the best of its primary text and any keyword is used. Ties are
 * broken by primary-text length then alphabetically, giving a stable order.
 */
export function fuzzyRank<T extends RankableItem>(query: string, items: readonly T[]): FuzzyRankResult<T>[] {
  const trimmed = query.trim()
  if (trimmed.length === 0) {
    return items.map((item) => ({ item, score: 0, ranges: undefined }))
  }

  const results: FuzzyRankResult<T>[] = []
  for (const item of items) {
    const primary = fuzzyMatch(trimmed, item.text)
    let best: { score: number; ranges?: FuzzyMatchRange[] } | undefined = primary.matched
      ? { score: primary.score, ranges: primary.ranges }
      : undefined

    if (item.keywords) {
      for (const keyword of item.keywords) {
        const keywordMatch = fuzzyMatch(trimmed, keyword)
        if (keywordMatch.matched) {
          // Keyword matches are deliberately weaker than a title match and are
          // not highlighted (the matched range lives in the keyword, not text).
          const keywordScore = keywordMatch.score - SCORE_WORD_BOUNDARY
          if (!best || keywordScore > best.score) {
            best = { score: keywordScore, ranges: undefined }
          }
        }
      }
    }

    if (best) {
      results.push({ item, score: best.score, ranges: best.ranges })
    }
  }

  results.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score
    }
    if (a.item.text.length !== b.item.text.length) {
      return a.item.text.length - b.item.text.length
    }
    return a.item.text < b.item.text ? -1 : a.item.text > b.item.text ? 1 : 0
  })

  return results
}
