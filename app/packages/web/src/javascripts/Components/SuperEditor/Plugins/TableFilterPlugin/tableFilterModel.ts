/**
 * Standard Red Notes: the pure, side-effect-free model behind per-column table
 * filtering in the Super editor.
 *
 * Nothing in this file touches Lexical or the DOM, so the operator semantics,
 * the normalize-on-read parser and the row arithmetic are all unit testable
 * without an editor mount (jsdom has no layout engine, so the only honest tests
 * of filtering are the ones in here plus DOM-attribute assertions).
 *
 * FILTERING NEVER MUTATES THE DOCUMENT. These helpers only ever *decide* which
 * rows are visible; hiding is applied as presentation in `TableFilterPlugin`.
 *
 * COMBINATION SEMANTICS
 *   - Across columns: always AND. A row must satisfy every column that carries
 *     an active filter. This is the conventional spreadsheet default and is
 *     deliberately NOT configurable, so "3 of 40 rows" never needs a second
 *     explanation.
 *   - Within one column: a column may carry several conditions, combined by
 *     that column's own `combinator` — `'all'` (AND, the default) or `'any'`
 *     (OR). "Price > 10 AND Price < 50" and "Status is A OR Status is B" are
 *     both expressible without a cross-column OR.
 */

import {
  ColumnType,
  numericValue,
  parseBooleanValue,
  parseCurrencyValue,
  parseDateValue,
  parseNumberValue,
} from '../../Lexical/Nodes/DataTableCellTypes'

export type { ColumnType }

/**
 * Every operator this build understands. Operator ids are deliberately shared
 * between the numeric-like types (number / currency / date / boolean) so the
 * comparison arithmetic has exactly one implementation; only the *labels*
 * differ per type ("is less than" vs "is before").
 */
export const FILTER_OPERATORS = [
  // text
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  // ordered / numeric-like
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  // boolean
  'isTrue',
  'isFalse',
  // presence
  'isEmpty',
  'isNotEmpty',
] as const

export type FilterOperator = (typeof FILTER_OPERATORS)[number]

const KNOWN_OPERATORS: ReadonlySet<string> = new Set<string>(FILTER_OPERATORS)

export const isFilterOperator = (value: unknown): value is FilterOperator =>
  typeof value === 'string' && KNOWN_OPERATORS.has(value)

/** How many operands the operator reads. */
export const operatorArity = (operator: FilterOperator): 0 | 1 | 2 => {
  switch (operator) {
    case 'isEmpty':
    case 'isNotEmpty':
    case 'isTrue':
    case 'isFalse':
      return 0
    case 'between':
      return 2
    default:
      return 1
  }
}

export type ColumnCombinator = 'all' | 'any'

export type FilterCondition = {
  operator: FilterOperator
  /** First operand, always stored as the raw text the user typed. */
  value: string
  /** Second operand; only `between` reads it. */
  value2: string
}

export type ColumnFilter = {
  /**
   * Stable per-column identity, minted from a Lexical NodeKey and written into
   * every cell of the column. NEVER a column index — see `tableFilterState.ts`.
   */
  columnId: string
  combinator: ColumnCombinator
  conditions: FilterCondition[]
}

export type TableFilterState = {
  filters: ColumnFilter[]
  /**
   * Diagnostics produced by `parseTableFilterState`. Derived, never serialized:
   * a stored filter is a synced value that an older or a newer build may have
   * written, so anything this build cannot read is reported here rather than
   * guessed at. See `unparseTableFilterState`.
   */
  unreadable: string[]
  /**
   * The RAW stored entries that produced those complaints, kept verbatim and
   * written back on every save. Without this, a build that cannot read a newer
   * build's operator would quietly delete that filter the first time this user
   * touched any other column — the exact cross-version erasure the node-state
   * mechanism was chosen to avoid.
   */
  preserved: unknown[]
}

export const EMPTY_TABLE_FILTER_STATE: TableFilterState = { filters: [], unreadable: [], preserved: [] }

/** Hard cap so a malformed or hostile payload cannot grow without bound. */
export const MAX_CONDITIONS_PER_COLUMN = 8

