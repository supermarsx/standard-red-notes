/**
 * Standard Red Notes: where a table's column filters live, and how a column is
 * identified.
 *
 * PERSISTENCE MECHANISM - Lexical 0.47 node state (`createState` / `$getState`
 * / `$setState`) on the STOCK `TableNode` and `TableCellNode`. No subclass and
 * no node-type rename: renaming the serialized type of every table would force
 * a migration on every existing note, and a subclass would break every
 * `$isTableNode` consumer. Node state serializes under the reserved `"$"` key
 * and leaves keys it does not know untouched, so an older or a newer build
 * cannot erase the other's settings.
 *
 * PERSISTENCE SEMANTICS - filters are PERSISTED, and node state SYNCS. A
 * collaborator opening the note therefore sees the same filtered view. That is
 * only defensible because the view is self-describing: whenever any filter is
 * active the table carries an always-visible "Filtered: showing X of Y rows"
 * caption with a Show-all-rows control (`TableFilterPlugin`). The alternative -
 * session-local filters, as `FoldablePlugin` uses for folds - was rejected
 * because a filter is how the author chose to read a long table and is worth
 * keeping across a reload; a fold is a transient reading position.
 *
 * COLUMN IDENTITY - never an index. A column's identity is a token minted once
 * from a Lexical `NodeKey` and then WRITTEN INTO EVERY CELL of that column, so
 * it travels with the cells through an insert, a delete or a reorder. Reading
 * takes the topmost cell in the column that declares one. `$insertTableColumn`
 * builds fresh cells via `$createTableCellNode`, which carry no node state, so
 * an inserted column is genuinely a NEW column and no existing filter can slide
 * onto it. Index-keyed filters silently attach to the wrong column after an
 * insert; that failure is impossible here by construction.
 *
 * THE ONLY WRITE filtering performs is this additive metadata plus the filter
 * map. No row is ever deleted, reordered or rewritten.
 */

