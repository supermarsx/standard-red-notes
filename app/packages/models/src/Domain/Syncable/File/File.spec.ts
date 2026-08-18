import { ConflictStrategy } from './../../Abstract/Item/Types/ConflictStrategy'
import { ContentType } from '@standardnotes/domain-core'
import { FillItemContent } from '../../Abstract/Content/ItemContent'
import { DecryptedPayload, PayloadTimestampDefaults } from '../../Abstract/Payload'
import { FileContent, FileItem, MAX_FILE_DESCRIPTION_LENGTH, normalizeFileDescription } from './File'
import { UuidGenerator } from '@standardnotes/utils'

UuidGenerator.SetGenerator(() => String(Math.random()))

describe('file', () => {
  const createFile = (content: Partial<FileContent> = {}): FileItem => {
    return new FileItem(
      new DecryptedPayload<FileContent>({
        uuid: '123',
        content_type: ContentType.TYPES.File,
        content: FillItemContent<FileContent>({
          name: 'name.png',
          key: 'secret',
          remoteIdentifier: 'A',
          encryptionHeader: 'header',
          encryptedChunkSizes: [1, 2, 3],
          ...content,
        }),
        dirty: true,
        ...PayloadTimestampDefaults(),
      }),
    )
  }

  const copyFile = (file: FileItem, override: Partial<FileContent> = {}): FileItem => {
    return new FileItem(
      file.payload.copy({
        content: {
          ...file.content,
          ...override,
        } as FileContent,
      }),
    )
  }

  it('should not copy on name conflict', () => {
    const file = createFile({ name: 'file.png' })
    const conflictedFile = copyFile(file, { name: 'different.png' })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBase)
  })

  it('keeps legacy files without a description backward compatible', () => {
    const file = createFile()

    expect(file.description).toBeUndefined()
    expect(file.content.description).toBeUndefined()
  })

  it('exposes a bounded, display-safe description without rewriting legacy content on load', () => {
    const unsafe = `  first\r\nsecond\u0000\u202E${'x'.repeat(MAX_FILE_DESCRIPTION_LENGTH)}  `
    const file = createFile({ description: unsafe })

    expect(file.description).toBe(`first\nsecond${'x'.repeat(MAX_FILE_DESCRIPTION_LENGTH - 'first\nsecond'.length)}`)
    expect(file.description).toHaveLength(MAX_FILE_DESCRIPTION_LENGTH)
    expect(file.content.description).toBe(unsafe)
  })

  it('normalizes empty descriptions to the optional absent value', () => {
    expect(normalizeFileDescription(' \r\n\u0000 ')).toBeUndefined()
  })

  it('strips C0, C1, and every Unicode bidirectional control while preserving tabs and newlines', () => {
    const controls = '\u0000\u0008\u000b\u001f\u007f\u0085\u009f\u061c\u200e\u200f\u202a\u202e\u2066\u2069'

    expect(normalizeFileDescription(`safe\tline\n${controls}tail`)).toBe('safe\tline\ntail')
  })

  it('never splits a surrogate pair at the UTF-16 metadata boundary', () => {
    const description = `${'x'.repeat(MAX_FILE_DESCRIPTION_LENGTH - 1)}😀tail`
    const normalized = normalizeFileDescription(description)

    expect(normalized).toBe('x'.repeat(MAX_FILE_DESCRIPTION_LENGTH - 1))
    expect(normalized).toHaveLength(MAX_FILE_DESCRIPTION_LENGTH - 1)
    expect(normalized).not.toMatch(/[\uD800-\uDFFF]$/u)
  })

  it('does not duplicate immutable file bytes when only the description conflicts', () => {
    const file = createFile({ description: 'First description' })
    const conflictedFile = copyFile(file, { description: 'Another description' })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBase)
  })

  it('should copy on key conflict', () => {
    const file = createFile({ name: 'file.png' })
    const conflictedFile = copyFile(file, { key: 'different-secret' })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBaseDuplicateApply)
  })

  it('should copy on header conflict', () => {
    const file = createFile({ name: 'file.png' })
    const conflictedFile = copyFile(file, { encryptionHeader: 'different-header' })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBaseDuplicateApply)
  })

  it('should copy on identifier conflict', () => {
    const file = createFile({ name: 'file.png' })
    const conflictedFile = copyFile(file, { remoteIdentifier: 'different-identifier' })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBaseDuplicateApply)
  })

  it('should copy on chunk sizes conflict', () => {
    const file = createFile({ name: 'file.png' })
    const conflictedFile = copyFile(file, { encryptedChunkSizes: [10, 9, 8] })

    expect(file.strategyWhenConflictingWithItem(conflictedFile)).toEqual(ConflictStrategy.KeepBaseDuplicateApply)
  })
})