const OPERATOR_LABELS: Record<FilterOperator, string> = {
  contains: 'contains',
  notContains: 'does not contain',
  equals: 'is',
  notEquals: 'is not',
  startsWith: 'starts with',
  endsWith: 'ends with',
  eq: 'is equal to',
  neq: 'is not equal to',
  lt: 'is less than',
  lte: 'is at most',
  gt: 'is greater than',
  gte: 'is at least',
  between: 'is between',
  isTrue: 'is true',
  isFalse: 'is false',
  isEmpty: 'is empty',
  isNotEmpty: 'is not empty',
}

const DATE_OPERATOR_LABELS: Partial<Record<FilterOperator, string>> = {
  eq: 'is on',
  neq: 'is not on',
  lt: 'is before',
  lte: 'is on or before',
  gt: 'is after',
  gte: 'is on or after',
  between: 'is between',
}

/** Human label for an operator, specialised per column type where it helps. */
export const operatorLabel = (operator: FilterOperator, type: ColumnType): string =>
  (type === 'date' ? DATE_OPERATOR_LABELS[operator] : undefined) ?? OPERATOR_LABELS[operator]

const TEXT_OPERATORS: FilterOperator[] = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
]

const NUMERIC_OPERATORS: FilterOperator[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'isEmpty', 'isNotEmpty']

