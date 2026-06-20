/**
 * Pure row model + filter/sort evaluation for the Base table view.
 *
 * These functions are deliberately free of any snjs/application dependency so
 * they can be unit-tested in isolation. The editor component is responsible for
 * resolving real notes into the simple {@link BaseRow} shape consumed here.
 */

import {
  BuiltinPropertyId,
  ColumnDef,
  Filter,
  FilterOperator,
  BaseSort,
  builtinPropertyType,
} from './BaseDocument'

/**
 * The resolved per-note value bag. Built-in properties are keyed by their
 * BuiltinPropertyId; parsed front-matter properties live under `parsed[key]`.
 */
export type BaseRow = {
  uuid: string
  title: string
  createdAt: Date
  updatedAt: Date
  /** Tag display names. */
  tags: string[]
  /** Folder display name, or '' if the note is in no folder. */
  folder: string
  wordCount: number
  pinned: boolean
  archived: boolean
  protected: boolean
  starred: boolean
  /** Parsed front-matter properties keyed by lower-cased key. */
  parsed: Record<string, string>
}

/** A cell's primitive value, used for both display and comparison. */
export type CellValue = string | number | boolean | Date | string[] | undefined

/** Resolve a target string (builtin id or `parsed:<key>`) to a row value. */
export const getTargetValue = (row: BaseRow, target: string): CellValue => {
  if (target.startsWith('parsed:')) {
    const key = target.slice('parsed:'.length).toLowerCase()
    return row.parsed[key]
  }
  return getBuiltinValue(row, target as BuiltinPropertyId)
}

export const getBuiltinValue = (row: BaseRow, property: BuiltinPropertyId): CellValue => {
  switch (property) {
    case 'title':
      return row.title
    case 'createdAt':
      return row.createdAt
    case 'updatedAt':
      return row.updatedAt
    case 'tags':
      return row.tags
    case 'folder':
      return row.folder
    case 'wordCount':
      return row.wordCount
    case 'pinned':
      return row.pinned
    case 'archived':
      return row.archived
    case 'protected':
      return row.protected
    case 'starred':
      return row.starred
    default:
      return undefined
  }
}

/** Resolve the value for a given column on a given row. */
export const getColumnValue = (row: BaseRow, column: ColumnDef): CellValue => {
  if (column.kind === 'parsed') {
    return column.key ? row.parsed[column.key.toLowerCase()] : undefined
  }
  return column.property ? getBuiltinValue(row, column.property) : undefined
}

/** Human-readable cell text for display in the table. */
export const formatCellValue = (value: CellValue): string => {
  if (value === undefined || value === null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.join(', ')
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toLocaleString()
  }
  if (typeof value === 'boolean') {
    return value ? 'Yes' : 'No'
  }
  return String(value)
}

const toComparableText = (value: CellValue): string => {
  if (value === undefined || value === null) {
    return ''
  }
  if (Array.isArray(value)) {
    return value.join(' ')
  }
  if (value instanceof Date) {
    return String(value.getTime())
  }
  return String(value)
}

const isEmptyValue = (value: CellValue): boolean => {
  if (value === undefined || value === null) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  if (typeof value === 'string') {
    return value.trim().length === 0
  }
  return false
}

const toBoolean = (value: CellValue): boolean => {
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    return normalized === 'true' || normalized === 'yes' || normalized === '1'
  }
  if (Array.isArray(value)) {
    return value.length > 0
  }
  return Boolean(value)
}

const toMillis = (value: CellValue): number | undefined => {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? undefined : time
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const time = Date.parse(value)
    return Number.isNaN(time) ? undefined : time
  }
  if (typeof value === 'number') {
    return value
  }
  return undefined
}

/** Evaluate a single filter against a row. */
export const evaluateFilter = (row: BaseRow, filter: Filter): boolean => {
  const value = getTargetValue(row, filter.target)
  const operand = filter.value ?? ''

  switch (filter.operator) {
    case 'contains':
      return toComparableText(value).toLowerCase().includes(operand.toLowerCase())
    case 'notContains':
      return !toComparableText(value).toLowerCase().includes(operand.toLowerCase())
    case 'equals':
      return toComparableText(value).toLowerCase() === operand.toLowerCase()
    case 'notEquals':
      return toComparableText(value).toLowerCase() !== operand.toLowerCase()
    case 'before': {
      const left = toMillis(value)
      const right = toMillis(operand)
      return left !== undefined && right !== undefined && left < right
    }
    case 'after': {
      const left = toMillis(value)
      const right = toMillis(operand)
      return left !== undefined && right !== undefined && left > right
    }
    case 'isTrue':
      return toBoolean(value)
    case 'isFalse':
      return !toBoolean(value)
    case 'isEmpty':
      return isEmptyValue(value)
    case 'isNotEmpty':
      return !isEmptyValue(value)
    default:
      return true
  }
}

/** Keep only rows that satisfy every filter (AND semantics). */
export const applyFilters = (rows: BaseRow[], filters: Filter[]): BaseRow[] => {
  if (filters.length === 0) {
    return rows
  }
  return rows.filter((row) => filters.every((filter) => evaluateFilter(row, filter)))
}

/**
 * Compare two cell values for sorting. Numbers/dates compare numerically;
 * booleans by truthiness; everything else by case-insensitive locale text.
 * Empty values always sort last (regardless of direction).
 */
