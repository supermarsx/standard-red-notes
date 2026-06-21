/**
 * Base (database/table) note document model.
 *
 * Inspired by Obsidian "Bases": a Base defines a *source* set of notes, a set of
 * *columns* (note properties), *filters*, and a *sort*, then renders the matching
 * notes as a sortable/filterable table.
 *
 * Like the Canvas note type, the serialized definition is stored verbatim in
 * `note.text` (the same slot Super stores its Lexical JSON). This keeps a Base
 * note round-tripping and syncing like any other note with no models/snjs
 * changes — the note is marked as a Base purely via `note.editorIdentifier`.
 */

export const BASE_DOCUMENT_VERSION = 1

/** Where a Base draws its rows from. */
export type BaseSourceKind = 'all' | 'tag' | 'folder'

export type BaseSource = {
  kind: BaseSourceKind
  /** For 'tag' / 'folder' sources: the uuid of the selected tag or folder. */
  uuid?: string
}

/**
 * Built-in note properties usable as columns / filter targets. Parsed
 * (front-matter) properties are addressed via `property: 'parsed'` + `key`.
 */
export type BuiltinPropertyId =
  | 'title'
  | 'createdAt'
  | 'updatedAt'
  | 'tags'
  | 'folder'
  | 'wordCount'
  | 'pinned'
  | 'archived'
  | 'protected'
  | 'starred'

export type ColumnKind = 'builtin' | 'parsed'

export type ColumnDef = {
  /** Stable per-column id (used by sort + React keys). */
  id: string
  kind: ColumnKind
  /** For builtin columns: which property. For parsed columns: unused. */
  property?: BuiltinPropertyId
  /** For parsed columns: the front-matter key (e.g. `status`). */
  key?: string
  /** Optional display label override. */
  label?: string
}

export type FilterOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'before'
  | 'after'
  | 'isTrue'
  | 'isFalse'
  | 'isEmpty'
  | 'isNotEmpty'

export type Filter = {
  id: string
  /** A builtin property id, or `parsed:<key>` for a parsed property. */
  target: string
  operator: FilterOperator
  /** Comparison operand. Unused for boolean / empty operators. */
  value?: string
}

export type SortDir = 'asc' | 'desc'

export type BaseSort = {
  /** ColumnDef id to sort by, or undefined for the default (source order). */
  columnId?: string
  dir: SortDir
}

export type BaseDocument = {
  version: number
  source: BaseSource
  columns: ColumnDef[]
  filters: Filter[]
  sort: BaseSort
}

export const BUILTIN_PROPERTIES: { id: BuiltinPropertyId; label: string; type: 'text' | 'date' | 'number' | 'boolean' | 'list' }[] = [
  { id: 'title', label: 'Title', type: 'text' },
  { id: 'createdAt', label: 'Created', type: 'date' },
  { id: 'updatedAt', label: 'Modified', type: 'date' },
  { id: 'tags', label: 'Topics', type: 'list' },
  { id: 'folder', label: 'Folder', type: 'text' },
  { id: 'wordCount', label: 'Word count', type: 'number' },
  { id: 'pinned', label: 'Pinned', type: 'boolean' },
  { id: 'archived', label: 'Archived', type: 'boolean' },
  { id: 'protected', label: 'Protected', type: 'boolean' },
  { id: 'starred', label: 'Starred', type: 'boolean' },
]

export const builtinPropertyLabel = (id: BuiltinPropertyId): string =>
  BUILTIN_PROPERTIES.find((p) => p.id === id)?.label ?? id

export const builtinPropertyType = (id: BuiltinPropertyId): 'text' | 'date' | 'number' | 'boolean' | 'list' =>
  BUILTIN_PROPERTIES.find((p) => p.id === id)?.type ?? 'text'

export const columnLabel = (column: ColumnDef): string => {
  if (column.label && column.label.length > 0) {
    return column.label
  }
  if (column.kind === 'parsed') {
    return column.key ?? 'Property'
  }
  return column.property ? builtinPropertyLabel(column.property) : 'Column'
}

export const createEmptyBaseDocument = (): BaseDocument => ({
  version: BASE_DOCUMENT_VERSION,
  source: { kind: 'all' },
  columns: [
    { id: 'title', kind: 'builtin', property: 'title' },
    { id: 'updatedAt', kind: 'builtin', property: 'updatedAt' },
    { id: 'tags', kind: 'builtin', property: 'tags' },
  ],
  filters: [],
  sort: { columnId: 'updatedAt', dir: 'desc' },
})

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isString = (value: unknown): value is string => typeof value === 'string'

const VALID_SOURCE_KINDS: BaseSourceKind[] = ['all', 'tag', 'folder']

const VALID_BUILTIN_PROPS = new Set<string>(BUILTIN_PROPERTIES.map((p) => p.id))

const VALID_OPERATORS = new Set<FilterOperator>([
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'before',
  'after',
  'isTrue',
  'isFalse',
  'isEmpty',
  'isNotEmpty',
])

