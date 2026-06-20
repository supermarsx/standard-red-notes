import { parseFileName } from '@standardnotes/utils'
import { SNNote, SNTag } from '@standardnotes/models'
import { Converter, HTMLToSuperConverterFunction, InsertNoteFn, InsertTagFn } from '../Converter'
import { ConversionResult } from '../ConversionResult'

type LinkItemsDependency = (item: SNNote, itemToLink: SNTag) => Promise<void>

/**
 * Pure, testable representation of a single OneNote page mapped to the fields
 * the importer understands. Produced by {@link oneNotePageToImported}.
 *
 * OneNote does not have a clean, open export format. The proprietary `.one`
 * binary container is NOT parsed here (see {@link OneNoteConverter}). Instead we
 * accept what users can actually produce from OneNote: a page exported as HTML
 * (File > Export > Web Page / "Single File Web Page") or Word/Markdown. Each of
 * those exports is a single page of HTML (or Markdown) that we map to one note.
 */
export type ImportedOneNotePage = {
  title: string
  /** HTML (or Markdown) body, later sanitized + converted by the converter. */
  text: string
  /** True if `text` is Markdown rather than HTML. */
  isMarkdown: boolean
  createdAt: Date
  updatedAt: Date
  /**
   * Notebook/section names derived from the page (a OneNote HTML export records
   * the section in metadata and the on-page heading). Applied as tags.
   */
  tags: string[]
}

const SECTION_META_NAMES = ['SectionName', 'Section', 'NotebookName', 'Notebook']

/** True when the HTML looks like it came from OneNote / Microsoft Office. */
const isOneNoteHtml = (content: string): boolean => {
  const lower = content.toLowerCase()
  return (
    lower.includes('microsoft onenote') ||
    lower.includes('progid="onenote.') ||
    lower.includes('progid=onenote.') ||
    lower.includes('content="onenote') ||
    lower.includes('xmlns:o="urn:schemas-microsoft-com:office:onenote"') ||
    // Office "Single File Web Page" exports (Word/OneNote) share these markers.
    (lower.includes('microsoft') && (lower.includes('mso-') || lower.includes('office:office')))
  )
}

/**
 * Reads notebook/section names from the meta tags of a parsed OneNote HTML
 * export. OneNote/Office records these as `<meta name="SectionName" ...>` etc.
 */
const extractSectionTagsFromDoc = (doc: Document): string[] => {
  const tags: string[] = []
  for (const name of SECTION_META_NAMES) {
    const meta = doc.querySelector(`meta[name="${name}" i]`)
    const value = meta?.getAttribute('content')?.trim()
    if (value && !tags.includes(value)) {
      tags.push(value)
    }
  }
  return tags
}

/**
 * Maps a single OneNote-exported page (HTML or Markdown text) to an
 * {@link ImportedOneNotePage}. Pure function (the only "I/O" is DOMParser, which
 * is available in the browser and jsdom), so it can be unit tested in isolation.
 *
 * Mapping rules:
 * - HTML `<title>` / first `<h1>` -> note title (fallback: the file name, else
 *   "Untitled OneNote Page").
 * - The page body HTML -> note text (sanitized + Super-converted by the
 *   converter via `convertHTMLToSuper`; the raw HTML is kept here so the pure
 *   function has no dependency on the Super service).
 * - `<meta name="SectionName"/"NotebookName"...>` -> tags (notebook/section).
 * - For Markdown input the first `# Heading` (or first non-empty line) becomes
 *   the title and the whole text is kept as the body.
 */