const DATE_OPERATORS: FilterOperator[] = ['eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'between', 'isEmpty', 'isNotEmpty']

const BOOLEAN_OPERATORS: FilterOperator[] = ['isTrue', 'isFalse', 'isEmpty', 'isNotEmpty']

/**
 * The operators offered for a column of this detected type. A *stored* filter is
 * still evaluated whatever its column's current type is (see `matchesCondition`)
 * — a column whose content drifts from numbers to text must not silently change
 * what its filter means, and must not be reported as unreadable either.
 */
export const operatorsForColumnType = (type: ColumnType): FilterOperator[] => {
  switch (type) {
    case 'number':
    case 'currency':
      return NUMERIC_OPERATORS
    case 'date':
      return DATE_OPERATORS
    case 'boolean':
      return BOOLEAN_OPERATORS
    default:
      return TEXT_OPERATORS
  }
}

export const defaultOperatorForColumnType = (type: ColumnType): FilterOperator => operatorsForColumnType(type)[0]

export const createCondition = (operator: FilterOperator): FilterCondition => ({
  operator,
  value: '',
  value2: '',
})

const asText = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return ''
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Validate-and-normalize-on-read. This IS the `parse` of the Lexical
 * `createState` config, so it runs on every deserialization of a synced table.
 *
 * An unrecognised operator degrades that column to NO FILTER and is reported in
 * `unreadable`; it is never coerced into some other operator, because applying
 * "contains" where a newer build wrote "matchesRegex" would hide a different set
 * of rows while looking entirely healthy.
 */
export const parseTableFilterState = (jsonValue: unknown): TableFilterState => {
  if (jsonValue === undefined || jsonValue === null) {
    return EMPTY_TABLE_FILTER_STATE
  }
  if (!isRecord(jsonValue)) {
    return {
      filters: [],
      unreadable: ['Stored filter state was not an object and was ignored.'],
      preserved: [],
    }
  }

  const rawFilters = jsonValue.filters
  if (rawFilters === undefined) {
    return EMPTY_TABLE_FILTER_STATE
  }
  if (!Array.isArray(rawFilters)) {
    return {
      filters: [],
      unreadable: ['Stored filter list was not an array and was ignored.'],
      preserved: [],
    }
  }

  const filters: ColumnFilter[] = []
  const unreadable: string[] = []
  const preserved: unknown[] = []
  const seenColumnIds = new Set<string>()

  for (const rawFilter of rawFilters) {
    if (!isRecord(rawFilter)) {
      unreadable.push('A stored column filter was not an object and was ignored.')
      preserved.push(rawFilter)
      continue
    }
    const columnId = typeof rawFilter.columnId === 'string' ? rawFilter.columnId : ''
    if (columnId.length === 0) {
      unreadable.push('A stored column filter had no column id and was ignored.')
      preserved.push(rawFilter)
      continue
    }
    if (seenColumnIds.has(columnId)) {
      unreadable.push('Two stored filters named the same column; the second was ignored.')
      preserved.push(rawFilter)
      continue
    }

    const rawConditions = rawFilter.conditions
    if (!Array.isArray(rawConditions) || rawConditions.length === 0) {
      unreadable.push('A stored column filter listed no conditions and was ignored.')
      preserved.push(rawFilter)
      continue
    }

    const conditions: FilterCondition[] = []
    let columnIsUnreadable = false

    for (const rawCondition of rawConditions.slice(0, MAX_CONDITIONS_PER_COLUMN)) {
      if (!isRecord(rawCondition)) {
        columnIsUnreadable = true
        unreadable.push('A stored condition was not an object, so its whole column filter was dropped.')
        break
      }
      if (!isFilterOperator(rawCondition.operator)) {
        columnIsUnreadable = true
        const name = typeof rawCondition.operator === 'string' ? rawCondition.operator : String(rawCondition.operator)
        unreadable.push(
          `This build does not recognise the filter operator "${name}", so that whole column filter was dropped rather than applied as something else.`,
        )
        break
      }
      conditions.push({
        operator: rawCondition.operator,
        value: asText(rawCondition.value),
        value2: asText(rawCondition.value2),
      })
    }

    if (columnIsUnreadable) {
      preserved.push(rawFilter)
      continue
    }
    if (rawConditions.length > MAX_CONDITIONS_PER_COLUMN) {
      unreadable.push(
        `A stored column filter listed more than ${MAX_CONDITIONS_PER_COLUMN} conditions; the rest were ignored.`,
      )
    }
    if (conditions.length === 0) {
      unreadable.push('A stored column filter had no readable conditions and was ignored.')
      preserved.push(rawFilter)
      continue
    }

    seenColumnIds.add(columnId)
    filters.push({
      columnId,
      combinator: rawFilter.combinator === 'any' ? 'any' : 'all',
      conditions,
    })
  }

  return { filters, unreadable, preserved }
}

/** The columnId a preserved raw entry names, when it is readable at all. */
const preservedColumnId = (entry: unknown): string | null => {
  if (!isRecord(entry) || typeof entry.columnId !== 'string' || entry.columnId.length === 0) {
    return null
  }
  return entry.columnId
}

/**
 * JSON projection written back into node state. `unreadable` is diagnostic and
 * is deliberately dropped, so a round trip through an older build cannot turn a
 * complaint into persisted document data.
 */
export const unparseTableFilterState = (state: TableFilterState): unknown => {
  const claimed = new Set(state.filters.map((filter) => filter.columnId))
  const preserved = state.preserved.filter((entry) => {
    const columnId = preservedColumnId(entry)
    return columnId === null || !claimed.has(columnId)
  })
  return { filters: [...state.filters, ...preserved] }
}

export const tableFilterStatesEqual = (a: TableFilterState, b: TableFilterState): boolean =>
  JSON.stringify(unparseTableFilterState(a)) === JSON.stringify(unparseTableFilterState(b))

/** The operand, read with the column's own type so `100` matches `$100.00`. */
const operandNumber = (value: string, type: ColumnType): number | null => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return null
  }
  if (type === 'date') {
    const date = parseDateValue(trimmed)
    return date ? date.getTime() : null
  }
  if (type === 'boolean') {
    const bool = parseBooleanValue(trimmed)
    return bool === null ? null : bool ? 1 : 0
  }
  if (type === 'currency') {
    return parseCurrencyValue(trimmed)?.value ?? parseNumberValue(trimmed)
  }
  return parseNumberValue(trimmed)
}

const ORDERED_OPERATORS: ReadonlySet<FilterOperator> = new Set<FilterOperator>([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
])

/**
 * Is this condition specified well enough to apply? An operand that is blank, or
 * that cannot be read as the column's type, leaves the condition INERT — it
 * neither hides rows nor counts towards the active-filter total. Half-typed
 * input must not blank a table.
 */
