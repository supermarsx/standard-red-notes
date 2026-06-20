import {
  FILE_CONTENT_TYPE,
  NOTE_CONTENT_TYPE,
  SyncItemLike,
  TAG_CONTENT_TYPE,
  kindForContentType,
  labelForKind,
  summarizeSync,
} from './syncSummary'

const item = (overrides: Partial<SyncItemLike> & { uuid: string }): SyncItemLike => ({
  content_type: NOTE_CONTENT_TYPE,
  localOnly: false,
  title: 'Item',
  trashed: false,
  ...overrides,
})

describe('kindForContentType', () => {
  it('maps note/tag/file content types to their bucket', () => {
    expect(kindForContentType(NOTE_CONTENT_TYPE)).toBe('note')
    expect(kindForContentType(TAG_CONTENT_TYPE)).toBe('tag')
    expect(kindForContentType(FILE_CONTENT_TYPE)).toBe('file')
  })

  it('returns "other" for unrelated content types', () => {
    expect(kindForContentType('SN|SmartView')).toBe('other')
    expect(kindForContentType('SN|VaultListing')).toBe('other')
  })
})

describe('labelForKind', () => {
  it('pluralizes based on count', () => {
    expect(labelForKind('note', 1)).toBe('Note')
    expect(labelForKind('note', 2)).toBe('Notes')
    expect(labelForKind('tag', 0)).toBe('Tags')
    expect(labelForKind('file', 1)).toBe('File')
  })
})

describe('summarizeSync', () => {
  it('partitions items into synced vs local-only counts by type', () => {
    const summary = summarizeSync([
      item({ uuid: 'n1', content_type: NOTE_CONTENT_TYPE, localOnly: false }),
      item({ uuid: 'n2', content_type: NOTE_CONTENT_TYPE, localOnly: true }),
      item({ uuid: 'n3', content_type: NOTE_CONTENT_TYPE, localOnly: true }),
      item({ uuid: 't1', content_type: TAG_CONTENT_TYPE, localOnly: false }),
      item({ uuid: 'f1', content_type: FILE_CONTENT_TYPE, localOnly: true }),
      item({ uuid: 'f2', content_type: FILE_CONTENT_TYPE, localOnly: false }),
    ])

    expect(summary.synced).toEqual({ note: 1, tag: 1, file: 1, total: 3 })
    expect(summary.localOnly).toEqual({ note: 2, tag: 0, file: 1, total: 3 })
  })

  it('skips trashed items from both counts', () => {
    const summary = summarizeSync([
      item({ uuid: 'a', localOnly: true, trashed: true }),
      item({ uuid: 'b', localOnly: false, trashed: true }),
      item({ uuid: 'c', localOnly: false }),
    ])

    expect(summary.synced.total).toBe(1)
    expect(summary.localOnly.total).toBe(0)
    expect(summary.localOnlyItems).toHaveLength(0)
  })

  it('ignores content types that are not note/tag/file', () => {
    const summary = summarizeSync([
      item({ uuid: 'note', content_type: NOTE_CONTENT_TYPE }),
      item({ uuid: 'sv', content_type: 'SN|SmartView', localOnly: true }),
      item({ uuid: 'vault', content_type: 'SN|VaultListing', localOnly: false }),
    ])

    expect(summary.synced.total).toBe(1)
    expect(summary.localOnly.total).toBe(0)
    expect(summary.localOnlyItems).toHaveLength(0)
  })

  it('builds a display list of local-only items, kind-ordered then alpha', () => {
    const summary = summarizeSync([
      item({ uuid: 'f', content_type: FILE_CONTENT_TYPE, localOnly: true, title: 'photo.png' }),
      item({ uuid: 'n2', content_type: NOTE_CONTENT_TYPE, localOnly: true, title: 'Zebra' }),
      item({ uuid: 'n1', content_type: NOTE_CONTENT_TYPE, localOnly: true, title: 'Apple' }),
      item({ uuid: 't', content_type: TAG_CONTENT_TYPE, localOnly: true, title: 'work' }),
      item({ uuid: 'synced', content_type: NOTE_CONTENT_TYPE, localOnly: false, title: 'NotListed' }),
    ])

    // Notes (alpha) -> tags -> files.
    expect(summary.localOnlyItems.map((i) => i.uuid)).toEqual(['n1', 'n2', 't', 'f'])
    expect(summary.localOnlyItems.map((i) => i.kind)).toEqual(['note', 'note', 'tag', 'file'])
  })

  it('falls back to "Untitled" for empty titles in the local-only list', () => {
    const summary = summarizeSync([
      item({ uuid: 'n', content_type: NOTE_CONTENT_TYPE, localOnly: true, title: '' }),
    ])
    expect(summary.localOnlyItems[0].title).toBe('Untitled')
  })

  it('returns all-zero counts and an empty list for no items', () => {
    const summary = summarizeSync([])
    expect(summary.synced).toEqual({ note: 0, tag: 0, file: 0, total: 0 })
    expect(summary.localOnly).toEqual({ note: 0, tag: 0, file: 0, total: 0 })
    expect(summary.localOnlyItems).toEqual([])
  })
})