export const oneNotePageToImported = (
  content: string,
  fileName: string,
  lastModified?: number,
): ImportedOneNotePage => {
  const { name, ext } = parseFileName(fileName)
  const isMarkdown = ext === 'md' || ext === 'markdown'

  const date = lastModified ? new Date(lastModified) : new Date()
  const fallbackTitle = name && name.length > 0 ? name : 'Untitled OneNote Page'

  if (isMarkdown) {
    const lines = content.split('\n')
    const headingLine = lines.find((line) => /^#{1,6}\s+/.test(line.trim()))
    const firstNonEmpty = lines.map((line) => line.trim()).find((line) => line.length > 0)
    const headingTitle = headingLine ? headingLine.replace(/^#{1,6}\s+/, '').trim() : ''
    const title = headingTitle || firstNonEmpty || fallbackTitle
    return {
      title,
      text: content,
      isMarkdown: true,
      createdAt: date,
      updatedAt: date,
      tags: [],
    }
  }

  const doc = new DOMParser().parseFromString(content, 'text/html')

  const tags = extractSectionTagsFromDoc(doc)

  const docTitle = doc.querySelector('title')?.textContent?.trim() || ''
  const h1Title = doc.querySelector('h1')?.textContent?.trim() || ''
  const title = docTitle || h1Title || fallbackTitle

  // Prefer the <body> content; fall back to the whole document for fragments.
  const bodyHtml = doc.body?.innerHTML?.trim()
  const text = bodyHtml && bodyHtml.length > 0 ? bodyHtml : content

  return {
    title,
    text,
    isMarkdown: false,
    createdAt: date,
    updatedAt: date,
    tags,
  }
}

/**
 * Importer for OneNote exports.
 *
 * HONEST LIMITATION: There is no open, documented OneNote export format and the
 * proprietary `.one` binary section file is NOT supported (it cannot be parsed
 * in the browser without reverse-engineering Microsoft's binary container). The
 * supported inputs are the page exports a user can actually generate from
 * OneNote or via Word:
 *   - `.html` / `.htm` — File > Export > "Web Page" / "Single File Web Page".
 *   - `.md` / `.markdown` — Markdown exported via Word/third-party tooling.
 *
 * Each page becomes one note. Notebook/section names found in the page metadata
 * become tags. The HTML body is sanitized + converted through the same
 * `convertHTMLToSuper` pipeline the Evernote/Keep importers use.
 */
export class OneNoteConverter implements Converter {
  constructor() {}

  getImportType(): string {
    return 'onenote'
  }

  getSupportedFileTypes(): string[] {
    return ['text/html', 'text/markdown']
  }

  isContentValid(content: string): boolean {
    if (content.length === 0) {
      return false
    }
    // Only claim HTML that actually looks like a OneNote/Office export so we do
    // not steal generic `.html` files from the plain HTML converter.
    return isOneNoteHtml(content)
  }

  convert: Converter['convert'] = async (
    file,
    { insertNote, insertTag, linkItems, convertHTMLToSuper, convertMarkdownToSuper, readFileAsText },
  ) => {
    const content = await readFileAsText(file)

    return this.convertContent(
      content,
      file.name,
      file.lastModified,
      insertNote,
      insertTag,
      linkItems,
      convertHTMLToSuper,
      convertMarkdownToSuper,
    )
  }

  async convertContent(
    content: string,
    fileName: string,
    lastModified: number | undefined,
    insertNote: InsertNoteFn,
    insertTag: InsertTagFn,
    linkItems: LinkItemsDependency,
    convertHTMLToSuper: HTMLToSuperConverterFunction,
    convertMarkdownToSuper: (md: string) => string,
  ): Promise<ConversionResult> {
    const successful: ConversionResult['successful'] = []
    const errored: ConversionResult['errored'] = []
    const tagsByName = new Map<string, SNTag>()

    try {
      const imported = oneNotePageToImported(content, fileName, lastModified)

      const text = imported.isMarkdown ? convertMarkdownToSuper(imported.text) : convertHTMLToSuper(imported.text)

      const note = await insertNote({
        createdAt: imported.createdAt,
        updatedAt: imported.updatedAt,
        title: imported.title,
        text,
        useSuperIfPossible: true,
      })
      successful.push(note)

      for (const tagName of imported.tags) {
        let tag = tagsByName.get(tagName)
        if (!tag) {
          const now = new Date()
          tag = await insertTag({
            createdAt: now,
            updatedAt: now,
            title: tagName,
            references: [],
          })
          tagsByName.set(tagName, tag)
          successful.push(tag)
        }
        await linkItems(note, tag)
      }
    } catch (error) {
      errored.push({
        name: fileName,
        error: error instanceof Error ? error : new Error('Could not import OneNote page'),
      })
    }

    return { successful, errored }
  }
}
