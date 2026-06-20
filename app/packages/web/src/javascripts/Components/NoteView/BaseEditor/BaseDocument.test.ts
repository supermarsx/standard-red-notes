import {
  BASE_DOCUMENT_VERSION,
  BaseDocument,
  createEmptyBaseDocument,
  parseBaseDocument,
  serializeBaseDocument,
} from './BaseDocument'

describe('BaseDocument', () => {
  describe('createEmptyBaseDocument', () => {
    it('creates a versioned default document with a usable column set', () => {
      const doc = createEmptyBaseDocument()
      expect(doc.version).toBe(BASE_DOCUMENT_VERSION)
      expect(doc.source).toEqual({ kind: 'all' })
      expect(doc.columns.length).toBeGreaterThan(0)
      expect(doc.filters).toEqual([])
      expect(doc.sort).toEqual({ columnId: 'updatedAt', dir: 'desc' })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated definition without data loss', () => {
      const original: BaseDocument = {
        version: BASE_DOCUMENT_VERSION,
        source: { kind: 'tag', uuid: 'tag-123' },
        columns: [
          { id: 'c1', kind: 'builtin', property: 'title' },
          { id: 'c2', kind: 'builtin', property: 'wordCount', label: 'Length' },
          { id: 'c3', kind: 'parsed', key: 'status' },
        ],
        filters: [
          { id: 'f1', target: 'title', operator: 'contains', value: 'todo' },
          { id: 'f2', target: 'pinned', operator: 'isTrue' },
          { id: 'f3', target: 'parsed:status', operator: 'equals', value: 'open' },
        ],
        sort: { columnId: 'c2', dir: 'asc' },
      }

      const { document, recovered } = parseBaseDocument(serializeBaseDocument(original))
      expect(recovered).toBe(true)
      expect(document.source).toEqual(original.source)
      expect(document.columns).toEqual(original.columns)
      // value:undefined is dropped on boolean filters during serialization
      expect(document.filters[1]).toEqual({ id: 'f2', target: 'pinned', operator: 'isTrue', value: undefined })
      expect(document.filters[0]).toEqual(original.filters[0])
      expect(document.sort).toEqual(original.sort)
    })

    it('drops a uuid for the all-notes source', () => {
      const doc = createEmptyBaseDocument()
      const { document } = parseBaseDocument(serializeBaseDocument(doc))
      expect(document.source).toEqual({ kind: 'all' })
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns a default (recoverable) document for empty string', () => {
      const { document, recovered } = parseBaseDocument('')
      expect(document).toEqual(createEmptyBaseDocument())
      expect(recovered).toBe(true)
    })

    it('returns a default document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseBaseDocument('{not valid json}')
      expect(document).toEqual(createEmptyBaseDocument())
      expect(recovered).toBe(false)
    })

    it('returns a default document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseBaseDocument('This is just a plain note.')
      expect(document).toEqual(createEmptyBaseDocument())
      expect(recovered).toBe(false)
    })

    it('returns a default document and flags non-recovery for a non-base JSON object', () => {
      const { document, recovered } = parseBaseDocument(JSON.stringify({ root: { children: [] } }))
      expect(document).toEqual(createEmptyBaseDocument())
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseBaseDocument(null)).not.toThrow()
      expect(() => parseBaseDocument(undefined)).not.toThrow()
    })
  })

  describe('sanitization', () => {
    it('drops invalid columns and de-duplicates by id', () => {
      const { document } = parseBaseDocument(
        JSON.stringify({
          source: { kind: 'all' },
          columns: [
            { id: 'a', kind: 'builtin', property: 'title' },
            { id: 'a', kind: 'builtin', property: 'starred' },
            { id: 'b', kind: 'builtin', property: 'notAProperty' },
            { id: 'c', kind: 'parsed' },
            { id: 'd', kind: 'parsed', key: 'status' },
            { kind: 'builtin', property: 'title' },
          ],
          filters: [],
          sort: { dir: 'asc' },
        }),
      )
      expect(document.columns.map((c) => c.id)).toEqual(['a', 'd'])
      expect(document.columns[0].property).toBe('title')
    })

    it('falls back to default columns when none survive', () => {
      const { document, recovered } = parseBaseDocument(
        JSON.stringify({ source: { kind: 'all' }, columns: [{ bad: true }], filters: [], sort: { dir: 'asc' } }),
      )
      expect(recovered).toBe(true)
      expect(document.columns).toEqual(createEmptyBaseDocument().columns)
    })

    it('drops invalid filters and unknown operators', () => {
      const { document } = parseBaseDocument(
        JSON.stringify({
          source: { kind: 'all' },
          columns: [{ id: 'c1', kind: 'builtin', property: 'title' }],
          filters: [
            { id: 'f1', target: 'title', operator: 'contains', value: 'x' },
            { id: 'f2', target: 'title', operator: 'bogus' },
            { id: 'f3', operator: 'equals' },
          ],
          sort: { dir: 'asc' },
        }),
      )
      expect(document.filters.map((f) => f.id)).toEqual(['f1'])
    })

    it('clears a sort columnId that does not reference an existing column', () => {
      const { document } = parseBaseDocument(
        JSON.stringify({
          source: { kind: 'all' },
          columns: [{ id: 'c1', kind: 'builtin', property: 'title' }],
          filters: [],
          sort: { columnId: 'gone', dir: 'asc' },
        }),
      )
      expect(document.sort).toEqual({ columnId: undefined, dir: 'asc' })
    })

    it('coerces an invalid source kind to all', () => {
      const { document } = parseBaseDocument(
        JSON.stringify({
          source: { kind: 'galaxy', uuid: 'x' },
          columns: [{ id: 'c1', kind: 'builtin', property: 'title' }],
          filters: [],
          sort: { dir: 'desc' },
        }),
      )
      expect(document.source).toEqual({ kind: 'all' })
    })
  })
})
