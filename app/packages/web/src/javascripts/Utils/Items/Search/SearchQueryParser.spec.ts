import {
  buildQueryFromOptions,
  buildSearchPredicate,
  emptyAdvancedSearchOptions,
  parseAdvancedSearchOptions,
  parseSearchQuery,
  SearchableNote,
} from './SearchQueryParser'

const baseNote = (overrides: Partial<SearchableNote> = {}): SearchableNote => ({
  title: '',
  text: '',
  noteType: 'plain-text',
  tagTitles: [],
  protected: false,
  pinned: false,
  archived: false,
  starred: false,
  trashed: false,
  locked: false,
  hasFiles: false,
  createdAt: Date.parse('2024-06-15'),
  updatedAt: Date.parse('2024-06-15'),
  ...overrides,
})

describe('parseSearchQuery', () => {
  it('treats a plain query as free text only', () => {
    const parsed = parseSearchQuery('meeting notes')
    expect(parsed.hasOperators).toBe(false)
    expect(parsed.freeText).toBe('meeting notes')
    expect(parsed.operators).toHaveLength(0)
  })

  it('parses a tag operator and leaves free text', () => {
    const parsed = parseSearchQuery('tag:work meeting')
    expect(parsed.operators).toEqual([{ kind: 'tag', value: 'work', negated: false }])
    expect(parsed.freeText).toBe('meeting')
  })

  it('parses topic: as an alias of tag:', () => {
    expect(parseSearchQuery('topic:work').operators[0]).toEqual({ kind: 'tag', value: 'work', negated: false })
    expect(parseSearchQuery('-topic:work').operators[0]).toEqual({ kind: 'tag', value: 'work', negated: true })
    // tag: must keep working identically.
    expect(parseSearchQuery('tag:work').operators[0]).toEqual(parseSearchQuery('topic:work').operators[0])
  })

  it('filters by topic: identically to tag:', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('topic:work'))
    expect(predicate(baseNote({ tagTitles: ['Work'] }))).toBe(true)
    expect(predicate(baseNote({ tagTitles: ['Home'] }))).toBe(false)
  })

  it('parses type and editor as the same operator kind', () => {
    expect(parseSearchQuery('type:super').operators[0]).toEqual({ kind: 'type', value: 'super', negated: false })
    expect(parseSearchQuery('editor:code').operators[0]).toEqual({ kind: 'type', value: 'code', negated: false })
  })

  it('parses is: flags', () => {
    expect(parseSearchQuery('is:pinned').operators[0]).toEqual({ kind: 'is', flag: 'pinned', negated: false })
    expect(parseSearchQuery('is:starred').operators[0]).toEqual({ kind: 'is', flag: 'starred', negated: false })
  })

  it('parses has:files and its aliases', () => {
    expect(parseSearchQuery('has:files').operators[0]).toEqual({ kind: 'has', subject: 'files', negated: false })
    expect(parseSearchQuery('has:attachments').operators[0]).toEqual({ kind: 'has', subject: 'files', negated: false })
    expect(parseSearchQuery('-has:files').operators[0]).toEqual({ kind: 'has', subject: 'files', negated: true })
  })

  it('treats an unknown has: subject as free text', () => {
    const parsed = parseSearchQuery('has:banana')
    expect(parsed.hasOperators).toBe(false)
    expect(parsed.freeText).toBe('has:banana')
  })

  it('parses in:title and in:content', () => {
    expect(parseSearchQuery('in:title').operators[0]).toEqual({ kind: 'in', scope: 'title', negated: false })
    expect(parseSearchQuery('in:content').operators[0]).toEqual({ kind: 'in', scope: 'content', negated: false })
  })

  it('parses date operators with comparators', () => {
    const created = parseSearchQuery('created:>2024-01-01').operators[0]
    expect(created).toMatchObject({ kind: 'created', comparator: '>' })
    const updated = parseSearchQuery('updated:<2025-01-01').operators[0]
    expect(updated).toMatchObject({ kind: 'updated', comparator: '<' })
  })

  it('parses negation', () => {
    expect(parseSearchQuery('-tag:foo').operators[0]).toEqual({ kind: 'tag', value: 'foo', negated: true })
  })

  it('parses quoted phrases as free text and keeps spaces', () => {
    const parsed = parseSearchQuery('"quarterly budget" tag:work')
    expect(parsed.freeTextTerms).toContainEqual({ value: 'quarterly budget', negated: false })
    expect(parsed.operators).toEqual([{ kind: 'tag', value: 'work', negated: false }])
  })

  it('parses negated quoted phrases', () => {
    const parsed = parseSearchQuery('-"draft only"')
    expect(parsed.freeTextTerms).toContainEqual({ value: 'draft only', negated: true })
    // Negated free text is excluded from the joined freeText string.
    expect(parsed.freeText).toBe('')
  })

  it('treats unknown operators as free text (forgiving)', () => {
    const parsed = parseSearchQuery('foo:bar hello')
    expect(parsed.hasOperators).toBe(false)
    expect(parsed.freeText).toBe('foo:bar hello')
  })

  it('treats an unknown is: flag as free text', () => {
    const parsed = parseSearchQuery('is:banana')
    expect(parsed.hasOperators).toBe(false)
    expect(parsed.freeText).toBe('is:banana')
  })

  it('combines multiple operators with free text', () => {
    const parsed = parseSearchQuery('tag:work is:pinned meeting')
    expect(parsed.operators).toHaveLength(2)
    expect(parsed.freeText).toBe('meeting')
  })
})

