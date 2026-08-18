import { filesSortByForTableSortBy, getFileTypeLabel, tableSortByForFilesSortBy } from './FilesViewTableUtils'

describe('FilesViewTableUtils', () => {
  it.each([
    ['name', 'title'],
    ['size', 'decryptedSize'],
    ['date', 'created_at'],
  ] as const)('maps the controller %s sort to and from the table %s key', (filesSortBy, tableSortBy) => {
    expect(tableSortByForFilesSortBy(filesSortBy)).toBe(tableSortBy)
    expect(filesSortByForTableSortBy(tableSortBy)).toBe(filesSortBy)
  })

  it('does not convert unrelated table sort keys into a FilesView sort', () => {
    expect(filesSortByForTableSortBy('userModifiedDate')).toBeUndefined()
  })

  it('shows the exact MIME type when one is available', () => {
    expect(getFileTypeLabel({ name: 'notes.md', mimeType: 'text/markdown' })).toBe('text/markdown')
  })

  it('falls back to the extension without guessing a MIME type', () => {
    expect(getFileTypeLabel({ name: 'archive.srn', mimeType: '  ' })).toBe('SRN file')
    expect(getFileTypeLabel({ name: 'README', mimeType: '' })).toBe('Unknown type')
  })
})
