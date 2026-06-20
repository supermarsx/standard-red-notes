/**
 * @jest-environment jsdom
 */

import { ContentType, SNNote, SNTag } from '@standardnotes/snjs'
import { InsertNoteFn, InsertTagFn } from '../Converter'
import { OneNoteConverter, oneNotePageToImported } from './OneNoteConverter'
import { genericHtml, oneNoteHtmlNoTitle, oneNoteHtmlPage, oneNoteMarkdown } from './testData'

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

describe('oneNotePageToImported', () => {
  it('parses title, body and section/notebook tags from an HTML page', () => {
    const imported = oneNotePageToImported(oneNoteHtmlPage, 'Project Kickoff.html', 0)
    expect(imported.title).toBe('Project Kickoff')
    expect(imported.isMarkdown).toBe(false)
    expect(imported.text).toContain('Discussed the')
    expect(imported.text).toContain('Define scope')
    // NotebookName + SectionName meta -> tags.
    expect(imported.tags).toEqual(['Meetings', 'Work'].sort())
    expect(imported.tags).toContain('Work')
    expect(imported.tags).toContain('Meetings')
  })

  it('falls back to the first <h1> when there is no <title>', () => {
    const imported = oneNotePageToImported(oneNoteHtmlNoTitle, 'page.html')
    expect(imported.title).toBe('Heading As Title')
  })

  it('falls back to the file name when no title or heading is present', () => {
    const imported = oneNotePageToImported('<html><body><p>x</p></body></html>', 'My Page.html')
    expect(imported.title).toBe('My Page')
  })

  it('treats .md input as Markdown and uses the heading as the title', () => {
    const imported = oneNotePageToImported(oneNoteMarkdown, 'list.md')
    expect(imported.isMarkdown).toBe(true)
    expect(imported.title).toBe('Grocery List')
    expect(imported.text).toContain('- Milk')
    expect(imported.tags).toEqual([])
  })
})

describe('OneNoteConverter', () => {
  it('detects OneNote/Office HTML and rejects generic HTML', () => {
    const converter = new OneNoteConverter()
    expect(converter.isContentValid(oneNoteHtmlPage)).toBe(true)
    expect(converter.isContentValid(genericHtml)).toBe(false)
    expect(converter.isContentValid('')).toBe(false)
  })

  it('creates a note plus deduplicated tags and links them', async () => {
    const converter = new OneNoteConverter()
    const insertTagSpy = jest.fn(insertTag)
    const linkItems = jest.fn(async () => {})

    const result = await converter.convertContent(
      oneNoteHtmlPage,
      'Project Kickoff.html',
      0,
      insertNote,
      insertTagSpy,
      linkItems,
      (html) => html,
      (md) => md,
    )

    const notes = result.successful.filter((i) => i.content_type === ContentType.TYPES.Note)
    const tags = result.successful.filter((i) => i.content_type === ContentType.TYPES.Tag)
    expect(notes).toHaveLength(1)
    expect(tags).toHaveLength(2)
    expect(insertTagSpy).toHaveBeenCalledTimes(2)
    expect(linkItems).toHaveBeenCalledTimes(2)
    expect(result.errored).toHaveLength(0)
    expect((notes[0] as SNNote).content.title).toBe('Project Kickoff')
  })

  it('imports a Markdown page through the markdown pipeline', async () => {
    const converter = new OneNoteConverter()
    const convertMarkdownToSuper = jest.fn((md: string) => `super:${md}`)

    const result = await converter.convertContent(
      oneNoteMarkdown,
      'list.md',
      0,
      insertNote,
      insertTag,
      async () => {},
      (html) => html,
      convertMarkdownToSuper,
    )

    expect(convertMarkdownToSuper).toHaveBeenCalledTimes(1)
    const note = result.successful[0] as SNNote
    expect(note.content.title).toBe('Grocery List')
    expect(note.content.text).toContain('super:')
  })
})