describe('buildSearchPredicate', () => {
  it('matches everything for an empty query', () => {
    const predicate = buildSearchPredicate(parseSearchQuery(''))
    expect(predicate(baseNote())).toBe(true)
  })

  it('filters by tag', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('tag:work'))
    expect(predicate(baseNote({ tagTitles: ['Work'] }))).toBe(true)
    expect(predicate(baseNote({ tagTitles: ['Home'] }))).toBe(false)
  })

  it('honors negated tag', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('-tag:work'))
    expect(predicate(baseNote({ tagTitles: ['Work'] }))).toBe(false)
    expect(predicate(baseNote({ tagTitles: ['Home'] }))).toBe(true)
  })

  it('filters by type/editor', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('type:super'))
    expect(predicate(baseNote({ noteType: 'super' }))).toBe(true)
    expect(predicate(baseNote({ noteType: 'plain-text' }))).toBe(false)
  })

  it('filters by is: flag', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('is:protected'))
    expect(predicate(baseNote({ protected: true }))).toBe(true)
    expect(predicate(baseNote({ protected: false }))).toBe(false)
  })

  it('filters by has:files (and negation)', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('has:files'))
    expect(predicate(baseNote({ hasFiles: true }))).toBe(true)
    expect(predicate(baseNote({ hasFiles: false }))).toBe(false)

    const negated = buildSearchPredicate(parseSearchQuery('-has:files'))
    expect(negated(baseNote({ hasFiles: true }))).toBe(false)
    expect(negated(baseNote({ hasFiles: false }))).toBe(true)
  })

  it('handles created:> and updated:< comparisons', () => {
    const afterPredicate = buildSearchPredicate(parseSearchQuery('created:>2024-01-01'))
    expect(afterPredicate(baseNote({ createdAt: Date.parse('2024-06-15') }))).toBe(true)
    expect(afterPredicate(baseNote({ createdAt: Date.parse('2023-06-15') }))).toBe(false)

    const beforePredicate = buildSearchPredicate(parseSearchQuery('updated:<2025-01-01'))
    expect(beforePredicate(baseNote({ updatedAt: Date.parse('2024-06-15') }))).toBe(true)
    expect(beforePredicate(baseNote({ updatedAt: Date.parse('2025-06-15') }))).toBe(false)
  })

  it('restricts free text to title with in:title', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('in:title budget'))
    expect(predicate(baseNote({ title: 'budget plan', text: 'unrelated' }))).toBe(true)
    expect(predicate(baseNote({ title: 'plan', text: 'the budget body' }))).toBe(false)
  })

  it('restricts free text to content with in:content', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('in:content budget'))
    expect(predicate(baseNote({ title: 'budget plan', text: 'unrelated' }))).toBe(false)
    expect(predicate(baseNote({ title: 'plan', text: 'the budget body' }))).toBe(true)
  })

  it('matches free text across title and body by default', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('budget'))
    expect(predicate(baseNote({ title: 'budget plan' }))).toBe(true)
    expect(predicate(baseNote({ text: 'the budget body' }))).toBe(true)
    expect(predicate(baseNote({ title: 'nope', text: 'nope' }))).toBe(false)
  })

  it('matches quoted phrases verbatim', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('"quarterly budget"'))
    expect(predicate(baseNote({ text: 'the quarterly budget review' }))).toBe(true)
    expect(predicate(baseNote({ text: 'budget quarterly' }))).toBe(false)
  })

  it('excludes notes containing a negated free-text phrase', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('budget -draft'))
    expect(predicate(baseNote({ text: 'budget final' }))).toBe(true)
    expect(predicate(baseNote({ text: 'budget draft' }))).toBe(false)
  })

  it('is case-insensitive by default and case-sensitive when requested', () => {
    const insensitive = buildSearchPredicate(parseSearchQuery('Budget'))
    expect(insensitive(baseNote({ text: 'budget' }))).toBe(true)

    const sensitive = buildSearchPredicate(parseSearchQuery('Budget'), { caseSensitive: true })
    expect(sensitive(baseNote({ text: 'budget' }))).toBe(false)
    expect(sensitive(baseNote({ text: 'Budget' }))).toBe(true)
  })

  it('combines operators with free text (AND semantics)', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('tag:work is:pinned meeting'))
    expect(predicate(baseNote({ tagTitles: ['work'], pinned: true, text: 'team meeting' }))).toBe(true)
    expect(predicate(baseNote({ tagTitles: ['work'], pinned: false, text: 'team meeting' }))).toBe(false)
    expect(predicate(baseNote({ tagTitles: ['home'], pinned: true, text: 'team meeting' }))).toBe(false)
    expect(predicate(baseNote({ tagTitles: ['work'], pinned: true, text: 'nothing here' }))).toBe(false)
  })

  it('unknown operator falls through to free text and still matches', () => {
    const predicate = buildSearchPredicate(parseSearchQuery('foo:bar'))
    expect(predicate(baseNote({ text: 'a foo:bar literal' }))).toBe(true)
    expect(predicate(baseNote({ text: 'unrelated' }))).toBe(false)
  })
})

