import {
  DecryptedItemInterface,
  ItemWithTags,
  PredicateInterface,
  PredicateJsonForm,
  SNTag,
  predicateFromJson,
} from '@standardnotes/snjs'

/**
 * Pure evaluator behind the live "Matches N items right now" preview.
 *
 * It builds a real predicate from the builder's JSON (via the same
 * `predicateFromJson` the model uses) and evaluates it against the current
 * in-memory items using the exact matching path the app itself uses
 * (`predicate.matchesItem`), mirroring how DisplayOptionsToFilters wraps items
 * with `ItemWithTags` when the predicate references the `tags` keypath.
 *
 * It is defensively written so an invalid or half-finished predicate never
 * throws: build failures yield an `error` status, and per-item match failures
 * are swallowed (that item simply doesn't match). Callers can render a "—" or
 * guidance string for non-`ok` statuses.
 */

export type MatchPreviewStatus = 'ok' | 'incomplete' | 'error'

export interface MatchPreviewResult {
  status: MatchPreviewStatus
  count: number
  sampleTitles: string[]
  /** How many items were actually scanned (after any performance cap). */
  scanned: number
  /** How many items were available in memory before the cap. */
  totalAvailable: number
  /** True when the scan was capped and only a subset was evaluated. */
  limited: boolean
  message?: string
}

/** Performance cap: never scan more than this many items synchronously. */
export const DEFAULT_SCAN_LIMIT = 5000
const DEFAULT_SAMPLE_SIZE = 5

export type PreviewItem = DecryptedItemInterface

/**
 * Build a predicate from JSON, returning null (never throwing) if the JSON is
 * incomplete or unparseable.
 */
export const buildPreviewPredicate = (
  predicateJson: PredicateJsonForm | undefined,
): PredicateInterface<DecryptedItemInterface> | null => {
  if (!predicateJson) {
    return null
  }
  try {
    const predicate = predicateFromJson<DecryptedItemInterface>(predicateJson)
    return predicate ?? null
  } catch {
    return null
  }
}

const safeReferencesTags = (predicate: PredicateInterface<DecryptedItemInterface>): boolean => {
  try {
    return predicate.keypathIncludesString('tags')
  } catch {
    return false
  }
}

const readTitle = (item: PreviewItem): string => {
  const title = (item as unknown as { title?: unknown }).title
  return typeof title === 'string' && title.trim().length > 0 ? title : 'Untitled'
}

export interface EvaluateOptions {
  limit?: number
  sampleSize?: number
}

export const evaluatePredicateMatches = (
  predicateJson: PredicateJsonForm | undefined,
  items: PreviewItem[],
  resolveTags: (item: PreviewItem) => SNTag[],
  options: EvaluateOptions = {},
): MatchPreviewResult => {
  const limit = options.limit ?? DEFAULT_SCAN_LIMIT
  const sampleSize = options.sampleSize ?? DEFAULT_SAMPLE_SIZE
  const totalAvailable = items.length

  const predicate = buildPreviewPredicate(predicateJson)
  if (!predicate) {
    return {
      status: 'error',
      count: 0,
      sampleTitles: [],
      scanned: 0,
      totalAvailable,
      limited: false,
      message: 'Add or complete a condition to preview matches.',
    }
  }

  const referencesTags = safeReferencesTags(predicate)
  const scanItems = items.slice(0, limit)
  const limited = totalAvailable > scanItems.length

  let count = 0
  const sampleTitles: string[] = []

  for (const item of scanItems) {
    let matched = false
    try {
      if (referencesTags) {
        const itemWithTags = ItemWithTags.Create(item.payload, item as never, resolveTags(item))
        matched = predicate.matchesItem(itemWithTags as never)
      } else {
        matched = predicate.matchesItem(item)
      }
    } catch {
      matched = false
    }

    if (matched) {
      count++
      if (sampleTitles.length < sampleSize) {
        sampleTitles.push(readTitle(item))
      }
    }
  }

  return {
    status: 'ok',
    count,
    sampleTitles,
    scanned: scanItems.length,
    totalAvailable,
    limited,
  }
}
