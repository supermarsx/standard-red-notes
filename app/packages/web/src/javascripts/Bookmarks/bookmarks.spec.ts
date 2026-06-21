import { SNNote } from '@standardnotes/snjs'
import {
  AggregatedBookmark,
  Bookmark,
  BookmarkAnchor,
  DEFAULT_BOOKMARK_LABEL,
  NoteBookmarksKey,
  SNIPPET_RADIUS,
  capturePlainAnchor,
  clampOffset,
  collectAllBookmarks,
  filterBookmarks,
  generateBookmarkId,
  getNoteBookmarks,
  noteHasBookmark,
  normalizeAnchor,
  normalizeBookmark,
  relocateBySnippet,
  removeBookmark,
  updateBookmark,
  upsertBookmark,
} from './bookmarks'

/**
 * Minimal SNNote stub exposing `getAppDomainValue`, `title`, and `trashed`,
 * mirroring the reminders spec approach.
 */
const makeNote = (values: Record<string, unknown>, title = '', trashed = false): SNNote =>
  ({
    title,
    trashed,
    getAppDomainValue: (key: string) => values[key],
  }) as unknown as SNNote

const superAnchor = (overrides: Partial<{ bookmarkId: string; nodeKey: string; scrollTop: number }> = {}): BookmarkAnchor => ({
  kind: 'super',
  bookmarkId: 'anchor-1',
  ...overrides,
})

const bookmark = (overrides: Partial<Bookmark> = {}): Bookmark => ({
  id: 'b1',
  label: 'My spot',
  anchor: superAnchor(),
  createdAt: '2026-06-20T12:00:00.000Z',
  ...overrides,
})

describe('bookmarks appData read (never throws / backward-compat)', () => {
  it('returns an empty array when nothing is stored', () => {
    expect(getNoteBookmarks(makeNote({}))).toEqual([])
  })

  it('returns an empty array for legacy/non-array values', () => {
    expect(getNoteBookmarks(makeNote({ [NoteBookmarksKey as unknown as string]: 'oops' }))).toEqual([])
    expect(getNoteBookmarks(makeNote({ [NoteBookmarksKey as unknown as string]: 42 }))).toEqual([])
    expect(getNoteBookmarks(makeNote({ [NoteBookmarksKey as unknown as string]: null }))).toEqual([])
  })

  it('reads valid bookmarks from the note app-domain bag', () => {
    const stored = [bookmark()]
    const note = makeNote({ [NoteBookmarksKey as unknown as string]: stored })
    expect(getNoteBookmarks(note)).toEqual(stored)
  })

  it('filters out malformed entries but keeps valid ones', () => {
    const valid = bookmark()
    const stored = [
      valid,
      null,
      'string',
      { id: 'no-anchor' }, // missing anchor
      { anchor: superAnchor() }, // missing id
      { id: 'bad-anchor', anchor: { kind: 'mystery' } },
    ]
    const note = makeNote({ [NoteBookmarksKey as unknown as string]: stored })
    const result = getNoteBookmarks(note)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('b1')
  })

  it('defaults a missing/blank label and a bad createdAt without throwing', () => {
    const stored = [{ id: 'x', anchor: superAnchor(), label: '   ', createdAt: 'not-a-date' }]
    const note = makeNote({ [NoteBookmarksKey as unknown as string]: stored })
    const [result] = getNoteBookmarks(note)
    expect(result.label).toBe(DEFAULT_BOOKMARK_LABEL)
    expect(result.createdAt).toBe(new Date(0).toISOString())
  })

  it('noteHasBookmark reflects presence', () => {
    expect(noteHasBookmark(makeNote({}))).toBe(false)
    expect(noteHasBookmark(makeNote({ [NoteBookmarksKey as unknown as string]: [bookmark()] }))).toBe(true)
  })
})