describe('advanced options serialization', () => {
  it('builds a query string from structured options', () => {
    const options = emptyAdvancedSearchOptions()
    options.tags = ['work']
    options.notTags = ['archive']
    options.type = 'super'
    options.scope = 'title'
    options.flags.pinned = true
    options.createdAfter = '2024-01-01'
    options.freeText = 'meeting'
    const query = buildQueryFromOptions(options)
    expect(query).toContain('tag:work')
    expect(query).toContain('-tag:archive')
    expect(query).toContain('type:super')
    expect(query).toContain('in:title')
    expect(query).toContain('is:pinned')
    expect(query).toContain('created:>2024-01-01')
    expect(query).toContain('meeting')
  })

  it('quotes tag values containing spaces', () => {
    const options = emptyAdvancedSearchOptions()
    options.tags = ['my project']
    expect(buildQueryFromOptions(options)).toContain('tag:"my project"')
  })

  it('round-trips options through a query string', () => {
    const options = emptyAdvancedSearchOptions()
    options.tags = ['work']
    options.type = 'code'
    options.scope = 'content'
    options.flags.protected = true
    options.hasFiles = true
    options.updatedBefore = '2025-01-01'
    options.freeText = 'budget'
    const query = buildQueryFromOptions(options)
    expect(query).toContain('has:files')
    const reparsed = parseAdvancedSearchOptions(query)
    expect(reparsed.tags).toEqual(['work'])
    expect(reparsed.type).toBe('code')
    expect(reparsed.scope).toBe('content')
    expect(reparsed.flags.protected).toBe(true)
    expect(reparsed.hasFiles).toBe(true)
    expect(reparsed.updatedBefore).toBe('2025-01-01')
    expect(reparsed.freeText).toBe('budget')
  })
})
