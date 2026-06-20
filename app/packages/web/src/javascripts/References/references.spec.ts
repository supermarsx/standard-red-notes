import { SNNote } from '@standardnotes/snjs'
import {
  NoteReferenceKey,
  ReferenceItem,
  ReferenceMetadata,
  availableKinds,
  availableTags,
  availableYears,
  buildReferenceLibrary,
  citationString,
  filterReferences,
  getNoteReference,
  noteIsReference,
  normalizeReferenceMetadata,
  referencesToBibTeX,
  referencesToCSV,
  sortReferences,
} from './references'

/**
 * Minimal SNNote stub: reference metadata lives in appData, read via
 * getAppDomainValue. Mirrors the Reminders spec approach.
 */
const makeNote = (
  raw: unknown,
  overrides: Partial<Pick<SNNote, 'uuid' | 'title' | 'trashed'>> = {},
): SNNote =>
  ({
    uuid: overrides.uuid ?? 'note-1',
    title: overrides.title ?? 'A note',
    trashed: overrides.trashed ?? false,
    getAppDomainValue: (key: string) => (key === (NoteReferenceKey as unknown as string) ? raw : undefined),
  }) as unknown as SNNote

const ref = (metadata: Partial<ReferenceMetadata>, overrides: Partial<Pick<SNNote, 'uuid' | 'title' | 'trashed'>> = {}) =>
  makeNote({ isReference: true, ...metadata }, overrides)

const makeItem = (title: string, metadata: Partial<ReferenceMetadata>, uuid = 'u'): ReferenceItem => ({
  note: ref(metadata, { title, uuid }),
  uuid,
  title,
  metadata: { isReference: true, ...metadata },
})

/* -------------------------------------------------------------------------- */
/* normalize / read (backward-compat, never throws)                           */
/* -------------------------------------------------------------------------- */