import {
  $computeTableMapSkipCellCheck,
  $isTableCellNode,
  $isTableRowNode,
  TableCellHeaderStates,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import { $getState, $setState, createState } from 'lexical'

import { ColumnType, detectColumnType } from '../../Lexical/Nodes/DataTableCellTypes'
import {
  ColumnDescriptor,
  ColumnFilter,
  computeRowVisibility,
  EMPTY_TABLE_FILTER_STATE,
  FilterSummary,
  parseTableFilterState,
  summarizeFilters,
  TableFilterState,
  tableFilterStatesEqual,
  unparseTableFilterState,
} from './tableFilterModel'

/**
 * The node-state key namespaces owned by table filtering. Exported so a
 * contract test can pin them: changing either string orphans every filter in
 * every already-synced note.
 */
export const TABLE_FILTERS_STATE_KEY = 'superTableColumnFilters'
export const TABLE_FILTER_COLUMN_ID_STATE_KEY = 'superTableFilterColumnId'

/** The filter map, on the stock TableNode. */
export const tableFiltersState = createState(TABLE_FILTERS_STATE_KEY, {
  parse: parseTableFilterState,
  unparse: unparseTableFilterState,
  isEqual: tableFilterStatesEqual,
})

/** The owning column's stable id, on each stock TableCellNode of that column. */
export const tableFilterColumnIdState = createState(TABLE_FILTER_COLUMN_ID_STATE_KEY, {
  parse: (jsonValue: unknown): string | null => {
    if (typeof jsonValue !== 'string' || jsonValue.length === 0) {
      return null
    }
    return jsonValue
  },
})

export const $getTableFilterState = (tableNode: TableNode): TableFilterState => $getState(tableNode, tableFiltersState)

/** Is every cell of this row a row-header cell? */
const $isHeaderRow = (row: TableRowNode): boolean => {
  const cells = row.getChildren()
  if (cells.length === 0) {
    return false
  }
  return cells.every((cell) => $isTableCellNode(cell) && cell.hasHeaderState(TableCellHeaderStates.ROW))
}

export type TableGrid = {
  /** `grid[row][column]` - a merged cell repeats across the positions it spans. */
  grid: Array<Array<{ cell: TableCellNode; startRow: number; startColumn: number }>>
  rows: TableRowNode[]
  columnCount: number
  /** Leading rows whose every cell is a row header; usually 1, sometimes 0. */
  headerRowCount: number
}

export const $readTableGrid = (tableNode: TableNode): TableGrid => {
  const [map] = $computeTableMapSkipCellCheck(tableNode, null, null)
  const rows = tableNode.getChildren().filter($isTableRowNode)
  let headerRowCount = 0
  for (const row of rows) {
    if (!$isHeaderRow(row)) {
      break
    }
    headerRowCount++
  }
  return {
    grid: map.map((row) => row.map((value) => ({ ...value }))),
    rows,
    columnCount: map.reduce((widest, row) => Math.max(widest, row.length), 0),
    headerRowCount,
  }
}

/** Every distinct cell that BEGINS in this column, top to bottom. */
const cellsOwningColumn = (grid: TableGrid, columnIndex: number): TableCellNode[] => {
  const seen = new Set<string>()
  const cells: TableCellNode[] = []
  for (const row of grid.grid) {
    const value = row[columnIndex]
    if (!value || value.startColumn !== columnIndex) {
      continue
    }
    const key = value.cell.getKey()
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    cells.push(value.cell)
  }
  return cells
}

/** The id this column already declares, read from its topmost declaring cell. */
export const $readColumnId = (grid: TableGrid, columnIndex: number): string | null => {
  for (const cell of cellsOwningColumn(grid, columnIndex)) {
    const id = $getState(cell, tableFilterColumnIdState)
    if (id !== null) {
      return id
    }
  }
  return null
}

const $allDeclaredColumnIds = (grid: TableGrid): Set<string> => {
  const ids = new Set<string>()
  for (let column = 0; column < grid.columnCount; column++) {
    const id = $readColumnId(grid, column)
    if (id !== null) {
      ids.add(id)
    }
  }
  return ids
}

/**
 * Mint this column's id if it has none, writing it into every cell that begins
 * in the column so the id survives deleting the header row. Must run inside
 * `editor.update`.
 */
export const $ensureColumnId = (grid: TableGrid, columnIndex: number): string | null => {
  const existing = $readColumnId(grid, columnIndex)
  if (existing !== null) {
    return existing
  }
  const cells = cellsOwningColumn(grid, columnIndex)
  if (cells.length === 0) {
    return null
  }
  const used = $allDeclaredColumnIds(grid)
  const base = `tf-${cells[0].getKey()}`
  let id = base
  let suffix = 1
  while (used.has(id)) {
    id = `${base}-${suffix}`
    suffix++
  }
  for (const cell of cells) {
    $setState(cell, tableFilterColumnIdState, id)
  }
  return id
}

const cellText = (cell: TableCellNode): string => cell.getTextContent()

export type ProjectedColumn = {
  /** `null` until this column has been filtered at least once. */
  columnId: string | null
  label: string
  type: ColumnType
}

export type TableFilterProjection = {
  grid: TableGrid
  /** One entry per column, in table order. */
  columns: ProjectedColumn[]
  /** Body rows only - header rows are never hidden and never filtered. */
  bodyRows: Array<{ rowKey: string; values: string[] }>
  state: TableFilterState
  visibility: boolean[]
  summary: FilterSummary
}

/**
 * Read everything the plugin and the menu need, in one editor-state read.
 *
 * Column TYPE is inferred from the body values with the same detector the Data
 * table block uses (`detectColumnType`), so "extensive" means type-appropriate
 * without asking the user to declare anything.
 */
export const $projectTableFilters = (tableNode: TableNode): TableFilterProjection => {
  const grid = $readTableGrid(tableNode)
  const state = $getTableFilterState(tableNode)

  // Labels come from the TOPMOST row whether or not it is a declared header
  // row: that is the row the reader looks at and the row that carries the
  // filter affordance, and it stays the label even when t115-A's
  // differentiated-headers toggle leaves headers visually undistinguished.
  const headerRow = grid.grid[0]
  const headerTexts: string[] = []
  for (let column = 0; column < grid.columnCount; column++) {
    const value = headerRow ? headerRow[column] : undefined
    headerTexts.push(value ? cellText(value.cell).trim() : '')
  }

  const bodyRows: Array<{ rowKey: string; values: string[] }> = []
  for (let rowIndex = grid.headerRowCount; rowIndex < grid.grid.length; rowIndex++) {
    const row = grid.rows[rowIndex]
    if (!row) {
      continue
    }
    const values: string[] = []
    for (let column = 0; column < grid.columnCount; column++) {
      const value = grid.grid[rowIndex] ? grid.grid[rowIndex][column] : undefined
      values.push(value ? cellText(value.cell) : '')
    }
    bodyRows.push({ rowKey: row.getKey(), values })
  }

  const columns: ProjectedColumn[] = headerTexts.map((label, column) => ({
    columnId: $readColumnId(grid, column),
    label: label.length > 0 ? label : `Column ${column + 1}`,
    type: detectColumnType(bodyRows.map((row) => row.values[column] ?? '')),
  }))

  const descriptors: ColumnDescriptor[] = columns.map((column) => ({
    columnId: column.columnId,
    type: column.type,
  }))

  const visibility = computeRowVisibility(
    bodyRows.map((row) => row.values),
    state.filters,
    descriptors,
  )

  return {
    grid,
    columns,
    bodyRows,
    state,
    visibility,
    summary: summarizeFilters(visibility, state, descriptors),
  }
}

/**
 * Write one column's filter. Must run inside `editor.update`.
 *
 * Passing `null` removes that column's filter. Filters naming a column that no
 * longer exists are pruned HERE - on an explicit user write - rather than from
 * an update listener, which would be a write inside a read and would loop.
 */
export const $setTableColumnFilter = (
  tableNode: TableNode,
  columnId: string,
  filter: Omit<ColumnFilter, 'columnId'> | null,
): void => {
  const grid = $readTableGrid(tableNode)
  const liveIds = $allDeclaredColumnIds(grid)
  const current = $getTableFilterState(tableNode)

  const kept = current.filters.filter((entry) => entry.columnId !== columnId && liveIds.has(entry.columnId))
  const next = filter === null ? kept : [...kept, { columnId, ...filter }]

  $setState(tableNode, tableFiltersState, {
    filters: next,
    unreadable: current.unreadable,
    preserved: current.preserved,
  })
}

/** Remove every filter this build can read. Preserved foreign entries stay. */
export const $clearTableFilters = (tableNode: TableNode): void => {
  const current = $getTableFilterState(tableNode)
  $setState(tableNode, tableFiltersState, {
    filters: [],
    unreadable: current.unreadable,
    preserved: current.preserved,
  })
}

export const $resetTableFilterState = (tableNode: TableNode): void => {
  $setState(tableNode, tableFiltersState, EMPTY_TABLE_FILTER_STATE)
}
