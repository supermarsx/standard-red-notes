import {
  KANBAN_DOCUMENT_VERSION,
  KanbanDocument,
  countCards,
  createEmptyKanbanDocument,
  parseKanbanDocument,
  serializeKanbanDocument,
} from './KanbanDocument'

describe('KanbanDocument', () => {
  describe('createEmptyKanbanDocument', () => {
    it('creates a versioned empty document', () => {
      expect(createEmptyKanbanDocument()).toEqual({ version: KANBAN_DOCUMENT_VERSION, title: '', columns: [] })
    })
  })

  describe('serialize/parse round-trip', () => {
    it('round-trips a populated board without data loss', () => {
      const original: KanbanDocument = {
        version: KANBAN_DOCUMENT_VERSION,
        title: 'Sprint',
        columns: [
          {
            id: 'c1',
            title: 'To Do',
            color: '#ef4444',
            cards: [
              { id: 'k1', text: 'First' },
              { id: 'k2', text: 'Second' },
            ],
          },
          { id: 'c2', title: 'Done', cards: [] },
        ],
      }
      const { document, recovered } = parseKanbanDocument(serializeKanbanDocument(original))
      expect(recovered).toBe(true)
      expect(document).toEqual(original)
    })

    it('keeps column color undefined when absent', () => {
      const original = createEmptyKanbanDocument()
      original.columns.push({ id: 'c1', title: 'A', cards: [] })
      const { document } = parseKanbanDocument(serializeKanbanDocument(original))
      expect(document.columns[0].color).toBeUndefined()
    })
  })

  describe('malformed and legacy input fallback', () => {
    it('returns an empty (recoverable) document for empty string', () => {
      const { document, recovered } = parseKanbanDocument('')
      expect(document).toEqual(createEmptyKanbanDocument())
      expect(recovered).toBe(true)
    })

    it('returns an empty document and flags non-recovery for invalid JSON', () => {
      const { document, recovered } = parseKanbanDocument('{nope}')
      expect(document).toEqual(createEmptyKanbanDocument())
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for legacy plain text', () => {
      const { document, recovered } = parseKanbanDocument('plain note text')
      expect(document.columns).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('returns an empty document and flags non-recovery for a non-kanban object', () => {
      const { document, recovered } = parseKanbanDocument(JSON.stringify({ root: { children: [] } }))
      expect(document.columns).toHaveLength(0)
      expect(recovered).toBe(false)
    })

    it('never throws on null or undefined', () => {
      expect(() => parseKanbanDocument(null)).not.toThrow()
      expect(() => parseKanbanDocument(undefined)).not.toThrow()
    })
  })

  describe('column/card sanitization', () => {
    it('drops columns without a valid id', () => {
      const { document } = parseKanbanDocument(
        JSON.stringify({ columns: [{ title: 'x', cards: [] }, { id: 'ok', title: 'y', cards: [] }] }),
      )
      expect(document.columns).toHaveLength(1)
      expect(document.columns[0].id).toBe('ok')
    })

    it('drops cards without a valid id', () => {
      const { document } = parseKanbanDocument(
        JSON.stringify({ columns: [{ id: 'c1', cards: [{ text: 'x' }, { id: 'k1', text: 'y' }] }] }),
      )
      expect(document.columns[0].cards).toHaveLength(1)
      expect(document.columns[0].cards[0].id).toBe('k1')
    })

    it('de-duplicates columns and cards by id', () => {
      const { document } = parseKanbanDocument(
        JSON.stringify({
          columns: [
            { id: 'dup', title: 'first', cards: [{ id: 'card', text: 'a' }, { id: 'card', text: 'b' }] },
            { id: 'dup', title: 'second', cards: [] },
          ],
        }),
      )
      expect(document.columns).toHaveLength(1)
      expect(document.columns[0].title).toBe('first')
      expect(document.columns[0].cards).toHaveLength(1)
      expect(document.columns[0].cards[0].text).toBe('a')
    })

    it('coerces missing card text and column title to empty strings', () => {
      const { document } = parseKanbanDocument(
        JSON.stringify({ columns: [{ id: 'c1', cards: [{ id: 'k1' }] }] }),
      )
      expect(document.columns[0].title).toBe('')
      expect(document.columns[0].cards[0].text).toBe('')
    })

    it('tolerates a missing cards array', () => {
      const { document } = parseKanbanDocument(JSON.stringify({ columns: [{ id: 'c1', title: 'A' }] }))
      expect(document.columns[0].cards).toEqual([])
    })
  })

  describe('countCards', () => {
    it('totals cards across columns', () => {
      const doc: KanbanDocument = {
        version: KANBAN_DOCUMENT_VERSION,
        title: '',
        columns: [
          { id: 'a', title: '', cards: [{ id: '1', text: '' }, { id: '2', text: '' }] },
          { id: 'b', title: '', cards: [{ id: '3', text: '' }] },
        ],
      }
      expect(countCards(doc)).toBe(3)
    })
  })
})
