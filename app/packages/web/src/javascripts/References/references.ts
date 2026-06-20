import { AppDataField, MutationType, NoteMutator, SNNote } from '@standardnotes/snjs'
import { WebApplication } from '@/Application/WebApplication'

/**
 * Standard Red Notes: per-note research/reference (bibliographic) metadata for a
 * Zotero-like reference library.
 *
 * ## Where reference metadata is stored (and why)
 * A "reference" is NOT a new note type — it is an existing note that the user has
 * marked as a research source, carrying bibliographic metadata in the note's
 * encrypted `appData` bag. This is the EXACT mechanism per-note reminders use
 * (`pinned`, `archived`, `locked`, appearance colors, `reminders`): we persist a
 * single key (`reference`) under the default app domain.
 *
 * Read with `note.getAppDomainValue` and write with `mutator.setAppDataItem`
 * (see {@link writeNoteReference}) — exactly like `Reminders/reminders.ts` +
 * `NotesController.writeNoteReminders`. The key is intentionally NOT in the
 * `AppDataField` enum (which lives in the models package we must not touch); we
 * cast our string key to `AppDataField` at the storage boundary, like the
 * reminders/appearance helpers do.
 *
 * Benefits (same as reminders):
 *  - Syncs end-to-end with the note across devices.
 *  - Tied to the note lifecycle (delete the note, the reference metadata goes too).
 *  - ZERO models/server changes.
 *
 * Every read is tolerant: missing/legacy/partial data NEVER throws — it normalizes
 * to a sane value via {@link normalizeReferenceMetadata}.
 */
export const NoteReferenceKey = 'reference' as unknown as AppDataField

/** Kinds of reference, kept permissive so old/unknown values normalize to 'other'. */
export type ReferenceKind =
  | 'article'
  | 'book'
  | 'web'
  | 'report'
  | 'thesis'
  | 'conference'
  | 'other'

export const REFERENCE_KINDS: ReferenceKind[] = [
  'article',
  'book',
  'web',
  'report',
  'thesis',
  'conference',
  'other',
]

const REFERENCE_KIND_SET = new Set<string>(REFERENCE_KINDS)

export const REFERENCE_KIND_LABELS: Record<ReferenceKind, string> = {
  article: 'Article',
  book: 'Book',
  web: 'Web page',
  report: 'Report',
  thesis: 'Thesis',
  conference: 'Conference paper',
  other: 'Other',
}

/**
 * Bibliographic metadata stored on a note's appData under {@link NoteReferenceKey}.
 * `isReference` is the boolean marker that a note belongs to the library.
 */
export type ReferenceMetadata = {
  /** Marker that this note is a reference in the library. Always true when stored. */
  isReference: true
  kind?: ReferenceKind
  /** Author display strings, e.g. ["Knuth, D."]. */
  authors?: string[]
  /** Publication year (4-digit-ish). */
  year?: number
  url?: string
  publisher?: string
  /** Free-text bibliographic tags/keywords (distinct from SN tags). */
  tags?: string[]
  /** Free-text notes/annotation about the source. */
  notes?: string
}

/** A library row: a note paired with its normalized reference metadata. */
export type ReferenceItem = {
  note: SNNote
  uuid: string
  title: string
  metadata: ReferenceMetadata
}

/* -------------------------------------------------------------------------- */
/* Read / normalize (tolerant — never throws on old/partial data)             */
/* -------------------------------------------------------------------------- */

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const cleaned = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
  return cleaned.length > 0 ? cleaned : undefined
}

function normalizeKind(value: unknown): ReferenceKind | undefined {
  if (typeof value === 'string' && REFERENCE_KIND_SET.has(value)) {
    return value as ReferenceKind
  }
  return undefined
}

function normalizeYear(value: unknown): number | undefined {
  const year = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(year)) {
    return undefined
  }
  const floored = Math.floor(year)
  // Permissive but sane range; anything outside is dropped rather than throwing.
  if (floored < 0 || floored > 9999) {
    return undefined
  }
  return floored
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/**
 * Coerce any stored/partial value into a `ReferenceMetadata`. Returns `undefined`
 * if the value clearly isn't a reference (so callers can treat the note as a
 * normal note). Never throws.
 */
