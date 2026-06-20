/**
 * @jest-environment jsdom
 */

import {
  jsonTextContentData,
  htmlTestData,
  jsonListContentData,
  jsonWithLabels,
  jsonWithAnnotations,
  jsonWithAttachments,
  jsonTrashed,
  jsonNoTitle,
  jsonMissingFields,
  jsonArrayData,
} from './testData'
import { GoogleKeepConverter, keepNoteToImported } from './GoogleKeepConverter'
import { ContentType, SNNote, SNTag } from '@standardnotes/snjs'
import { InsertNoteFn, InsertTagFn } from '../Converter'

describe('GoogleKeepConverter', () => {
  const insertNote: InsertNoteFn = async ({ title, text, createdAt, updatedAt, trashed, archived, pinned }) =>
    ({
      uuid: Math.random().toString(),
      created_at: createdAt,
      updated_at: updatedAt,
      content_type: ContentType.TYPES.Note,
      content: {
        title,
        text,
        trashed,
        archived,
        pinned,
        references: [],
      },
    }) as unknown as SNNote

  const insertTag: InsertTagFn = async ({ title, createdAt, updatedAt }) =>
    ({
      uuid: Math.random().toString(),
      created_at: createdAt,
      updated_at: updatedAt,
      content_type: ContentType.TYPES.Tag,
      content: {
        title,
        references: [],
      },
    }) as unknown as SNTag

  it('should parse json data', async () => {
    const converter = new GoogleKeepConverter()

    const textResult = await converter.tryParseAsJsonCollection(
      jsonTextContentData,
      insertNote,
      insertTag,
      async () => {},
      (md) => md,
    )

    expect(textResult).not.toBeNull()
    const textContent = textResult?.successful[0] as SNNote
    expect(textContent.created_at).toBeInstanceOf(Date)
    expect(textContent.updated_at).toBeInstanceOf(Date)
    expect(textContent.uuid).not.toBeNull()
    expect(textContent.content_type).toBe('Note')
    expect(textContent.content.title).toBe('Testing 1')
    expect(textContent.content.text).toBe('This is a test.')
    expect(textContent.content.trashed).toBe(false)
    expect(textContent.content.archived).toBe(false)
    expect(textContent.content.pinned).toBe(false)

    const listResult = await converter.tryParseAsJsonCollection(
      jsonListContentData,
      insertNote,
      insertTag,
      async () => {},
      (md) => md,
    )

    expect(listResult).not.toBeNull()
    const listContent = listResult?.successful[0] as SNNote
    expect(listContent.created_at).toBeInstanceOf(Date)
    expect(listContent.content_type).toBe('Note')
    expect(listContent.content.title).toBe('Testing 1')
    expect(listContent.content.text).toBe('- [ ] Test 1\n- [x] Test 2')
  })

  it('should parse html data', async () => {
    const converter = new GoogleKeepConverter()

    const result = await converter.tryParseAsHtml(
      htmlTestData,
      {
        name: 'note-2.html',
      },
      insertNote,
      (html) => html,
      false,
    )

    expect(result).not.toBeNull()
    expect(result?.created_at).toBeInstanceOf(Date)
    expect(result?.updated_at).toBeInstanceOf(Date)
    expect(result?.uuid).not.toBeNull()
    expect(result?.content_type).toBe('Note')
    expect(result?.content.title).toBe('Testing 2')
    expect(result?.content.text).toBe('Lorem ipsum dolor sit amet, consectetur adipiscing elit.')
  })

  it('should import an array of notes and create deduplicated tags', async () => {
    const converter = new GoogleKeepConverter()
    const insertTagSpy = jest.fn(insertTag)
    const linkItems = jest.fn(async () => {})

    const result = await converter.tryParseAsJsonCollection(
      jsonArrayData,
      insertNote,
      insertTagSpy,
      linkItems,
      (md) => md,
    )

    expect(result).not.toBeNull()
    const notes = result?.successful.filter((item) => item.content_type === ContentType.TYPES.Note) ?? []
    const tags = result?.successful.filter((item) => item.content_type === ContentType.TYPES.Tag) ?? []
    expect(notes).toHaveLength(3)
    // Two labels (Work, Personal) on the third note.
    expect(tags).toHaveLength(2)
    expect(insertTagSpy).toHaveBeenCalledTimes(2)
    expect(linkItems).toHaveBeenCalledTimes(2)
    expect(result?.errored).toHaveLength(0)
  })

  it('should skip malformed entries in an array and report them as errored', async () => {
    const converter = new GoogleKeepConverter()
    const data = JSON.stringify([{ textContent: 'valid' }, { not: 'a keep note' }, 42])

    const result = await converter.tryParseAsJsonCollection(data, insertNote, insertTag, async () => {}, (md) => md)

    expect(result).not.toBeNull()
    expect(result?.successful.filter((i) => i.content_type === ContentType.TYPES.Note)).toHaveLength(1)
    expect(result?.errored).toHaveLength(2)
  })

  it('should return null for non-keep json so html fallback can run', async () => {
    const converter = new GoogleKeepConverter()
    const result = await converter.tryParseAsJsonCollection(
      JSON.stringify({ foo: 'bar' }),
      insertNote,
      insertTag,
      async () => {},
      (md) => md,
    )
    expect(result).toBeNull()
  })

  it('isContentValid accepts arrays and single objects', () => {
    const converter = new GoogleKeepConverter()
    expect(converter.isContentValid(jsonTextContentData)).toBe(true)
    expect(converter.isContentValid(jsonArrayData)).toBe(true)
    expect(converter.isContentValid('not json at all')).toBe(false)
    expect(converter.isContentValid(htmlTestData)).toBe(true)
  })
})