export const conditionIsActive = (condition: FilterCondition, type: ColumnType): boolean => {
  const arity = operatorArity(condition.operator)
  if (arity === 0) {
    return true
  }
  if (!ORDERED_OPERATORS.has(condition.operator)) {
    return condition.value.length > 0
  }
  if (operandNumber(condition.value, type) === null) {
    return false
  }
  if (arity === 2) {
    return operandNumber(condition.value2, type) !== null
  }
  return true
}

/**
 * Evaluate one condition against one raw cell value.
 *
 * A cell whose text cannot be read as the column's type never satisfies an
 * ordering comparison, and always satisfies `neq` — the only answer that is
 * true of "not equal to 10" for the cell "n/a".
 */
export const matchesCondition = (raw: string, condition: FilterCondition, type: ColumnType): boolean => {
  const { operator, value, value2 } = condition
  const trimmedRaw = raw.trim()

  switch (operator) {
    case 'isEmpty':
      return trimmedRaw.length === 0
    case 'isNotEmpty':
      return trimmedRaw.length > 0
    case 'isTrue':
      return parseBooleanValue(raw) === true
    case 'isFalse':
      return parseBooleanValue(raw) === false
    case 'contains':
      return raw.toLowerCase().includes(value.toLowerCase())
    case 'notContains':
      return !raw.toLowerCase().includes(value.toLowerCase())
    case 'equals':
      return trimmedRaw.toLowerCase() === value.trim().toLowerCase()
    case 'notEquals':
      return trimmedRaw.toLowerCase() !== value.trim().toLowerCase()
    case 'startsWith':
      return raw.toLowerCase().startsWith(value.toLowerCase())
    case 'endsWith':
      return raw.toLowerCase().endsWith(value.toLowerCase())
    default:
      break
  }

  const cell = numericValue(raw, type === 'text' ? 'number' : type)
  const operand = operandNumber(value, type)
  if (operand === null) {
    return true
  }
  if (Number.isNaN(cell)) {
    return operator === 'neq'
  }

  switch (operator) {
    case 'eq':
      return cell === operand
    case 'neq':
      return cell !== operand
    case 'lt':
      return cell < operand
    case 'lte':
      return cell <= operand
    case 'gt':
      return cell > operand
    case 'gte':
      return cell >= operand
    case 'between': {
      const second = operandNumber(value2, type)
      if (second === null) {
        return true
      }
      const low = Math.min(operand, second)
      const high = Math.max(operand, second)
      return cell >= low && cell <= high
    }
    default:
      return true
  }
}

/** Does one column's filter admit this cell value? */
export const matchesColumnFilter = (raw: string, filter: ColumnFilter, type: ColumnType): boolean => {
  const active = filter.conditions.filter((condition) => conditionIsActive(condition, type))
  if (active.length === 0) {
    return true
  }
  return filter.combinator === 'any'
    ? active.some((condition) => matchesCondition(raw, condition, type))
    : active.every((condition) => matchesCondition(raw, condition, type))
}

export type ColumnDescriptor = {
  /**
   * `null` for a column that has never been filtered and so has not yet been
   * given an id. Such a column occupies its index — the arithmetic below is
   * position-aware — but no stored filter can address it.
   */
  columnId: string | null
  type: ColumnType
}

/**
 * Which of a column's filters actually bite, in table order. A filter naming a
 * column that no longer exists (its column was deleted) is NOT applied and is
 * reported separately, so a stale entry can never hide rows by accident.
 */
export const resolveActiveFilters = (
  filters: ColumnFilter[],
  columns: ColumnDescriptor[],
): { active: Array<{ filter: ColumnFilter; type: ColumnType; columnIndex: number }>; staleColumnIds: string[] } => {
  const byId = new Map<string, { type: ColumnType; index: number }>()
  columns.forEach((column, index) => {
    if (column.columnId !== null && !byId.has(column.columnId)) {
      byId.set(column.columnId, { type: column.type, index })
    }
  })
  const active: Array<{ filter: ColumnFilter; type: ColumnType; columnIndex: number }> = []
  const staleColumnIds: string[] = []

  for (const filter of filters) {
    const column = byId.get(filter.columnId)
    if (!column) {
      staleColumnIds.push(filter.columnId)
      continue
    }
    if (filter.conditions.some((condition) => conditionIsActive(condition, column.type))) {
      active.push({ filter, type: column.type, columnIndex: column.index })
    }
  }

  active.sort((a, b) => a.columnIndex - b.columnIndex)
  return { active, staleColumnIds }
}

