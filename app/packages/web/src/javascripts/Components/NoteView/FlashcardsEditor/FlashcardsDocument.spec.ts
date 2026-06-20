import {
  FLASHCARDS_DOCUMENT_VERSION,
  Flashcard,
  countKnownCards,
  createEmptyFlashcardsDocument,
  orderCardsForStudy,
  parseFlashcardsDocument,
  serializeFlashcardsDocument,
} from './FlashcardsDocument'

describe('FlashcardsDocument', () => {
  describe('parseFlashcardsDocument', () => {
    it('returns an empty deck (recovered) for empty/whitespace/null/undefined', () => {
      for (const input of ['', '   ', null, undefined]) {
        const { document, recovered } = parseFlashcardsDocument(input)
        expect(document.cards).toEqual([])
        expect(document.version).toBe(FLASHCARDS_DOCUMENT_VERSION)
        expect(recovered).toBe(true)
      }
    })

    it('never throws on malformed JSON and reports not-recovered', () => {
      const { document, recovered } = parseFlashcardsDocument('{not valid json')
      expect(document.cards).toEqual([])
      expect(recovered).toBe(false)
    })

    it('treats non-flashcards JSON (no cards array) as a fresh deck, not-recovered', () => {
      const { document, recovered } = parseFlashcardsDocument(JSON.stringify({ columns: [] }))
      expect(document.cards).toEqual([])
      expect(recovered).toBe(false)
    })

    it('parses a valid deck and keeps optional metadata', () => {
      const text = JSON.stringify({
        version: 1,
        cards: [{ id: 'a', front: 'Q', back: 'A', knownCount: 2, lastReviewed: 12345 }],
      })
      const { document, recovered } = parseFlashcardsDocument(text)
      expect(recovered).toBe(true)
      expect(document.cards).toEqual([{ id: 'a', front: 'Q', back: 'A', knownCount: 2, lastReviewed: 12345 }])
    })

    it('normalizes missing front/back to empty strings and drops cards without ids', () => {
      const text = JSON.stringify({
        cards: [{ id: 'a' }, { front: 'no id' }, { id: '', front: 'empty id' }],
      })
      const { document } = parseFlashcardsDocument(text)
      expect(document.cards).toEqual([{ id: 'a', front: '', back: '' }])
    })

    it('dedupes cards with duplicate ids (first wins)', () => {
      const text = JSON.stringify({
        cards: [
          { id: 'dup', front: 'first', back: '1' },
          { id: 'dup', front: 'second', back: '2' },
        ],
      })
      const { document } = parseFlashcardsDocument(text)
      expect(document.cards).toHaveLength(1)
      expect(document.cards[0].front).toBe('first')
    })

    it('ignores invalid knownCount/lastReviewed values (backward/forward compat)', () => {
      const text = JSON.stringify({
        cards: [{ id: 'a', front: 'Q', back: 'A', knownCount: -3, lastReviewed: 'soon' }],
      })
      const { document } = parseFlashcardsDocument(text)
      expect(document.cards[0]).toEqual({ id: 'a', front: 'Q', back: 'A' })
    })

    it('floors fractional knownCount', () => {
      const text = JSON.stringify({ cards: [{ id: 'a', front: 'Q', back: 'A', knownCount: 2.9 }] })
      const { document } = parseFlashcardsDocument(text)
      expect(document.cards[0].knownCount).toBe(2)
    })

    it('preserves an unknown future version number', () => {
      const text = JSON.stringify({ version: 99, cards: [] })
      const { document } = parseFlashcardsDocument(text)
      expect(document.version).toBe(99)
    })
  })

  describe('serializeFlashcardsDocument round-trip', () => {
    it('round-trips a deck with and without metadata', () => {
      const original = {
        version: FLASHCARDS_DOCUMENT_VERSION,
        cards: [
          { id: 'a', front: 'Q1', back: 'A1', knownCount: 3, lastReviewed: 1000 },
          { id: 'b', front: 'Q2', back: 'A2' } as Flashcard,
        ],
      }
      const { document } = parseFlashcardsDocument(serializeFlashcardsDocument(original))
      expect(document).toEqual(original)
    })

    it('omits undefined metadata keys in serialized output', () => {
      const json = serializeFlashcardsDocument({
        version: 1,
        cards: [{ id: 'a', front: 'Q', back: 'A' }],
      })
      const parsed = JSON.parse(json)
      expect(parsed.cards[0]).toEqual({ id: 'a', front: 'Q', back: 'A' })
      expect('knownCount' in parsed.cards[0]).toBe(false)
    })

    it('serializes an empty deck cleanly', () => {
      const json = serializeFlashcardsDocument(createEmptyFlashcardsDocument())
      expect(JSON.parse(json)).toEqual({ version: FLASHCARDS_DOCUMENT_VERSION, cards: [] })
    })
  })

  describe('countKnownCards', () => {
    it('counts cards with a positive knownCount', () => {
      const doc = {
        version: 1,
        cards: [
          { id: 'a', front: '', back: '', knownCount: 2 },
          { id: 'b', front: '', back: '', knownCount: 0 },
          { id: 'c', front: '', back: '' },
        ],
      }
      expect(countKnownCards(doc)).toBe(1)
    })
  })

  describe('orderCardsForStudy', () => {
    it('prioritizes lower knownCount first (Again / never-gotten bubble up)', () => {
      const cards: Flashcard[] = [
        { id: 'known', front: '', back: '', knownCount: 5 },
        { id: 'again', front: '', back: '', knownCount: 0 },
        { id: 'mid', front: '', back: '', knownCount: 2 },
      ]
      expect(orderCardsForStudy(cards).map((c) => c.id)).toEqual(['again', 'mid', 'known'])
    })

    it('tie-breaks equal knownCount by least-recently-reviewed first', () => {
      const cards: Flashcard[] = [
        { id: 'recent', front: '', back: '', knownCount: 1, lastReviewed: 2000 },
        { id: 'old', front: '', back: '', knownCount: 1, lastReviewed: 1000 },
        { id: 'never', front: '', back: '', knownCount: 1 },
      ]
      expect(orderCardsForStudy(cards).map((c) => c.id)).toEqual(['never', 'old', 'recent'])
    })

    it('is stable on full ties (preserves original deck order)', () => {
      const cards: Flashcard[] = [
        { id: 'x', front: '', back: '' },
        { id: 'y', front: '', back: '' },
        { id: 'z', front: '', back: '' },
      ]
      expect(orderCardsForStudy(cards).map((c) => c.id)).toEqual(['x', 'y', 'z'])
    })

    it('does not mutate the input array', () => {
      const cards: Flashcard[] = [
        { id: 'a', front: '', back: '', knownCount: 5 },
        { id: 'b', front: '', back: '', knownCount: 0 },
      ]
      orderCardsForStudy(cards)
      expect(cards.map((c) => c.id)).toEqual(['a', 'b'])
    })
  })
})