describe('keepNoteToImported', () => {
  it('maps a plain text note', () => {
    const imported = keepNoteToImported({
      title: 'Hello',
      textContent: 'World',
      isPinned: false,
      isArchived: false,
      isTrashed: false,
      userEditedTimestampUsec: 1618528050144000,
    })
    expect(imported.title).toBe('Hello')
    expect(imported.text).toBe('World')
    expect(imported.pinned).toBe(false)
    expect(imported.archived).toBe(false)
    expect(imported.trashed).toBe(false)
    expect(imported.tags).toEqual([])
  })

  it('maps a checklist note (checked/unchecked)', () => {
    const imported = keepNoteToImported(JSON.parse(jsonListContentData))
    expect(imported.text).toBe('- [ ] Test 1\n- [x] Test 2')
  })

  it('maps labels to tags', () => {
    const imported = keepNoteToImported(jsonWithLabels)
    expect(imported.tags).toEqual(['Work', 'Personal'])
  })

  it('maps pinned/archived flags', () => {
    const imported = keepNoteToImported(jsonWithLabels)
    expect(imported.pinned).toBe(true)
    expect(imported.archived).toBe(true)
    expect(imported.trashed).toBe(false)
  })

  it('preserves the trashed flag (import-as-trashed by default)', () => {
    const imported = keepNoteToImported(jsonTrashed)
    expect(imported.trashed).toBe(true)
  })

  it('appends annotations as a Links section', () => {
    const imported = keepNoteToImported(jsonWithAnnotations)
    expect(imported.text).toContain('## Links')
    expect(imported.text).toContain('- [Example](https://example.com)')
    // Annotation without a title falls back to the url as the label.
    expect(imported.text).toContain('- [https://standardnotes.com](https://standardnotes.com)')
  })

  it('notes attachment filenames and documents the limitation', () => {
    const imported = keepNoteToImported(jsonWithAttachments)
    expect(imported.text).toContain('## Attachments')
    expect(imported.text).toContain('image.jpg')
  })

  it('falls back to the first line of text when title is empty', () => {
    const imported = keepNoteToImported(jsonNoTitle)
    expect(imported.title).toBe('First line becomes the title')
  })

  it('falls back to "Untitled" when there is no title and no text', () => {
    const imported = keepNoteToImported({ textContent: '' })
    expect(imported.title).toBe('Untitled')
    expect(imported.text).toBe('')
  })

  it('tolerates missing metadata fields', () => {
    const imported = keepNoteToImported(jsonMissingFields)
    expect(imported.title).toBe('Only the text is here.')
    expect(imported.text).toBe('Only the text is here.')
    expect(imported.pinned).toBe(false)
    expect(imported.archived).toBe(false)
    expect(imported.trashed).toBe(false)
    expect(imported.tags).toEqual([])
    expect(imported.createdAt).toBeInstanceOf(Date)
    expect(imported.updatedAt).toBeInstanceOf(Date)
  })

  it('converts microsecond timestamps to dates and uses createdTimestampUsec for createdAt', () => {
    const imported = keepNoteToImported(jsonWithLabels)
    expect(imported.updatedAt.getTime()).toBe(1618528050144000 / 1000)
    expect(imported.createdAt.getTime()).toBe(1618528000000000 / 1000)
  })

  it('falls back createdAt to the edited timestamp when createdTimestampUsec is absent', () => {
    const imported = keepNoteToImported(JSON.parse(jsonTextContentData))
    expect(imported.createdAt.getTime()).toBe(imported.updatedAt.getTime())
  })

  it('throws on malformed input', () => {
    expect(() => keepNoteToImported({ not: 'a keep note' })).toThrow()
    expect(() => keepNoteToImported(null)).toThrow()
    expect(() => keepNoteToImported(42)).toThrow()
  })
})