const compareValues = (a: CellValue, b: CellValue): number => {
  const aEmpty = isEmptyValue(a)
  const bEmpty = isEmptyValue(b)
  if (aEmpty && bEmpty) {
    return 0
  }
  if (aEmpty) {
    return 1
  }
  if (bEmpty) {
    return -1
  }

  if (a instanceof Date || b instanceof Date) {
    const am = toMillis(a) ?? 0
    const bm = toMillis(b) ?? 0
    return am - bm
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b
  }
  if (typeof a === 'boolean' && typeof b === 'boolean') {
    return a === b ? 0 : a ? 1 : -1
  }
  return toComparableText(a).localeCompare(toComparableText(b), undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * Sort rows by the given column. The `columns` array lets us resolve the
 * sort.columnId to a ColumnDef. A stable sort is used so equal rows keep their
 * source order. When `sort.columnId` is undefined or unknown, rows are returned
 * unchanged (source order).
 *
 * "Empty last" combined with the direction flip means empties always trail; for
 * descending we negate the non-empty comparison but keep empties at the bottom.
 */
export const applySort = (rows: BaseRow[], sort: BaseSort, columns: ColumnDef[]): BaseRow[] => {
  const column = columns.find((c) => c.id === sort.columnId)
  if (!column) {
    return rows
  }
  const directionFactor = sort.dir === 'desc' ? -1 : 1
  const indexed = rows.map((row, index) => ({ row, index }))
  indexed.sort((left, right) => {
    const a = getColumnValue(left.row, column)
    const b = getColumnValue(right.row, column)
    const aEmpty = isEmptyValue(a)
    const bEmpty = isEmptyValue(b)
    if (aEmpty || bEmpty) {
      // Empties always last, independent of direction.
      if (aEmpty && bEmpty) {
        return left.index - right.index
      }
      return aEmpty ? 1 : -1
    }
    const cmp = compareValues(a, b) * directionFactor
    return cmp !== 0 ? cmp : left.index - right.index
  })
  return indexed.map((entry) => entry.row)
}

/** Convenience: filter then sort. */
export const computeVisibleRows = (
  rows: BaseRow[],
  filters: Filter[],
  sort: BaseSort,
  columns: ColumnDef[],
): BaseRow[] => applySort(applyFilters(rows, filters), sort, columns)

/**
 * The operators that make sense for a given column/property type. Used by the
 * config UI to offer only relevant operators.
 */
export const operatorsForType = (type: 'text' | 'date' | 'number' | 'boolean' | 'list'): FilterOperator[] => {
  switch (type) {
    case 'boolean':
      return ['isTrue', 'isFalse']
    case 'date':
      return ['before', 'after', 'isEmpty', 'isNotEmpty']
    case 'number':
      return ['equals', 'notEquals', 'before', 'after', 'isEmpty', 'isNotEmpty']
    case 'list':
      return ['contains', 'notContains', 'isEmpty', 'isNotEmpty']
    case 'text':
    default:
      return ['contains', 'notContains', 'equals', 'notEquals', 'isEmpty', 'isNotEmpty']
  }
}

export const operatorLabel = (operator: FilterOperator): string => {
  switch (operator) {
    case 'contains':
      return 'contains'
    case 'notContains':
      return 'does not contain'
    case 'equals':
      return 'equals'
    case 'notEquals':
      return 'does not equal'
    case 'before':
      return 'before'
    case 'after':
      return 'after'
    case 'isTrue':
      return 'is true'
    case 'isFalse':
      return 'is false'
    case 'isEmpty':
      return 'is empty'
    case 'isNotEmpty':
      return 'is not empty'
    default:
      return operator
  }
}

/**
 * Parse simple front-matter style properties from plaintext:
 *  - `key:: value` (Dataview inline style)
 *  - `key: value` (YAML-ish), only inside a leading `---` fenced block, OR as a
 *    bare leading line, to avoid mis-parsing ordinary prose containing colons.
 *
 * Returns a map keyed by lower-cased property name. Best-effort and never
 * throws. Only the first occurrence of a key wins.
 */
export const parseFrontmatterProperties = (plaintext: string): Record<string, string> => {
  const result: Record<string, string> = {}
  if (!plaintext) {
    return result
  }
  const lines = plaintext.replace(/\r\n?/g, '\n').split('\n')

  // Detect a leading YAML front-matter block delimited by `---`.
  let yamlEnd = -1
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        yamlEnd = i
        break
      }
    }
  }

  const addKeyValue = (rawKey: string, rawValue: string) => {
    const key = rawKey.trim().toLowerCase()
    // Skip empty keys; first occurrence of a key wins.
    if (key.length === 0 || key in result) {
      return
    }
    result[key] = rawValue.trim()
  }

  // YAML block lines: `key: value`.
  if (yamlEnd > 0) {
    for (let i = 1; i < yamlEnd; i++) {
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(lines[i])
      if (match) {
        addKeyValue(match[1], match[2])
      }
    }
  }

  // Inline `key:: value` anywhere in the text.
  for (const line of lines) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*::\s*(.*)$/.exec(line)
    if (match) {
      addKeyValue(match[1], match[2])
    }
  }

  return result
}

/** Discover the union of parsed-property keys across a set of rows. */
export const discoverParsedKeys = (rows: BaseRow[]): string[] => {
  const keys = new Set<string>()
  for (const row of rows) {
    for (const key of Object.keys(row.parsed)) {
      keys.add(key)
    }
  }
  return [...keys].sort()
}

/** Re-export for the editor so it doesn't need to import BaseDocument directly. */
export { builtinPropertyType }
