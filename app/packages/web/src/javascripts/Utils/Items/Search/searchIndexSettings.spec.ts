import {
  DEFAULT_SEARCH_INDEX_SETTINGS,
  filterNotesByScope,
  isNoteInSearchIndexScope,
  normalizeSearchIndexScope,
  normalizeSearchIndexSettings,
  SearchIndexScope,
} from './searchIndexSettings'

describe('normalizeSearchIndexSettings', () => {
  it('returns defaults for undefined/garbage input', () => {
    expect(normalizeSearchIndexSettings(undefined)).toEqual(DEFAULT_SEARCH_INDEX_SETTINGS)
    expect(normalizeSearchIndexSettings({} as never)).toEqual(DEFAULT_SEARCH_INDEX_SETTINGS)
  })

  it('accepts every supported scheduler mode', () => {
    for (const mode of ['on-change', 'idle', 'interval', 'manual', 'off'] as const) {
      expect(normalizeSearchIndexSettings({ schedulerMode: mode }).schedulerMode).toBe(mode)
    }
  })

  it('falls back to the default scheduler mode for an unknown value', () => {
    expect(normalizeSearchIndexSettings({ schedulerMode: 'bogus' as never }).schedulerMode).toBe(
      DEFAULT_SEARCH_INDEX_SETTINGS.schedulerMode,
    )
  })

  it('clamps the interval into the allowed range', () => {
    expect(normalizeSearchIndexSettings({ intervalMinutes: 0 }).intervalMinutes).toBe(1)
    expect(normalizeSearchIndexSettings({ intervalMinutes: 99999 }).intervalMinutes).toBe(24 * 60)
    expect(normalizeSearchIndexSettings({ intervalMinutes: 30 }).intervalMinutes).toBe(30)
  })

  it('normalizes a partial/garbage scope into a valid scope', () => {
    const settings = normalizeSearchIndexSettings({
      scope: { mode: 'include', tagIds: ['a', 'a', '', 1 as never, 'b'] },
    })
    expect(settings.scope.mode).toBe('include')
    expect(settings.scope.tagIds).toEqual(['a', 'b'])
  })
})

describe('normalizeSearchIndexScope', () => {
  it('defaults to indexing all', () => {
    expect(normalizeSearchIndexScope(undefined)).toEqual({ mode: 'all', tagIds: [] })
  })

  it('rejects an unknown mode', () => {
    expect(normalizeSearchIndexScope({ mode: 'nope' as never, tagIds: ['x'] }).mode).toBe('all')
  })

  it('dedupes tag ids', () => {
    expect(normalizeSearchIndexScope({ mode: 'exclude', tagIds: ['x', 'x', 'y'] }).tagIds).toEqual(['x', 'y'])
  })
})

describe('isNoteInSearchIndexScope', () => {
  const include: SearchIndexScope = { mode: 'include', tagIds: ['work', 'urgent'] }
  const exclude: SearchIndexScope = { mode: 'exclude', tagIds: ['secret'] }

  it("indexes everything in 'all' mode", () => {
    expect(isNoteInSearchIndexScope({ mode: 'all', tagIds: [] }, [])).toBe(true)
    expect(isNoteInSearchIndexScope({ mode: 'all', tagIds: ['x'] }, ['x'])).toBe(true)
  })

  it('whitelist: only notes carrying a scoped tag are indexed', () => {
    expect(isNoteInSearchIndexScope(include, ['work'])).toBe(true)
    expect(isNoteInSearchIndexScope(include, ['personal'])).toBe(false)
    expect(isNoteInSearchIndexScope(include, [])).toBe(false)
  })

  it('blacklist: a note carrying a scoped tag is excluded', () => {
    expect(isNoteInSearchIndexScope(exclude, ['secret'])).toBe(false)
    expect(isNoteInSearchIndexScope(exclude, ['work'])).toBe(true)
    expect(isNoteInSearchIndexScope(exclude, [])).toBe(true)
  })

  it('an empty tag set falls back to indexing all (least surprising)', () => {
    expect(isNoteInSearchIndexScope({ mode: 'include', tagIds: [] }, ['anything'])).toBe(true)
    expect(isNoteInSearchIndexScope({ mode: 'exclude', tagIds: [] }, ['anything'])).toBe(true)
  })
})

describe('filterNotesByScope (index build filter)', () => {
  type Note = { uuid: string; tagIds: string[] }
  const notes: Note[] = [
    { uuid: 'n1', tagIds: ['work'] },
    { uuid: 'n2', tagIds: ['secret'] },
    { uuid: 'n3', tagIds: [] },
    { uuid: 'n4', tagIds: ['work', 'secret'] },
  ]
  const tagIdsForNote = (note: Note) => note.tagIds

  it('indexes every note in all mode', () => {
    const result = filterNotesByScope(notes, { mode: 'all', tagIds: [] }, tagIdsForNote)
    expect(result.map((n) => n.uuid)).toEqual(['n1', 'n2', 'n3', 'n4'])
  })

  it('excludes a blacklisted-tag note from the indexable set', () => {
    const result = filterNotesByScope(notes, { mode: 'exclude', tagIds: ['secret'] }, tagIdsForNote)
    const uuids = result.map((n) => n.uuid)
    expect(uuids).toContain('n1')
    expect(uuids).toContain('n3')
    // n2 and n4 carry the blacklisted "secret" tag and must be dropped.
    expect(uuids).not.toContain('n2')
    expect(uuids).not.toContain('n4')
  })

  it('whitelist keeps only notes carrying a selected tag', () => {
    const result = filterNotesByScope(notes, { mode: 'include', tagIds: ['work'] }, tagIdsForNote)
    expect(result.map((n) => n.uuid)).toEqual(['n1', 'n4'])
  })
})