export function normalizeReferenceMetadata(raw: unknown): ReferenceMetadata | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined
  }
  const candidate = raw as Record<string, unknown>
  // The note is a reference if it was explicitly marked, OR (for forward-tolerance)
  // it carries any bibliographic field. We require an explicit truthy marker to
  // avoid accidentally pulling in unrelated appData.
  if (candidate.isReference !== true) {
    return undefined
  }
  const metadata: ReferenceMetadata = { isReference: true }
  const kind = normalizeKind(candidate.kind)
  if (kind) {
    metadata.kind = kind
  }
  const authors = normalizeStringArray(candidate.authors)
  if (authors) {
    metadata.authors = authors
  }
  const year = normalizeYear(candidate.year)
  if (year !== undefined) {
    metadata.year = year
  }
  const url = normalizeString(candidate.url)
  if (url) {
    metadata.url = url
  }
  const publisher = normalizeString(candidate.publisher)
  if (publisher) {
    metadata.publisher = publisher
  }
  const tags = normalizeStringArray(candidate.tags)
  if (tags) {
    metadata.tags = tags
  }
  const notes = normalizeString(candidate.notes)
  if (notes) {
    metadata.notes = notes
  }
  return metadata
}

/** Read a note's reference metadata, or undefined if it isn't a reference. */
export function getNoteReference(note: SNNote): ReferenceMetadata | undefined {
  const raw = note.getAppDomainValue<unknown>(NoteReferenceKey)
  return normalizeReferenceMetadata(raw)
}

/** True if the note is marked as a reference. */
export function noteIsReference(note: SNNote): boolean {
  return getNoteReference(note) !== undefined
}

/* -------------------------------------------------------------------------- */
/* Library build / sort / filter (pure, in-memory derivation)                 */
/* -------------------------------------------------------------------------- */

const noteTitle = (note: SNNote): string => note.title?.trim() || 'Untitled'

/**
 * Build the reference library from a list of notes. Skips trashed notes and any
 * note that isn't a reference. Pure: derives entirely from in-memory items.
 */
export function buildReferenceLibrary(notes: SNNote[]): ReferenceItem[] {
  const items: ReferenceItem[] = []
  for (const note of notes) {
    if (note.trashed) {
      continue
    }
    const metadata = getNoteReference(note)
    if (!metadata) {
      continue
    }
    items.push({ note, uuid: note.uuid, title: noteTitle(note), metadata })
  }
  return items
}

export type ReferenceSortKey = 'title' | 'year' | 'kind' | 'authors'
export type SortDirection = 'asc' | 'desc'

const authorsString = (item: ReferenceItem): string => (item.metadata.authors ?? []).join(', ')

const compareForKey = (a: ReferenceItem, b: ReferenceItem, key: ReferenceSortKey): number => {
  switch (key) {
    case 'year': {
      // Items without a year sort last regardless of direction (handled by caller flip).
      const ay = a.metadata.year ?? Number.NEGATIVE_INFINITY
      const by = b.metadata.year ?? Number.NEGATIVE_INFINITY
      if (ay !== by) {
        return ay - by
      }
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }
    case 'kind': {
      const ak = a.metadata.kind ?? 'zzz'
      const bk = b.metadata.kind ?? 'zzz'
      if (ak !== bk) {
        return ak.localeCompare(bk, undefined, { sensitivity: 'base' })
      }
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }
    case 'authors': {
      const cmp = authorsString(a).localeCompare(authorsString(b), undefined, { sensitivity: 'base' })
      if (cmp !== 0) {
        return cmp
      }
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    }
    case 'title':
    default:
      return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
  }
}

/** Pure, stable-ish sort of the library. Does not mutate the input. */
export function sortReferences(
  items: ReferenceItem[],
  key: ReferenceSortKey,
  direction: SortDirection = 'asc',
): ReferenceItem[] {
  const sorted = [...items].sort((a, b) => compareForKey(a, b, key))
  return direction === 'desc' ? sorted.reverse() : sorted
}

