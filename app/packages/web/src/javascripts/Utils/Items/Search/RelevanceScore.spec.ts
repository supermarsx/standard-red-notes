import { rankNotesByRelevance, relevanceTokenize, scoreNoteRelevance } from './RelevanceScore'

describe('relevanceTokenize', () => {
  it('lowercases and keeps alphanumeric runs longer than one char', () => {
    expect(relevanceTokenize('Hello, World! a 42')).toEqual(['hello', 'world', '42'])
  })
})

describe('scoreNoteRelevance', () => {
  it('returns 0 when the query has no indexable tokens', () => {
    expect(scoreNoteRelevance({ title: 'Anything', text: 'body' }, '!')).toBe(0)
  })

  it('returns 0 when the note matches none of the query terms', () => {
    expect(scoreNoteRelevance({ title: 'Groceries', text: 'milk and eggs' }, 'taxes')).toBe(0)
  })

  it('matches a query term that only appears in the body (full-text)', () => {
    expect(scoreNoteRelevance({ title: 'Untitled', text: 'the quarterly budget review' }, 'budget')).toBeGreaterThan(0)
  })

  it('scores a title hit higher than a body hit for the same term', () => {
    const titleHit = scoreNoteRelevance({ title: 'Budget plan', text: 'unrelated body' }, 'budget')
    const bodyHit = scoreNoteRelevance({ title: 'Plan', text: 'this is the budget body' }, 'budget')
    expect(titleHit).toBeGreaterThan(bodyHit)
  })

  it('ranks an exact whole-word match above a fuzzy substring match', () => {
    const exact = scoreNoteRelevance({ title: '', text: 'cat sat' }, 'cat')
    const fuzzy = scoreNoteRelevance({ title: '', text: 'category theory' }, 'cat')
    expect(exact).toBeGreaterThan(fuzzy)
  })

  it('rewards covering more distinct query terms over repeating one term', () => {
    const bothTerms = scoreNoteRelevance({ title: '', text: 'flour and water' }, 'flour water')
    const oneTermRepeated = scoreNoteRelevance({ title: '', text: 'flour flour flour flour' }, 'flour water')
    expect(bothTerms).toBeGreaterThan(oneTermRepeated)
  })
})

describe('rankNotesByRelevance', () => {
  const notes = [
    { uuid: 'body', title: 'Untitled', text: 'a note about the budget for next year' },
    { uuid: 'title', title: 'Budget overview', text: 'unrelated content here' },
    { uuid: 'none', title: 'Recipes', text: 'flour, water, salt' },
  ]

  it('drops notes that do not match and ranks title hits above body hits', () => {
    const ranked = rankNotesByRelevance(notes, 'budget')
    expect(ranked).toEqual(['title', 'body'])
    expect(ranked).not.toContain('none')
  })

  it('ranks broader term coverage first', () => {
    const coverageNotes = [
      { uuid: 'one', title: '', text: 'sourdough sourdough sourdough' },
      { uuid: 'two', title: '', text: 'sourdough starter recipe' },
    ]
    const ranked = rankNotesByRelevance(coverageNotes, 'sourdough starter')
    expect(ranked[0]).toBe('two')
  })

  it('returns an empty array when nothing matches', () => {
    expect(rankNotesByRelevance(notes, 'spaceship')).toEqual([])
  })
})
