import { ContentType } from '@standardnotes/snjs'
import { resolveStorageItemLabel, storageItemIconType } from './storageItemLabel'

// The resolver is pure and only touches content_type / title / name, so plain mock
// objects standing in for the decrypted items are enough to unit-test it. The type
// guards (isNote/isFile/isTag) key off content_type, which these mocks set.
const mockItem = (contentType: string, extra: Record<string, unknown> = {}) =>
  ({ content_type: contentType, ...extra }) as never

const UUID = '00000000-0000-4000-8000-000000000000'

describe('resolveStorageItemLabel', () => {
  it('uses a note title as the primary label with the uuid as secondary', () => {
    const item = mockItem(ContentType.TYPES.Note, { title: 'My great note' })
    expect(resolveStorageItemLabel(item, UUID)).toEqual({ primary: 'My great note', secondary: UUID })
  })

  it('falls back to "Untitled note" for an empty/whitespace note title', () => {
    expect(resolveStorageItemLabel(mockItem(ContentType.TYPES.Note, { title: '   ' }), UUID)).toEqual({
      primary: 'Untitled note',
      secondary: UUID,
    })
  })

  it('uses the file name for a file', () => {
    const item = mockItem(ContentType.TYPES.File, { name: 'photo.png' })
    expect(resolveStorageItemLabel(item, UUID)).toEqual({ primary: 'photo.png', secondary: UUID })
  })

  it('prefixes a tag title with "# "', () => {
    const item = mockItem(ContentType.TYPES.Tag, { title: 'work' })
    expect(resolveStorageItemLabel(item, UUID)).toEqual({ primary: '# work', secondary: UUID })
  })

  it('uses a title for other known titled items', () => {
    const item = mockItem(ContentType.TYPES.SmartView, { title: 'Recently modified' })
    expect(resolveStorageItemLabel(item, UUID)).toEqual({ primary: 'Recently modified', secondary: UUID })
  })

  it('shows a friendly content-type label for a known item without a title', () => {
    const item = mockItem(ContentType.TYPES.ItemsKey)
    expect(resolveStorageItemLabel(item, UUID)).toEqual({ primary: 'Items key', secondary: UUID })
  })

  it('falls back to the uuid when the item is not found and the type is unknown', () => {
    expect(resolveStorageItemLabel(undefined, UUID)).toEqual({ primary: UUID })
  })

  it('shows a friendly type label with the uuid beneath when not found but content_type is known', () => {
    expect(resolveStorageItemLabel(undefined, UUID, ContentType.TYPES.Theme)).toEqual({
      primary: 'Theme',
      secondary: UUID,
    })
  })

  it('falls back to the uuid for an unrecognized content type with no title', () => {
    expect(resolveStorageItemLabel(mockItem('SN|Nonexistent'), UUID)).toEqual({ primary: UUID })
  })
})

describe('storageItemIconType', () => {
  it('maps known content types to their type icon', () => {
    expect(storageItemIconType(ContentType.TYPES.Note)).toBe('notes')
    expect(storageItemIconType(ContentType.TYPES.File)).toBe('file')
    expect(storageItemIconType(ContentType.TYPES.Tag)).toBe('hashtag')
    expect(storageItemIconType(ContentType.TYPES.Theme)).toBe('themes')
    expect(storageItemIconType(ContentType.TYPES.ItemsKey)).toBe('lock')
    expect(storageItemIconType(ContentType.TYPES.UserPrefs)).toBe('settings')
  })

  it('falls back to a generic box icon for unknown/undefined content types', () => {
    expect(storageItemIconType('SN|Nonexistent')).toBe('box')
    expect(storageItemIconType(undefined)).toBe('box')
  })
})