describe('normalizeAnchor', () => {
  it('normalizes a super anchor and drops a blank bookmarkId', () => {
    expect(normalizeAnchor({ kind: 'super', bookmarkId: 'a', nodeKey: 'k', scrollTop: 10 })).toEqual({
      kind: 'super',
      bookmarkId: 'a',
      nodeKey: 'k',
      scrollTop: 10,
    })
    expect(normalizeAnchor({ kind: 'super', bookmarkId: '' })).toBeNull()
  })

  it('normalizes a plain anchor and rejects a negative/non-finite offset', () => {
    expect(normalizeAnchor({ kind: 'plain', offset: 5, snippet: 'hi' })).toEqual({
      kind: 'plain',
      offset: 5,
      snippet: 'hi',
    })
    expect(normalizeAnchor({ kind: 'plain', offset: -1, snippet: 'hi' })).toBeNull()
    expect(normalizeAnchor({ kind: 'plain', offset: 'NaN' as unknown as number, snippet: 'hi' })).toBeNull()
  })

  it('returns null for non-objects and unknown kinds', () => {
    expect(normalizeAnchor(null)).toBeNull()
    expect(normalizeAnchor('x')).toBeNull()
    expect(normalizeAnchor({ kind: 'other' })).toBeNull()
  })

  it('normalizeBookmark keeps optional color/icon only when non-empty', () => {
    const withBoth = normalizeBookmark({ id: 'i', anchor: superAnchor(), label: 'L', color: '#fff', icon: 'star', createdAt: '2026-06-20T00:00:00.000Z' })
    expect(withBoth?.color).toBe('#fff')
    expect(withBoth?.icon).toBe('star')
    const without = normalizeBookmark({ id: 'i', anchor: superAnchor(), label: 'L', color: '', icon: '', createdAt: '2026-06-20T00:00:00.000Z' })
    expect(without?.color).toBeUndefined()
    expect(without?.icon).toBeUndefined()
  })
})

describe('pure list operations', () => {
  it('upsertBookmark adds a new bookmark', () => {
    const next = upsertBookmark([], bookmark())
    expect(next).toHaveLength(1)
    expect(next[0].id).toBe('b1')
  })

  it('upsertBookmark replaces a bookmark with the same id', () => {
    const original = bookmark({ label: 'old' })
    const next = upsertBookmark([original], bookmark({ label: 'new' }))
    expect(next).toHaveLength(1)
    expect(next[0].label).toBe('new')
  })

  it('upsertBookmark sorts by createdAt ascending', () => {
    const a = bookmark({ id: 'a', createdAt: '2026-06-20T10:00:00.000Z' })
    const b = bookmark({ id: 'b', createdAt: '2026-06-20T09:00:00.000Z' })
    const next = upsertBookmark([a], b)
    expect(next.map((x) => x.id)).toEqual(['b', 'a'])
  })

  it('upsertBookmark does not mutate the input array', () => {
    const input = [bookmark()]
    upsertBookmark(input, bookmark({ id: 'b2' }))
    expect(input).toHaveLength(1)
  })

  it('removeBookmark removes by id', () => {
    const list = [bookmark({ id: 'a' }), bookmark({ id: 'b' })]
    expect(removeBookmark(list, 'a').map((x) => x.id)).toEqual(['b'])
  })

  it('updateBookmark patches label/color/icon by id only', () => {
    const list = [bookmark({ id: 'a' }), bookmark({ id: 'b' })]
    const next = updateBookmark(list, 'a', { label: 'renamed', color: '#086dd6', icon: 'bookmark' })
    expect(next[0]).toMatchObject({ id: 'a', label: 'renamed', color: '#086dd6', icon: 'bookmark' })
    expect(next[1].label).toBe('My spot')
  })

  it('updateBookmark ignores a blank label and clears color/icon on null', () => {
    const list = [bookmark({ id: 'a', color: '#fff', icon: 'star' })]
    const next = updateBookmark(list, 'a', { label: '   ', color: null, icon: null })
    expect(next[0].label).toBe('My spot')
    expect(next[0].color).toBeUndefined()
    expect(next[0].icon).toBeUndefined()
  })

  it('updateBookmark never touches the anchor or id', () => {
    const list = [bookmark({ id: 'a' })]
    const next = updateBookmark(list, 'a', { label: 'x' })
    expect(next[0].id).toBe('a')
    expect(next[0].anchor).toEqual(superAnchor())
  })
})

describe('generateBookmarkId', () => {
  it('produces unique-ish non-empty ids', () => {
    const a = generateBookmarkId()
    const b = generateBookmarkId()
    expect(a).toBeTruthy()
    expect(b).toBeTruthy()
    expect(a).not.toBe(b)
  })
})