export type ReferenceFilter = {
  kind?: ReferenceKind
  tag?: string
  year?: number
  query?: string
}

const matchesQuery = (item: ReferenceItem, query: string): boolean => {
  const haystack = [
    item.title,
    authorsString(item),
    item.metadata.publisher ?? '',
    item.metadata.url ?? '',
    item.metadata.notes ?? '',
    (item.metadata.tags ?? []).join(' '),
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(query)
}

/** Pure filter by kind/tag/year + free-text search. Empty filter returns input order. */
export function filterReferences(items: ReferenceItem[], filter: ReferenceFilter): ReferenceItem[] {
  const query = filter.query?.trim().toLowerCase()
  return items.filter((item) => {
    if (filter.kind && item.metadata.kind !== filter.kind) {
      return false
    }
    if (filter.tag && !(item.metadata.tags ?? []).includes(filter.tag)) {
      return false
    }
    if (filter.year !== undefined && item.metadata.year !== filter.year) {
      return false
    }
    if (query && !matchesQuery(item, query)) {
      return false
    }
    return true
  })
}

/** Distinct kinds present in the library, in canonical order. */
export function availableKinds(items: ReferenceItem[]): ReferenceKind[] {
  const present = new Set<ReferenceKind>()
  for (const item of items) {
    if (item.metadata.kind) {
      present.add(item.metadata.kind)
    }
  }
  return REFERENCE_KINDS.filter((kind) => present.has(kind))
}

/** Distinct bibliographic tags present, sorted alphabetically. */
export function availableTags(items: ReferenceItem[]): string[] {
  const present = new Set<string>()
  for (const item of items) {
    for (const tag of item.metadata.tags ?? []) {
      present.add(tag)
    }
  }
  return [...present].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
}

/** Distinct years present, sorted descending (newest first). */
export function availableYears(items: ReferenceItem[]): number[] {
  const present = new Set<number>()
  for (const item of items) {
    if (item.metadata.year !== undefined) {
      present.add(item.metadata.year)
    }
  }
  return [...present].sort((a, b) => b - a)
}

/* -------------------------------------------------------------------------- */
/* Citation + export (optional niceties — pure)                               */
/* -------------------------------------------------------------------------- */

/**
 * A simple human-readable citation string, e.g.
 * "Knuth, D. (1997). The Art of Computer Programming. Addison-Wesley."
 * Degrades gracefully when fields are missing (never throws, never shows
 * dangling punctuation for absent parts).
 */
export function citationString(item: ReferenceItem): string {
  const parts: string[] = []
  const authors = item.metadata.authors ?? []
  if (authors.length > 0) {
    parts.push(authors.join(', '))
  }
  if (item.metadata.year !== undefined) {
    parts.push(`(${item.metadata.year})`)
  }
  parts.push(item.title)
  if (item.metadata.publisher) {
    parts.push(item.metadata.publisher)
  }
  // Join with ". " and ensure a single trailing period.
  const joined = parts
    .map((part) => part.replace(/\.+$/, ''))
    .filter((part) => part.length > 0)
    .join('. ')
  return joined.length > 0 ? `${joined}.` : `${item.title}.`
}

/** A BibTeX entry type for a kind (defaults to @misc). */
function bibtexEntryType(kind?: ReferenceKind): string {
  switch (kind) {
    case 'article':
      return 'article'
    case 'book':
      return 'book'
    case 'report':
      return 'techreport'
    case 'thesis':
      return 'phdthesis'
    case 'conference':
      return 'inproceedings'
    case 'web':
    case 'other':
    default:
      return 'misc'
  }
}

const sanitizeBibKeyPart = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '')

/** Build a reasonably-stable BibTeX cite key from authors/year/title. */
function bibtexKey(item: ReferenceItem, index: number): string {
  const firstAuthor = item.metadata.authors?.[0]
  const authorPart = firstAuthor ? sanitizeBibKeyPart(firstAuthor.split(',')[0] ?? firstAuthor) : ''
  const yearPart = item.metadata.year !== undefined ? String(item.metadata.year) : ''
  const titlePart = sanitizeBibKeyPart(item.title.split(/\s+/)[0] ?? '')
  const key = `${authorPart}${yearPart}${titlePart}`
  return key.length > 0 ? key : `ref${index + 1}`
}

