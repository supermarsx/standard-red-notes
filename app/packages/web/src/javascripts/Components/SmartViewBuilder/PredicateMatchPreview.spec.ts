import { PredicateJsonForm } from '@standardnotes/snjs'
import { buildPreviewPredicate, evaluatePredicateMatches, PreviewItem } from './PredicateMatchPreview'

/**
 * The evaluator only reads keypaths off the item objects via `matchesItem`, so
 * for non-tag predicates plain objects shaped like items are sufficient to
 * exercise the real matching path.
 */
const makeItems = (partials: Record<string, unknown>[]): PreviewItem[] => partials as unknown as PreviewItem[]

const noTags = (): [] => []

describe('PredicateMatchPreview', () => {
  describe('buildPreviewPredicate', () => {
    it('returns null for undefined input', () => {
      expect(buildPreviewPredicate(undefined)).toBeNull()
    })

    it('returns a predicate for valid JSON', () => {
      expect(buildPreviewPredicate({ keypath: 'pinned', operator: '=', value: true })).not.toBeNull()
    })

    it('never throws on malformed predicate JSON', () => {
      // A "not" predicate whose value is not a valid nested predicate.
      const bad = { operator: 'not', value: 42 } as unknown as PredicateJsonForm
      expect(() => buildPreviewPredicate(bad)).not.toThrow()
    })
  })

  describe('evaluatePredicateMatches', () => {
    const items = makeItems([
      { title: 'Alpha', pinned: true },
      { title: 'Beta', pinned: false },
      { title: '', pinned: true },
    ])

    it('counts matching items and returns sample titles', () => {
      const json: PredicateJsonForm = {
        operator: 'and',
        value: [{ keypath: 'pinned', operator: '=', value: true }],
      }
      const result = evaluatePredicateMatches(json, items, noTags)
      expect(result.status).toBe('ok')
      expect(result.count).toBe(2)
      expect(result.sampleTitles).toContain('Alpha')
      // Empty titles are shown as a friendly placeholder.
      expect(result.sampleTitles).toContain('Untitled')
    })

    it('reports an error status (never throws) for an undefined predicate', () => {
      const result = evaluatePredicateMatches(undefined, items, noTags)
      expect(result.status).toBe('error')
      expect(result.count).toBe(0)
    })

    it('reports an error status for an unparseable predicate', () => {
      const bad = { operator: 'not', value: 42 } as unknown as PredicateJsonForm
      const result = evaluatePredicateMatches(bad, items, noTags)
      expect(result.status).toBe('error')
    })

    it('caps the scan and reports it as limited', () => {
      const many = makeItems(Array.from({ length: 10 }, (_, index) => ({ title: `n${index}`, pinned: true })))
      const json: PredicateJsonForm = { keypath: 'pinned', operator: '=', value: true }
      const result = evaluatePredicateMatches(json, many, noTags, { limit: 4, sampleSize: 2 })
      expect(result.scanned).toBe(4)
      expect(result.totalAvailable).toBe(10)
      expect(result.limited).toBe(true)
      expect(result.count).toBe(4)
      expect(result.sampleTitles).toHaveLength(2)
    })

    it('is resilient to tag-referencing predicates on items without payloads', () => {
      const json: PredicateJsonForm = {
        keypath: 'tags',
        operator: 'includes',
        value: { keypath: 'title', operator: '=', value: 'todo' },
      }
      // ItemWithTags construction will fail on these bare objects; the evaluator
      // must swallow that per-item and still return a usable result.
      expect(() => evaluatePredicateMatches(json, items, noTags)).not.toThrow()
      const result = evaluatePredicateMatches(json, items, noTags)
      expect(result.status).toBe('ok')
      expect(result.count).toBe(0)
    })
  })
})