describe('normalizeReferenceMetadata', () => {
  it('returns undefined for missing / non-object / non-reference data', () => {
    expect(normalizeReferenceMetadata(undefined)).toBeUndefined()
    expect(normalizeReferenceMetadata(null)).toBeUndefined()
    expect(normalizeReferenceMetadata('nope')).toBeUndefined()
    expect(normalizeReferenceMetadata(42)).toBeUndefined()
    expect(normalizeReferenceMetadata({})).toBeUndefined()
    expect(normalizeReferenceMetadata({ isReference: false, kind: 'book' })).toBeUndefined()
  })

  it('normalizes a full record', () => {
    const result = normalizeReferenceMetadata({
      isReference: true,
      kind: 'book',
      authors: ['Knuth, D.'],
      year: 1997,
      url: 'https://example.com',
      publisher: 'Addison-Wesley',
      tags: ['algorithms'],
      notes: 'classic',
    })
    expect(result).toEqual({
      isReference: true,
      kind: 'book',
      authors: ['Knuth, D.'],
      year: 1997,
      url: 'https://example.com',
      publisher: 'Addison-Wesley',
      tags: ['algorithms'],
      notes: 'classic',
    })
  })

  it('drops invalid/empty fields without throwing', () => {
    const result = normalizeReferenceMetadata({
      isReference: true,
      kind: 'made-up-kind',
      authors: ['  ', 42, 'Real Author'],
      year: 'not-a-year',
      url: '   ',
      tags: [],
      notes: '',
    })
    expect(result).toEqual({ isReference: true, authors: ['Real Author'] })
  })

  it('coerces a numeric-string year and floors floats; rejects out-of-range', () => {
    expect(normalizeReferenceMetadata({ isReference: true, year: '2020' })).toEqual({ isReference: true, year: 2020 })
    expect(normalizeReferenceMetadata({ isReference: true, year: 2020.9 })).toEqual({ isReference: true, year: 2020 })
    expect(normalizeReferenceMetadata({ isReference: true, year: 99999 })).toEqual({ isReference: true })
  })

  it('getNoteReference / noteIsReference read appData tolerantly', () => {
    expect(getNoteReference(makeNote(undefined))).toBeUndefined()
    expect(noteIsReference(makeNote(undefined))).toBe(false)
    const note = ref({ kind: 'article', year: 2021 })
    expect(getNoteReference(note)).toEqual({ isReference: true, kind: 'article', year: 2021 })
    expect(noteIsReference(note)).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* buildReferenceLibrary                                                       */
/* -------------------------------------------------------------------------- */

describe('buildReferenceLibrary', () => {
  it('includes only reference notes and skips trashed', () => {
    const notes = [
      ref({ kind: 'book' }, { uuid: 'a', title: 'Book A' }),
      makeNote(undefined, { uuid: 'b', title: 'Plain note' }),
      ref({ kind: 'article' }, { uuid: 'c', title: 'Trashed ref', trashed: true }),
    ]
    const library = buildReferenceLibrary(notes)
    expect(library.map((item) => item.uuid)).toEqual(['a'])
    expect(library[0].title).toBe('Book A')
    expect(library[0].metadata.kind).toBe('book')
  })

  it('falls back to "Untitled" for an empty title', () => {
    const library = buildReferenceLibrary([ref({}, { uuid: 'a', title: '   ' })])
    expect(library[0].title).toBe('Untitled')
  })
})

/* -------------------------------------------------------------------------- */
/* sort                                                                        */
/* -------------------------------------------------------------------------- */

describe('sortReferences', () => {
  const items = [
    makeItem('Banana', { year: 2010, kind: 'book', authors: ['Zed, A.'] }, '1'),
    makeItem('Apple', { year: 2020, kind: 'article', authors: ['Adams, B.'] }, '2'),
    makeItem('Cherry', { kind: 'web', authors: ['Mills, C.'] }, '3'),
  ]

  it('sorts by title asc/desc', () => {
    expect(sortReferences(items, 'title', 'asc').map((i) => i.title)).toEqual(['Apple', 'Banana', 'Cherry'])
    expect(sortReferences(items, 'title', 'desc').map((i) => i.title)).toEqual(['Cherry', 'Banana', 'Apple'])
  })

  it('sorts by year (missing year sorts lowest asc)', () => {
    expect(sortReferences(items, 'year', 'asc').map((i) => i.title)).toEqual(['Cherry', 'Banana', 'Apple'])
  })

  it('sorts by kind and authors', () => {
    // authors: Adams (Apple), Mills (Cherry), Zed (Banana)
    expect(sortReferences(items, 'kind', 'asc').map((i) => i.metadata.kind)).toEqual(['article', 'book', 'web'])
    expect(sortReferences(items, 'authors', 'asc').map((i) => i.title)).toEqual(['Apple', 'Cherry', 'Banana'])
  })

  it('does not mutate the input array', () => {
    const copy = [...items]
    sortReferences(items, 'title', 'desc')
    expect(items).toEqual(copy)
  })
})

/* -------------------------------------------------------------------------- */
/* filter / facets                                                            */
/* -------------------------------------------------------------------------- */

describe('filterReferences', () => {
  const items = [
    makeItem('Algorithms', { kind: 'book', year: 1997, tags: ['cs'], authors: ['Knuth, D.'], publisher: 'AW' }, '1'),
    makeItem('Deep Learning', { kind: 'book', year: 2016, tags: ['ml', 'cs'], authors: ['Goodfellow, I.'] }, '2'),
    makeItem('A Web Page', { kind: 'web', year: 2016, tags: ['blog'], url: 'https://foo.example' }, '3'),
  ]

  it('filters by kind', () => {
    expect(filterReferences(items, { kind: 'web' }).map((i) => i.title)).toEqual(['A Web Page'])
  })

  it('filters by tag', () => {
    expect(filterReferences(items, { tag: 'cs' }).map((i) => i.title)).toEqual(['Algorithms', 'Deep Learning'])
  })

  it('filters by year', () => {
    expect(filterReferences(items, { year: 2016 }).map((i) => i.title)).toEqual(['Deep Learning', 'A Web Page'])
  })

  it('searches across title/authors/publisher/url/notes/tags case-insensitively', () => {
    expect(filterReferences(items, { query: 'KNUTH' }).map((i) => i.title)).toEqual(['Algorithms'])
    expect(filterReferences(items, { query: 'foo.example' }).map((i) => i.title)).toEqual(['A Web Page'])
    expect(filterReferences(items, { query: 'blog' }).map((i) => i.title)).toEqual(['A Web Page'])
  })

  it('combines filters', () => {
    expect(filterReferences(items, { kind: 'book', year: 2016 }).map((i) => i.title)).toEqual(['Deep Learning'])
  })

  it('empty filter returns everything', () => {
    expect(filterReferences(items, {})).toHaveLength(3)
  })
})

describe('facets', () => {
  const items = [
    makeItem('A', { kind: 'web', year: 2020, tags: ['z', 'a'] }, '1'),
    makeItem('B', { kind: 'book', year: 2010, tags: ['a'] }, '2'),
    makeItem('C', {}, '3'),
  ]

  it('availableKinds returns present kinds in canonical order', () => {
    expect(availableKinds(items)).toEqual(['book', 'web'])
  })

  it('availableTags returns distinct sorted tags', () => {
    expect(availableTags(items)).toEqual(['a', 'z'])
  })

  it('availableYears returns distinct years descending', () => {
    expect(availableYears(items)).toEqual([2020, 2010])
  })
})

/* -------------------------------------------------------------------------- */
/* citation + export                                                          */
/* -------------------------------------------------------------------------- */

describe('citationString', () => {
  it('builds Author (Year). Title. Publisher.', () => {
    const item = makeItem('The Art of Computer Programming', {
      authors: ['Knuth, D.'],
      year: 1997,
      publisher: 'Addison-Wesley',
    })
    expect(citationString(item)).toBe('Knuth, D. (1997). The Art of Computer Programming. Addison-Wesley.')
  })

  it('degrades gracefully when fields are missing', () => {
    expect(citationString(makeItem('Just A Title', {}))).toBe('Just A Title.')
    expect(citationString(makeItem('Titled', { year: 2020 }))).toBe('(2020). Titled.')
  })

  it('joins multiple authors', () => {
    const item = makeItem('Deep Learning', { authors: ['Goodfellow, I.', 'Bengio, Y.'], year: 2016 })
    expect(citationString(item)).toBe('Goodfellow, I., Bengio, Y. (2016). Deep Learning.')
  })
})

describe('referencesToBibTeX', () => {
  it('emits a typed entry with fields and a stable key', () => {
    const out = referencesToBibTeX([
      makeItem('The Art of Computer Programming', {
        kind: 'book',
        authors: ['Knuth, D.'],
        year: 1997,
        publisher: 'Addison-Wesley',
        tags: ['cs'],
      }),
    ])
    expect(out).toContain('@book{Knuth1997The,')
    expect(out).toContain('title = {The Art of Computer Programming},')
    expect(out).toContain('author = {Knuth, D.},')
    expect(out).toContain('year = {1997},')
    expect(out).toContain('publisher = {Addison-Wesley},')
    expect(out).toContain('keywords = {cs},')
  })

  it('disambiguates duplicate keys', () => {
    const a = makeItem('Title', { authors: ['Smith, J.'], year: 2000 }, '1')
    const b = makeItem('Title', { authors: ['Smith, J.'], year: 2000 }, '2')
    const out = referencesToBibTeX([a, b])
    expect(out).toContain('@misc{Smith2000Title,')
    expect(out).toContain('@misc{Smith2000Titlea,')
  })
})

describe('referencesToCSV', () => {
  it('emits a header and quotes cells containing commas', () => {
    const out = referencesToCSV([
      makeItem('A, B', { kind: 'article', authors: ['X', 'Y'], year: 2021, tags: ['t1', 't2'] }),
    ])
    const [header, row] = out.split('\n')
    expect(header).toBe('Title,Authors,Year,Type,Publisher,URL,Tags,Notes')
    expect(row).toContain('"A, B"')
    expect(row).toContain('X; Y')
    expect(row).toContain('Article')
    expect(row).toContain('t1; t2')
  })
})