const sanitizeSource = (raw: unknown): BaseSource => {
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'all' }
  }
  const candidate = raw as Record<string, unknown>
  const kind = VALID_SOURCE_KINDS.includes(candidate.kind as BaseSourceKind)
    ? (candidate.kind as BaseSourceKind)
    : 'all'
  const uuid = isString(candidate.uuid) ? candidate.uuid : undefined
  return kind === 'all' ? { kind } : { kind, uuid }
}

const sanitizeColumn = (raw: unknown): ColumnDef | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (!isString(candidate.id) || candidate.id.length === 0) {
    return null
  }
  const kind: ColumnKind = candidate.kind === 'parsed' ? 'parsed' : 'builtin'
  if (kind === 'builtin') {
    if (!isString(candidate.property) || !VALID_BUILTIN_PROPS.has(candidate.property)) {
      return null
    }
    return {
      id: candidate.id,
      kind: 'builtin',
      property: candidate.property as BuiltinPropertyId,
      label: isString(candidate.label) ? candidate.label : undefined,
    }
  }
  // parsed
  if (!isString(candidate.key) || candidate.key.length === 0) {
    return null
  }
  return {
    id: candidate.id,
    kind: 'parsed',
    key: candidate.key,
    label: isString(candidate.label) ? candidate.label : undefined,
  }
}

const sanitizeFilter = (raw: unknown): Filter | null => {
  if (typeof raw !== 'object' || raw === null) {
    return null
  }
  const candidate = raw as Record<string, unknown>
  if (!isString(candidate.id) || candidate.id.length === 0) {
    return null
  }
  if (!isString(candidate.target) || candidate.target.length === 0) {
    return null
  }
  if (!isString(candidate.operator) || !VALID_OPERATORS.has(candidate.operator as FilterOperator)) {
    return null
  }
  return {
    id: candidate.id,
    target: candidate.target,
    operator: candidate.operator as FilterOperator,
    value: isString(candidate.value) ? candidate.value : undefined,
  }
}

const sanitizeSort = (raw: unknown, columnIds: Set<string>): BaseSort => {
  if (typeof raw !== 'object' || raw === null) {
    return { dir: 'desc' }
  }
  const candidate = raw as Record<string, unknown>
  const dir: SortDir = candidate.dir === 'asc' ? 'asc' : 'desc'
  const columnId = isString(candidate.columnId) && columnIds.has(candidate.columnId) ? candidate.columnId : undefined
  return { columnId, dir }
}

/**
 * Parse note text into a BaseDocument. Never throws: empty, legacy plain text,
 * or otherwise malformed JSON all fall back to an empty base. The second return
 * value reports whether the input was recoverable Base JSON so the editor can
 * surface a non-destructive notice when content was discarded.
 */
export const parseBaseDocument = (
  text: string | undefined | null,
): { document: BaseDocument; recovered: boolean } => {
  if (!text || text.trim().length === 0) {
    return { document: createEmptyBaseDocument(), recovered: true }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { document: createEmptyBaseDocument(), recovered: false }
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { document: createEmptyBaseDocument(), recovered: false }
  }

  const candidate = parsed as Record<string, unknown>

  // A Base document must expose a columns array (and/or a source object);
  // otherwise it is probably some other note format being switched into Base, so
  // treat it as a fresh base but flag it as not-recovered.
  const looksLikeBase = Array.isArray(candidate.columns) || typeof candidate.source === 'object'

  if (!looksLikeBase) {
    return { document: createEmptyBaseDocument(), recovered: false }
  }

  const rawColumns = Array.isArray(candidate.columns) ? candidate.columns : []
  const columns: ColumnDef[] = []
  const seenColumnIds = new Set<string>()
  for (const rawColumn of rawColumns) {
    const column = sanitizeColumn(rawColumn)
    if (column && !seenColumnIds.has(column.id)) {
      seenColumnIds.add(column.id)
      columns.push(column)
    }
  }

  const rawFilters = Array.isArray(candidate.filters) ? candidate.filters : []
  const filters: Filter[] = []
  const seenFilterIds = new Set<string>()
  for (const rawFilter of rawFilters) {
    const filter = sanitizeFilter(rawFilter)
    if (filter && !seenFilterIds.has(filter.id)) {
      seenFilterIds.add(filter.id)
      filters.push(filter)
    }
  }

  // A Base with no columns is unusable; fall back to the default column set but
  // still treat the source/filters/sort as recovered.
  const finalColumns = columns.length > 0 ? columns : createEmptyBaseDocument().columns
  const finalColumnIds = new Set(finalColumns.map((c) => c.id))

  return {
    document: {
      version: isFiniteNumber(candidate.version) ? candidate.version : BASE_DOCUMENT_VERSION,
      source: sanitizeSource(candidate.source),
      columns: finalColumns,
      filters,
      sort: sanitizeSort(candidate.sort, finalColumnIds),
    },
    recovered: true,
  }
}

/** Serialize a BaseDocument to the string stored in `note.text`. */
export const serializeBaseDocument = (document: BaseDocument): string => {
  return JSON.stringify({
    version: document.version ?? BASE_DOCUMENT_VERSION,
    source: document.source,
    columns: document.columns,
    filters: document.filters,
    sort: document.sort,
  })
}

let idCounter = 0
/** Lightweight unique id generator (no crypto dependency). */
export const createBaseId = (prefix: string): string => {
  idCounter += 1
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
