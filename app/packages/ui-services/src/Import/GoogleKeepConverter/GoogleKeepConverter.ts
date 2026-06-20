import { DecryptedItemInterface, ItemContent, SNNote, SNTag } from '@standardnotes/models'
import { Converter, HTMLToSuperConverterFunction, InsertNoteFn, InsertTagFn } from '../Converter'
import { ConversionResult } from '../ConversionResult'

type LinkItemsDependency = (
  item: DecryptedItemInterface<ItemContent>,
  itemToLink: DecryptedItemInterface<ItemContent>,
) => Promise<void>

type GoogleKeepListItem = {
  text: string
  isChecked: boolean
}

type GoogleKeepLabel = {
  name: string
}

type GoogleKeepAnnotation = {
  url?: string
  title?: string
  source?: string
}

type GoogleKeepAttachment = {
  filePath?: string
  mimetype?: string
}

type Content =
  | {
      textContent: string
    }
  | {
      listContent: GoogleKeepListItem[]
    }

type GoogleKeepJsonNote = {
  color?: string
  isTrashed?: boolean
  isPinned?: boolean
  isArchived?: boolean
  title?: string
  userEditedTimestampUsec?: number
  createdTimestampUsec?: number
  labels?: GoogleKeepLabel[]
  annotations?: GoogleKeepAnnotation[]
  attachments?: GoogleKeepAttachment[]
} & Content

/**
 * Pure, testable representation of a single Google Keep note mapped to the
 * fields the importer understands. Produced by {@link keepNoteToImported}.
 */
export type ImportedKeepNote = {
  title: string
  /** Markdown/plain text body (text content, checklist, links, attachments). */
  text: string
  createdAt: Date
  updatedAt: Date
  archived: boolean
  trashed: boolean
  pinned: boolean
  /** Label names from `labels[].name`, applied as tags by the converter. */
  tags: string[]
}

/** Converts a Google Keep `userEditedTimestampUsec` (microseconds) to a Date. */
const usecToDate = (usec: number | undefined): Date | null => {
  if (typeof usec !== 'number' || !isFinite(usec)) {
    return null
  }
  const date = new Date(usec / 1000)
  return isNaN(date.getTime()) ? null : date
}

/**
 * Maps a parsed Google Keep note JSON object to an {@link ImportedKeepNote}.
 *
 * This is a pure function (no I/O, no side effects) so the mapping can be unit
 * tested in isolation.
 *
 * Mapping rules:
 * - `title` -> title (fallback: first line of the text, else "Untitled").
 * - `textContent` -> text body.
 * - `listContent` -> a Markdown checklist (`- [ ] item` / `- [x] item`).
 * - `annotations[].url` -> appended as a "Links" Markdown section.
 * - `attachments[].filePath` -> appended as an "Attachments" note (filenames
 *    only — the binary files live separately in the Takeout zip and cannot be
 *    fetched from the JSON alone).
 * - `labels[].name` -> `tags` (applied as tags by the converter).
 * - `isPinned`/`isArchived`/`isTrashed` -> corresponding flags.
 * - `userEditedTimestampUsec` -> updated date; `createdTimestampUsec` (or the
 *    edited timestamp as a fallback) -> created date.
 *
 * @throws if the input is not a valid-looking Keep note object.
 */