/**
 * The row-matching arithmetic. `rows` are raw cell texts in column order,
 * aligned with `columns`. Returns one boolean per row: `true` = visible.
 *
 * Cross-column combination is AND, unconditionally.
 */
export const computeRowVisibility = (
  rows: string[][],
  filters: ColumnFilter[],
  columns: ColumnDescriptor[],
): boolean[] => {
  const { active } = resolveActiveFilters(filters, columns)
  if (active.length === 0) {
    return rows.map(() => true)
  }
  return rows.map((cells) =>
    active.every(({ filter, type, columnIndex }) => matchesColumnFilter(cells[columnIndex] ?? '', filter, type)),
  )
}

export type FilterSummary = {
  shown: number
  total: number
  hidden: number
  activeColumnCount: number
  unreadableCount: number
  staleColumnCount: number
}

export const summarizeFilters = (
  visibility: boolean[],
  state: TableFilterState,
  columns: ColumnDescriptor[],
): FilterSummary => {
  const { active, staleColumnIds } = resolveActiveFilters(state.filters, columns)
  const shown = visibility.reduce((count, visible) => count + (visible ? 1 : 0), 0)
  return {
    shown,
    total: visibility.length,
    hidden: visibility.length - shown,
    activeColumnCount: active.length,
    unreadableCount: state.preserved.length,
    staleColumnCount: staleColumnIds.length,
  }
}

/**
 * Should the indicator be on screen at all? Anything that changes what the
 * reader sees, or that this build could not apply, must be disclosed — never
 * only the happy path.
 */
export const filterIsDisclosable = (summary: FilterSummary): boolean =>
  summary.activeColumnCount > 0 || summary.unreadableCount > 0 || summary.staleColumnCount > 0

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralForm}`

/**
 * The on-screen indicator. A table showing 3 of 40 rows is claiming to be a
 * 3-row table unless it says otherwise, so this string is rendered whenever any
 * filter is active and names the hidden count outright.
 */
export const filterIndicatorText = (summary: FilterSummary): string => {
  const base = `Filtered: showing ${summary.shown} of ${plural(summary.total, 'row')} — ${
    summary.hidden
  } hidden by ${plural(summary.activeColumnCount, 'column filter')}`
  const notes: string[] = []
  if (summary.unreadableCount > 0) {
    notes.push(`${plural(summary.unreadableCount, 'stored filter')} could not be read by this build and is not applied`)
  }
  if (summary.staleColumnCount > 0) {
    notes.push(`${plural(summary.staleColumnCount, 'filter')} names a column that no longer exists and is not applied`)
  }
  return notes.length === 0 ? base : `${base}. ${notes.join('. ')}`
}

/**
 * The printed/exported counterpart. Export and print always contain EVERY row:
 * an export that silently omits rows is a data-loss bug wearing a feature's
 * clothes, so the active filter is NOTED rather than applied.
 */
export const filterPrintNoticeText = (summary: FilterSummary): string =>
  `All ${plural(summary.total, 'row')} shown. ${plural(
    summary.activeColumnCount,
    'column filter',
  )} active on screen was not applied here.`

export const describeConditionsForLabel = (filter: ColumnFilter, type: ColumnType): string => {
  const active = filter.conditions.filter((condition) => conditionIsActive(condition, type))
  if (active.length === 0) {
    return 'No filter'
  }
  const joiner = filter.combinator === 'any' ? ' or ' : ' and '
  return active
    .map((condition) => {
      const label = operatorLabel(condition.operator, type)
      const arity = operatorArity(condition.operator)
      if (arity === 0) {
        return label
      }
      if (arity === 2) {
        return `${label} ${condition.value} and ${condition.value2}`
      }
      return `${label} ${condition.value}`
    })
    .join(joiner)
}
