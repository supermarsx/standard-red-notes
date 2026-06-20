/**
 * @jest-environment jsdom
 */

import { ContentType, SNNote, SNTag } from '@standardnotes/snjs'
import { InsertNoteFn, InsertTagFn } from '../Converter'
import { ZohoNotebookConverter, zohoCardToImported } from './ZohoNotebookConverter'
import { genericHtml, zohoCardCheckbox, zohoCardHtml, zohoCardUnknownShape } from './testData'

const insertNote: InsertNoteFn = async ({ title, text, createdAt, updatedAt }) =>
  ({
    uuid: Math.random().toString(),
    created_at: createdAt,
    updated_at: updatedAt,
    content_type: ContentType.TYPES.Note,
    content: { title, text, references: [] },
  }) as unknown as SNNote

const insertTag: InsertTagFn = async ({ title, createdAt, updatedAt }) =>
  ({
    uuid: Math.random().toString(),
    created_at: createdAt,
    updated_at: updatedAt,
    content_type: ContentType.TYPES.Tag,
    content: { title, references: [] },
  }) as unknown as SNTag

describe('zohoCardToImported', () => {
  it('parses title, content and notebook tag from a card', () => {
    const imported = zohoCardToImported(zohoCardHtml, 'reading-list.zhtml', 0)
    expect(imported.title).toBe('Reading List')
    expect(imported.text).toContain('Books to read this year.')
    expect(imported.tags).toEqual(['Personal'])
    // The title element inside the content is removed to avoid duplication.
    expect(imported.text).not.toContain('class="note-title"')
  })

  it('marks checklists with a check list type and checked state', () => {
    const imported = zohoCardToImported(zohoCardHtml, 'reading-list.zhtml')
    expect(imported.text).toContain('__lexicallisttype="check"')
    expect(imported.text).toContain('aria-checked="true"')
    expect(imported.text).toContain('aria-checked="false"')
  })

  it('handles checkbox-input checklists', () => {
    const imported = zohoCardToImported(zohoCardCheckbox, 'todo.zhtml')
    expect(imported.text).toContain('__lexicallisttype="check"')
    expect(imported.text).toContain('aria-checked="true"')
    // checkbox inputs are stripped out of the body.
    expect(imported.text).not.toContain('type="checkbox"')
  })

  it('falls back to the whole body for unknown card shapes', () => {
    const imported = zohoCardToImported(zohoCardUnknownShape, 'unknown.zhtml')
    expect(imported.title).toBe('unknown')
    expect(imported.text).toContain('A card type the importer does not specifically understand.')
    expect(imported.tags).toEqual([])
  })
})

describe('ZohoNotebookConverter', () => {
  it('detects Zoho cards and rejects generic HTML', () => {
    const converter = new ZohoNotebookConverter()
    expect(converter.isContentValid(zohoCardHtml)).toBe(true)
    expect(converter.isContentValid(zohoCardUnknownShape)).toBe(true)
    expect(converter.isContentValid(genericHtml)).toBe(false)
    expect(converter.isContentValid('')).toBe(false)
  })

  it('creates a note and the notebook tag and links them', async () => {
    const converter = new ZohoNotebookConverter()
    const insertTagSpy = jest.fn(insertTag)
    const linkItems = jest.fn(async () => {})

    const result = await converter.convertContent(
      zohoCardHtml,
      'reading-list.zhtml',
      0,
      insertNote,
      insertTagSpy,
      linkItems,
      (html) => html,
    )

    const notes = result.successful.filter((i) => i.content_type === ContentType.TYPES.Note)
    const tags = result.successful.filter((i) => i.content_type === ContentType.TYPES.Tag)
    expect(notes).toHaveLength(1)
    expect(tags).toHaveLength(1)
    expect(insertTagSpy).toHaveBeenCalledTimes(1)
    expect(linkItems).toHaveBeenCalledTimes(1)
    expect(result.errored).toHaveLength(0)
    expect((notes[0] as SNNote).content.title).toBe('Reading List')
    expect((tags[0] as SNTag).content.title).toBe('Personal')
  })
})