export const keepNoteToImported = (json: unknown): ImportedKeepNote => {
  if (!GoogleKeepConverter.isValidGoogleKeepJson(json)) {
    throw new Error('Not a valid Google Keep note')
  }

  const note = json as GoogleKeepJsonNote

  const sections: string[] = []

  if ('textContent' in note && typeof note.textContent === 'string') {
    if (note.textContent.length > 0) {
      sections.push(note.textContent)
    }
  } else if ('listContent' in note && Array.isArray(note.listContent)) {
    const checklist = note.listContent
      .map((item) => (item.isChecked ? `- [x] ${item.text}` : `- [ ] ${item.text}`))
      .join('\n')
    if (checklist.length > 0) {
      sections.push(checklist)
    }
  }

  const annotations = Array.isArray(note.annotations) ? note.annotations : []
  const links = annotations.filter((annotation) => typeof annotation.url === 'string' && annotation.url.length > 0)
  if (links.length > 0) {
    const linksMarkdown = links
      .map((annotation) => {
        const label = annotation.title && annotation.title.length > 0 ? annotation.title : annotation.url
        return `- [${label}](${annotation.url})`
      })
      .join('\n')
    sections.push(`## Links\n${linksMarkdown}`)
  }

  const attachments = Array.isArray(note.attachments) ? note.attachments : []
  const attachmentFiles = attachments
    .map((attachment) => attachment.filePath)
    .filter((filePath): filePath is string => typeof filePath === 'string' && filePath.length > 0)
  if (attachmentFiles.length > 0) {
    const attachmentsMarkdown = attachmentFiles.map((filePath) => `- ${filePath}`).join('\n')
    sections.push(
      `## Attachments\n_The following attachments are stored separately in your Google Takeout archive and were not imported:_\n${attachmentsMarkdown}`,
    )
  }

  const text = sections.join('\n\n')

  const explicitTitle = typeof note.title === 'string' ? note.title.trim() : ''
  const firstLine = text.split('\n').map((line) => line.trim()).find((line) => line.length > 0)
  const title = explicitTitle.length > 0 ? explicitTitle : firstLine && firstLine.length > 0 ? firstLine : 'Untitled'

  const updatedAt = usecToDate(note.userEditedTimestampUsec) || new Date()
  const createdAt = usecToDate(note.createdTimestampUsec) || updatedAt

  const tags = Array.isArray(note.labels)
    ? note.labels
        .map((label) => (label && typeof label.name === 'string' ? label.name.trim() : ''))
        .filter((name) => name.length > 0)
    : []

  return {
    title,
    text,
    createdAt,
    updatedAt,
    archived: Boolean(note.isArchived),
    trashed: Boolean(note.isTrashed),
    pinned: Boolean(note.isPinned),
    tags,
  }
}

export class GoogleKeepConverter implements Converter {
  constructor() {}

  getImportType(): string {
    return 'google-keep'
  }

  getSupportedFileTypes(): string[] {
    return ['text/html', 'application/json']
  }

  isContentValid(content: string): boolean {
    try {
      const parsed = JSON.parse(content)
      if (Array.isArray(parsed)) {
        return parsed.some((item) => GoogleKeepConverter.isValidGoogleKeepJson(item))
      }
      return GoogleKeepConverter.isValidGoogleKeepJson(parsed)
    } catch (error) {
      console.error(error)
    }

    if (content.length > 0 && content.includes('class="content"')) {
      return true
    }

    return false
  }

  convert: Converter['convert'] = async (
    file,
    { insertNote, insertTag, linkItems, canUseSuper, convertHTMLToSuper, convertMarkdownToSuper, readFileAsText },
  ) => {
    const content = await readFileAsText(file)

    const jsonResult = await this.tryParseAsJsonCollection(content, insertNote, insertTag, linkItems, convertMarkdownToSuper)
    if (jsonResult) {
      return jsonResult
    }

    const htmlNote = await this.tryParseAsHtml(content, file, insertNote, convertHTMLToSuper, canUseSuper)
    if (htmlNote) {
      return {
        successful: [htmlNote],
        errored: [],
      }
    }

    throw new Error('Could not parse Google Keep backup file')
  }