describe('plaintext capture + relocate-by-snippet (best-effort, honest drift)', () => {
  const text = 'The quick brown fox jumps over the lazy dog and then keeps running far away.'

  it('clampOffset bounds the offset to the text', () => {
    expect(clampOffset(text, -5)).toBe(0)
    expect(clampOffset(text, 10_000)).toBe(text.length)
    expect(clampOffset(text, 5)).toBe(5)
  })

  it('capturePlainAnchor stores offset + a bounded surrounding snippet', () => {
    // Use an offset comfortably beyond SNIPPET_RADIUS so the snippet is centered
    // on the mark (not clamped to the document start).
    const mark = SNIPPET_RADIUS + 10
    const anchor = capturePlainAnchor(text, mark, 120)
    expect(anchor.kind).toBe('plain')
    expect(anchor.offset).toBe(mark)
    expect(anchor.scrollTop).toBe(120)
    expect(anchor.snippet.length).toBeLessThanOrEqual(SNIPPET_RADIUS * 2)
    // The mark sits SNIPPET_RADIUS chars into the snippet (away from doc edges).
    expect(text.slice(mark - SNIPPET_RADIUS, mark)).toBe(anchor.snippet.slice(0, SNIPPET_RADIUS))
  })

  it('relocates exactly when the text is unchanged (no drift)', () => {
    const anchor = capturePlainAnchor(text, 20)
    expect(relocateBySnippet(text, anchor.offset, anchor.snippet)).toBe(20)
  })

  it('relocates the mark after text was inserted ABOVE it (offset drifted)', () => {
    const anchor = capturePlainAnchor(text, 20)
    const edited = 'PREFIX INSERTED ABOVE. ' + text
    const shift = 'PREFIX INSERTED ABOVE. '.length
    expect(relocateBySnippet(edited, anchor.offset, anchor.snippet)).toBe(20 + shift)
  })

  it('falls back to the clamped offset when the snippet no longer exists', () => {
    const anchor = capturePlainAnchor(text, 20)
    const replaced = 'completely different content with nothing in common at all here'
    const result = relocateBySnippet(replaced, anchor.offset, anchor.snippet)
    expect(result).toBe(Math.min(anchor.offset, replaced.length))
  })

  it('falls back to the clamped offset when the snippet is empty', () => {
    expect(relocateBySnippet(text, 9999, '')).toBe(text.length)
  })

  it('captures near the start of the document (mark closer than the radius)', () => {
    const anchor = capturePlainAnchor(text, 3)
    expect(anchor.offset).toBe(3)
    expect(relocateBySnippet(text, anchor.offset, anchor.snippet)).toBe(3)
  })

  it('picks the occurrence nearest the original offset when the snippet repeats', () => {
    const repeated = 'abcXYZabc marker here abcXYZabc'
    // Capture at the second "marker" region; ensure relocate stays near it.
    const offset = repeated.indexOf('marker')
    const anchor = capturePlainAnchor(repeated, offset)
    expect(relocateBySnippet(repeated, anchor.offset, anchor.snippet)).toBe(offset)
  })
})

describe('cross-note aggregation + search', () => {
  const noteA = makeNote({ [NoteBookmarksKey as unknown as string]: [bookmark({ id: 'a1', label: 'Intro' })] }, 'Project Plan')
  const noteB = makeNote(
    { [NoteBookmarksKey as unknown as string]: [bookmark({ id: 'b1', label: 'Budget' }), bookmark({ id: 'b2', label: 'Risks' })] },
    'Finance',
  )
  const trashed = makeNote({ [NoteBookmarksKey as unknown as string]: [bookmark({ id: 't1', label: 'Gone' })] }, 'Old', true)

  it('flattens every non-trashed note bookmark with its note context', () => {
    const all = collectAllBookmarks([noteA, noteB, trashed])
    expect(all).toHaveLength(3)
    expect(all.map((x) => x.bookmark.id).sort()).toEqual(['a1', 'b1', 'b2'])
    const intro = all.find((x) => x.bookmark.id === 'a1') as AggregatedBookmark
    expect(intro.noteTitle).toBe('Project Plan')
  })

  it('defaults the note title to Untitled', () => {
    const untitled = makeNote({ [NoteBookmarksKey as unknown as string]: [bookmark()] }, '   ')
    expect(collectAllBookmarks([untitled])[0].noteTitle).toBe('Untitled')
  })

  it('filterBookmarks matches label OR note title, case-insensitively', () => {
    const all = collectAllBookmarks([noteA, noteB])
    expect(filterBookmarks(all, 'bud').map((x) => x.bookmark.id)).toEqual(['b1'])
    expect(filterBookmarks(all, 'finance').map((x) => x.bookmark.id).sort()).toEqual(['b1', 'b2'])
    expect(filterBookmarks(all, 'INTRO').map((x) => x.bookmark.id)).toEqual(['a1'])
  })

  it('filterBookmarks returns the list unchanged for an empty query', () => {
    const all = collectAllBookmarks([noteA, noteB])
    expect(filterBookmarks(all, '   ')).toHaveLength(3)
  })
})
