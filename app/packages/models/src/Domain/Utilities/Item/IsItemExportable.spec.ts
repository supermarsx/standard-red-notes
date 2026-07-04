import { ContentType } from '@standardnotes/domain-core'
import { isContentTypeExportable, isItemExportable } from './IsItemExportable'

describe('isContentTypeExportable', () => {
  it('EXCLUDES an items key (a plaintext items key is key-material leak)', () => {
    expect(isContentTypeExportable(ContentType.TYPES.ItemsKey)).toBe(false)
  })

  it('EXCLUDES user preferences (private settings noise)', () => {
    expect(isContentTypeExportable(ContentType.TYPES.UserPrefs)).toBe(false)
  })

  it('INCLUDES notes, files, and every other content type', () => {
    expect(isContentTypeExportable(ContentType.TYPES.Note)).toBe(true)
    expect(isContentTypeExportable(ContentType.TYPES.File)).toBe(true)
    expect(isContentTypeExportable(ContentType.TYPES.Tag)).toBe(true)
    expect(isContentTypeExportable(ContentType.TYPES.SmartView)).toBe(true)
    expect(isContentTypeExportable(ContentType.TYPES.Component)).toBe(true)
    expect(isContentTypeExportable(ContentType.TYPES.Theme)).toBe(true)
    expect(isContentTypeExportable('SN|SomethingNew')).toBe(true)
  })

  it('treats an empty / absent content_type as non-exportable (safe default)', () => {
    expect(isContentTypeExportable(undefined)).toBe(false)
    expect(isContentTypeExportable(null)).toBe(false)
    expect(isContentTypeExportable('')).toBe(false)
  })
})

describe('isItemExportable', () => {
  const item = (contentType: string) => ({ content_type: contentType })

  it('EXCLUDES an items key and user preferences item', () => {
    expect(isItemExportable(item(ContentType.TYPES.ItemsKey))).toBe(false)
    expect(isItemExportable(item(ContentType.TYPES.UserPrefs))).toBe(false)
  })

  it('INCLUDES notes, files, and other items', () => {
    expect(isItemExportable(item(ContentType.TYPES.Note))).toBe(true)
    expect(isItemExportable(item(ContentType.TYPES.File))).toBe(true)
    expect(isItemExportable(item(ContentType.TYPES.Tag))).toBe(true)
  })

  it('is false for a missing item', () => {
    expect(isItemExportable(undefined)).toBe(false)
    expect(isItemExportable(null)).toBe(false)
  })
})