  async tryParseAsHtml(
    data: string,
    file: { name: string },
    insertNote: InsertNoteFn,
    convertHTMLToSuper: HTMLToSuperConverterFunction,
    canUseSuper: boolean,
  ): Promise<SNNote> {
    const doc = new DOMParser().parseFromString(data, 'text/html')
    const rootElement = doc.documentElement

    const headingElement = rootElement.getElementsByClassName('heading')[0]
    const parsedDate = new Date(headingElement?.textContent || '')
    const date = parsedDate instanceof Date && !isNaN(parsedDate.getTime()) ? parsedDate : new Date()
    headingElement?.remove()

    const contentElement = rootElement.getElementsByClassName('content')[0]
    if (!contentElement) {
      throw new Error('Could not parse content. Content element not found.')
    }

    let content: string | null

    // Convert lists to readable plaintext format
    // or Super-convertable format
    const lists = contentElement.getElementsByTagName('ul')
    Array.from(lists).forEach((list) => {
      list.setAttribute('__lexicallisttype', 'check')

      const items = list.getElementsByTagName('li')
      Array.from(items).forEach((item) => {
        const bulletSpan = item.getElementsByClassName('bullet')[0]
        bulletSpan?.remove()

        const checked = item.classList.contains('checked')
        item.setAttribute('aria-checked', checked ? 'true' : 'false')

        if (!canUseSuper) {
          item.textContent = `- ${checked ? '[x]' : '[ ]'} ${item.textContent?.trim()}\n`
        }
      })
    })

    if (!canUseSuper) {
      Array.from(contentElement.querySelectorAll('br')).forEach((br) => {
        br.replaceWith(doc.createTextNode('\n'))
      })
      content = contentElement.textContent
    } else {
      content = convertHTMLToSuper(rootElement.innerHTML, {
        addLineBreaks: false,
      })
    }

    if (!content) {
      throw new Error('Could not parse content')
    }

    const title = rootElement.getElementsByClassName('title')[0]?.textContent || file.name

    return await insertNote({
      createdAt: date,
      updatedAt: date,
      title: title,
      text: content,
      useSuperIfPossible: true,
    })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static isValidGoogleKeepJson(json: any): boolean {
    if (typeof json !== 'object' || json === null) {
      return false
    }

    if (typeof json.textContent !== 'string') {
      if (typeof json.listContent === 'object' && Array.isArray(json.listContent)) {
        return json.listContent.every(
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (item: any) => typeof item.text === 'string' && typeof item.isChecked === 'boolean',
        )
      }
      return false
    }

    // A textContent note: title is the only other field we rely on, and even
    // that has a fallback. Keep the check tolerant of missing metadata fields
    // (older/partial Takeout exports) while still rejecting arbitrary JSON.
    return true
  }

  /**
   * Parses a Takeout file that is either a single Keep note object or an array
   * of note objects. Each valid note becomes a Standard Notes note; labels
   * become tags (deduplicated by name across the file). Malformed/partial
   * entries are skipped and surfaced via the `errored` list.
   *
   * Returns null if the content is not Keep JSON at all (so the caller can fall
   * back to the HTML parser).
   */
  async tryParseAsJsonCollection(
    data: string,
    insertNote: InsertNoteFn,
    insertTag: InsertTagFn,
    linkItems: LinkItemsDependency,
    convertMarkdownToSuper: (md: string) => string,
  ): Promise<ConversionResult | null> {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch {
      return null
    }

    const notes = Array.isArray(parsed) ? parsed : [parsed]
    if (!notes.some((note) => GoogleKeepConverter.isValidGoogleKeepJson(note))) {
      return null
    }

    const successful: ConversionResult['successful'] = []
    const errored: ConversionResult['errored'] = []
    const tagsByName = new Map<string, SNTag>()

    for (const [index, rawNote] of notes.entries()) {
      try {
        const imported = keepNoteToImported(rawNote)

        const note = await insertNote({
          createdAt: imported.createdAt,
          updatedAt: imported.updatedAt,
          title: imported.title,
          text: convertMarkdownToSuper(imported.text),
          archived: imported.archived,
          trashed: imported.trashed,
          pinned: imported.pinned,
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
          name: `Google Keep note ${index + 1}`,
          error: error instanceof Error ? error : new Error('Could not import Google Keep note'),
        })
      }
    }

    return { successful, errored }
  }
}
