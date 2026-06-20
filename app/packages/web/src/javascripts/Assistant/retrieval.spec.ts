import { retrieve, RetrievalDoc } from './retrieval'

const docs: RetrievalDoc[] = [
  { uuid: 'n1', title: 'Sourdough starter', text: 'Feed the starter with flour and water every day. Discard half before feeding.' },
  { uuid: 'n2', title: 'Tax notes', text: 'Quarterly estimated tax is due in April. Keep receipts for deductions.' },
  { uuid: 'n3', title: 'Bread recipe', text: 'Mix flour, water, salt and the active sourdough starter. Bake at 230C.' },
  { uuid: 'n4', title: 'Empty', text: '' },
]

describe('retrieve (BM25)', () => {
  it('ranks the most relevant notes first for a query', () => {
    const hits = retrieve(docs, 'sourdough starter feeding', { perNote: true })
    expect(hits.length).toBeGreaterThan(0)
    // The starter note is the most on-topic for feeding a sourdough starter.
    expect(hits[0].noteUuid).toBe('n1')
    // The tax note shares no query terms and must not appear.
    expect(hits.some((h) => h.noteUuid === 'n2')).toBe(false)
  })

  it('returns an empty array for an all-stopword or empty query', () => {
    expect(retrieve(docs, 'the and of to')).toEqual([])
    expect(retrieve(docs, '')).toEqual([])
  })

  it('respects the limit', () => {
    const hits = retrieve(docs, 'flour water', { limit: 1 })
    expect(hits.length).toBe(1)
  })

  it('collapses to one passage per note when perNote is set', () => {
    const hits = retrieve(docs, 'flour water starter', { perNote: true })
    const uuids = hits.map((h) => h.noteUuid)
    expect(new Set(uuids).size).toBe(uuids.length)
  })

  it('includes a snippet and a positive score for each hit', () => {
    const [hit] = retrieve(docs, 'bake bread', { perNote: true })
    expect(hit.score).toBeGreaterThan(0)
    expect(typeof hit.snippet).toBe('string')
    expect(hit.snippet.length).toBeGreaterThan(0)
  })

  it('rarer query terms outrank common ones (IDF)', () => {
    // "deductions" is rare (only n2); "water" is common (n1, n3). A query for the
    // rare term should surface its note.
    const hits = retrieve(docs, 'deductions', { perNote: true })
    expect(hits[0].noteUuid).toBe('n2')
  })
})