const bibtexField = (name: string, value: string): string =>
  `  ${name} = {${value.replace(/[{}]/g, '')}},`

/** Export the library as a BibTeX string. Pure. */
export function referencesToBibTeX(items: ReferenceItem[]): string {
  const usedKeys = new Set<string>()
  const entries = items.map((item, index) => {
    let key = bibtexKey(item, index)
    // Disambiguate duplicate keys with a/b/c suffixes.
    if (usedKeys.has(key)) {
      let suffix = 97 // 'a'
      while (usedKeys.has(`${key}${String.fromCharCode(suffix)}`)) {
        suffix += 1
      }
      key = `${key}${String.fromCharCode(suffix)}`
    }
    usedKeys.add(key)

    const lines: string[] = [`@${bibtexEntryType(item.metadata.kind)}{${key},`]
    lines.push(bibtexField('title', item.title))
    if (item.metadata.authors && item.metadata.authors.length > 0) {
      lines.push(bibtexField('author', item.metadata.authors.join(' and ')))
    }
    if (item.metadata.year !== undefined) {
      lines.push(bibtexField('year', String(item.metadata.year)))
    }
    if (item.metadata.publisher) {
      lines.push(bibtexField('publisher', item.metadata.publisher))
    }
    if (item.metadata.url) {
      lines.push(bibtexField('url', item.metadata.url))
    }
    if (item.metadata.tags && item.metadata.tags.length > 0) {
      lines.push(bibtexField('keywords', item.metadata.tags.join(', ')))
    }
    if (item.metadata.notes) {
      lines.push(bibtexField('note', item.metadata.notes))
    }
    lines.push('}')
    return lines.join('\n')
  })
  return entries.join('\n\n')
}

const CSV_COLUMNS = ['Title', 'Authors', 'Year', 'Type', 'Publisher', 'URL', 'Tags', 'Notes'] as const

const csvEscape = (value: string): string => {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`
  }
  return value
}

/** Export the library as CSV. Pure. */
export function referencesToCSV(items: ReferenceItem[]): string {
  const rows: string[] = [CSV_COLUMNS.join(',')]
  for (const item of items) {
    const cells = [
      item.title,
      (item.metadata.authors ?? []).join('; '),
      item.metadata.year !== undefined ? String(item.metadata.year) : '',
      item.metadata.kind ? REFERENCE_KIND_LABELS[item.metadata.kind] : '',
      item.metadata.publisher ?? '',
      item.metadata.url ?? '',
      (item.metadata.tags ?? []).join('; '),
      item.metadata.notes ?? '',
    ]
    rows.push(cells.map((cell) => csvEscape(cell)).join(','))
  }
  return rows.join('\n')
}

/* -------------------------------------------------------------------------- */
/* Write helper (mirrors NotesController.writeNoteReminders)                   */
/* -------------------------------------------------------------------------- */

/**
 * Persist (or clear) a note's reference metadata in its appData, then sync.
 *
 * Mirrors `NotesController.writeNoteReminders` exactly: a single
 * `mutator.setAppDataItem` write under {@link NoteReferenceKey} via
 * `application.mutator.changeItem`, with `NoUpdateUserTimestamps` so marking a
 * reference doesn't bump the note's modified time, followed by a best-effort sync.
 *
 * Passing `undefined` removes the key (un-marks the note as a reference) — the
 * note itself is otherwise untouched.
 */
export async function writeNoteReference(
  application: WebApplication,
  note: SNNote,
  metadata: ReferenceMetadata | undefined,
): Promise<void> {
  await application.mutator.changeItem<NoteMutator>(
    note,
    (mutator) => {
      mutator.setAppDataItem(NoteReferenceKey, metadata)
    },
    MutationType.NoUpdateUserTimestamps,
  )
  application.sync.sync().catch(console.error)
}
