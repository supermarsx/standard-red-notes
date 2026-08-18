import { SortableItem } from '@standardnotes/snjs'
import { MouseEventHandler, ReactNode } from 'react'

export type TableSortBy = keyof SortableItem

export type TableColumn<Data> = {
  name: string
  sortBy?: TableSortBy
  cell: (data: Data) => ReactNode
  hidden?: boolean
}

type TableCell = {
  render: ReactNode
  hidden: boolean
  colIndex: number
}

export type TableRow<Data> = {
  id: string
  /** Zero-based position in the full logical data set. */
  rowIndex: number
  cells: TableCell[]
  isSelected: boolean
  rowData: Data
  rowActions?: ReactNode
}

export type TableHeader = {
  name: string
  isSorting: boolean | undefined
  sortBy?: TableSortBy
  sortReversed: boolean | undefined
  onSortChange: () => void
  hidden: boolean
  colIndex: number
}

export type Table<Data> = {
  id: string
  headers: TableHeader[]
  rows: TableRow<Data>[]
  rowCount: number
  /** Materializes the next bounded page of rows, if any remain. */
  loadMoreRows: () => void
  /** Materializes a bounded page containing a zero-based logical row. */
  materializeRow: (rowIndex: number) => void
  /** True while rowCount exceeds the currently materialized rows. */
  hasMoreRows: boolean
  colCount: number
  selectRow: (id: string) => void
  multiSelectRow: (id: string) => void
  rangeSelectUpToRow: (id: string) => void
  handleActivateRow: (id: string) => void
  handleRowContextMenu: (id: string) => MouseEventHandler<HTMLTableRowElement>
  canSelectRows: boolean
  canSelectMultipleRows: boolean
  selectedRows: string[]
  selectionActions: ReactNode | undefined
  showSelectionActions: boolean
}
