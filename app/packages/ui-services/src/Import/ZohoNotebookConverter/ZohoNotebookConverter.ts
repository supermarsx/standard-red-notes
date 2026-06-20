import { parseFileName } from '@standardnotes/utils'
import { SNNote, SNTag } from '@standardnotes/models'
import { Converter, HTMLToSuperConverterFunction, InsertNoteFn, InsertTagFn } from '../Converter'
import { ConversionResult } from '../ConversionResult'

type LinkItemsDependency = (item: SNNote, itemToLink: SNTag) => Promise<void>

/**
 * Pure, testable representation of a single Zoho Notebook note card mapped to
 * the fields the importer understands. Produced by {@link zohoCardToImported}.
 */
export type ImportedZohoCard = {
  title: string
  /** HTML body, later sanitized + converted by the converter. */
  text: string
  createdAt: Date
  updatedAt: Date
  /** Notebook name(s) the card belongs to, applied as tags. */
  tags: string[]
}

/**
 * Zoho Notebook exports a notebook as a `.zip` containing one HTML/`.zhtml`
 * notecard per note. The cards carry Zoho-specific markup. These markers let us
 * detect a Zoho card without stealing generic `.html` files from the plain HTML
 * converter.
 */
const isZohoCard = (content: string): boolean => {
  const lower = content.toLowerCase()
  return (
    lower.includes('zoho') ||
    lower.includes('znote') ||
    lower.includes('zn-') ||
    lower.includes('class="note-card') ||
    lower.includes('class="zia') ||
    lower.includes('data-notebook')
  )
}

const NOTEBOOK_META_NAMES = ['notebook', 'notebookname', 'zoho-notebook', 'book']

/**
 * Reads the notebook name(s) for a card. Zoho records the owning notebook in a
 * few different shapes depending on the export version, so we look in several
 * places defensively:
 *  - `<meta name="notebook"...>` / similar.
 *  - a `data-notebook="..."` attribute on any element.
 */
const extractNotebookTags = (doc: Document): string[] => {
  const tags: string[] = []
  const push = (value: string | null | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && !tags.includes(trimmed)) {
      tags.push(trimmed)
    }
  }

  for (const name of NOTEBOOK_META_NAMES) {
    push(doc.querySelector(`meta[name="${name}" i]`)?.getAttribute('content'))
  }

  const dataNotebookEl = doc.querySelector('[data-notebook]')
  push(dataNotebookEl?.getAttribute('data-notebook'))

  return tags
}

/**
 * Converts Zoho checklist markup into Markdown-style checklist lines so plain
 * (non-Super) imports keep the checked/unchecked state. Zoho marks checklist
 * items with `class="checked"`/checkbox inputs inside list items.
 */
const normalizeChecklists = (doc: Document): void => {
  const lists = Array.from(doc.querySelectorAll('ul, ol'))
  for (const list of lists) {
    const items = Array.from(list.querySelectorAll(':scope > li'))
    const isChecklist = items.some(
      (li) =>
        li.querySelector('input[type="checkbox"]') !== null ||
        li.classList.contains('checked') ||
        li.classList.contains('zn-checked') ||
        li.classList.contains('unchecked') ||
        li.classList.contains('zn-unchecked'),
    )
    if (!isChecklist) {
      continue
    }
    list.setAttribute('__lexicallisttype', 'check')
    for (const li of items) {
      const checkbox = li.querySelector('input[type="checkbox"]') as HTMLInputElement | null
      const isCheckedClass = li.classList.contains('checked') || li.classList.contains('zn-checked')
      const checked = isCheckedClass || checkbox?.checked === true
      li.setAttribute('aria-checked', checked ? 'true' : 'false')
      checkbox?.remove()
    }
  }
}

/**
 * Maps a single Zoho notecard (HTML text) to an {@link ImportedZohoCard}. Pure
 * function (the only "I/O" is DOMParser, available in browser + jsdom) so it can
 * be unit tested in isolation.
 *
 * Mapping rules:
 * - card title element (`.note-title`, `[data-title]`, `<title>`, first `<h1>`)
 *   -> note title (fallback: file name, else "Untitled Note").
 * - card body (`.note-content`, `.zn-note-content`, else `<body>`) -> note text
 *   (kept as HTML; sanitized + Super-converted by the converter).
 * - notebook name -> tag.
 * - checklist items -> Super check-lists / Markdown checkboxes.
 * - unknown card shapes fall back to using the whole body as content, so the
 *   importer is resilient to card types it does not specifically understand.
 */
export const zohoCardToImported = (content: string, fileName: string, lastModified?: number): ImportedZohoCard => {
  const { name } = parseFileName(fileName)
  const fallbackTitle = name && name.length > 0 ? name : 'Untitled Note'

  const doc = new DOMParser().parseFromString(content, 'text/html')

  const tags = extractNotebookTags(doc)

  const titleEl =
    doc.querySelector('.note-title') ||
    doc.querySelector('.zn-note-title') ||
    doc.querySelector('[data-title]') ||
    doc.querySelector('title') ||
    doc.querySelector('h1')
  const title = titleEl?.textContent?.trim() || titleEl?.getAttribute('data-title')?.trim() || fallbackTitle

  normalizeChecklists(doc)

  const contentEl =
    doc.querySelector('.note-content') ||
    doc.querySelector('.zn-note-content') ||
    doc.querySelector('[data-content]') ||
    doc.body

  // If the title came from a dedicated element inside the content, drop it so it
  // is not duplicated in the body.
  if (contentEl && titleEl && contentEl.contains(titleEl) && titleEl !== contentEl) {
    titleEl.remove()
  }

  const text = contentEl?.innerHTML?.trim() || doc.body?.innerHTML?.trim() || content

  const date = lastModified ? new Date(lastModified) : new Date()

  return {
    title,
    text,
    createdAt: date,
    updatedAt: date,
    tags,
  }
}

/**
 * Importer for Zoho Notebook exports.
 *
 * Zoho Notebook exports a notebook as a `.zip` of HTML/`.zhtml` notecards (plus
 * asset files). This importer accepts a single exported notecard
 * (`.html`/`.htm`/`.zhtml`): it parses the card's title + HTML body, maps the
 * owning notebook to a tag, and carries checklists/text. It inspects the card
 * structure defensively and falls back to the whole body for unknown card types
 * rather than failing. The HTML body is sanitized + converted through the same
 * `convertHTMLToSuper` pipeline the Evernote/Keep importers use.
 */
export class ZohoNotebookConverter implements Converter {
  constructor() {}

  getImportType(): string {
    return 'zoho-notebook'
  }

  getFileExtension(): string {
    return 'zhtml'
  }

  getSupportedFileTypes(): string[] {
    return ['text/html']
  }

  isContentValid(content: string): boolean {
    if (content.length === 0) {
      return false
    }
    return isZohoCard(content)
  }

  convert: Converter['convert'] = async (
    file,
    { insertNote, insertTag, linkItems, convertHTMLToSuper, readFileAsText },
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
  ): Promise<ConversionResult> {
    const successful: ConversionResult['successful'] = []
    const errored: ConversionResult['errored'] = []
    const tagsByName = new Map<string, SNTag>()

    try {
      const imported = zohoCardToImported(content, fileName, lastModified)

      const note = await insertNote({
        createdAt: imported.createdAt,
        updatedAt: imported.updatedAt,
        title: imported.title,
        text: convertHTMLToSuper(imported.text, { addLineBreaks: false }),
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
        error: error instanceof Error ? error : new Error('Could not import Zoho Notebook card'),
      })
    }

    return { successful, errored }
  }
}
