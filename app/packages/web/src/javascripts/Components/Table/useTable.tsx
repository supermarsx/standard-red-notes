import { UuidGenerator } from '@standardnotes/snjs'
import { ReactNode, SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Table, TableColumn, TableHeader, TableRow, TableSortBy } from './CommonTypes'

type TableSortOptions =
  | {
      sortBy: TableSortBy
      sortReversed: boolean
      onSortChange: (sortBy: TableSortBy, reversed: boolean) => void
    }
  | {
      sortBy?: never
      sortReversed?: never
      onSortChange?: never
    }

type TableSelectionOptions =
  | {
      enableRowSelection: boolean
      enableMultipleRowSelection?: boolean
      selectedRowIds?: string[]
      onRowSelectionChange?: (rowIds: string[]) => void
      selectionActions?: (selected: string[]) => ReactNode
      showSelectionActions?: boolean
    }
  | {
      enableRowSelection?: never
      enableMultipleRowSelection?: never
      selectedRowIds?: never
      onRowSelectionChange?: never
      selectionActions?: never
      showSelectionActions?: never
    }

type TableRowOptions<Data> = {
  getRowId?: (data: Data) => string
  onRowActivate?: (data: Data) => void
  onRowContextMenu?: (x: number, y: number, data: Data, trigger: HTMLElement) => void
  rowActions?: (data: Data) => ReactNode
}

export type UseTableOptions<Data> = {
  data: Data[]
  columns: TableColumn<Data>[]
} & TableRowOptions<Data> &
  TableSortOptions &
  TableSelectionOptions

const MinTableRowHeight = 50
const MinRowsToDisplay = 20

let cachedPageSize: number | undefined
const getPageSize = (): number => {
  if (cachedPageSize !== undefined) {
    return cachedPageSize
  }
  if (document.readyState !== 'complete') {
    return MinRowsToDisplay
  }
  cachedPageSize = Math.max(MinRowsToDisplay, Math.ceil(document.documentElement.clientHeight / MinTableRowHeight))
  return cachedPageSize
}

const areRowIdsEqual = (left: string[], right: string[]): boolean =>
  left.length === right.length && left.every((rowId, index) => rowId === right[index])

export function useTable<Data>({
  data,
  columns,
  sortBy,
  sortReversed,
  onSortChange,
  getRowId,
  enableRowSelection,
  enableMultipleRowSelection,
  selectedRowIds,
  onRowSelectionChange,
  onRowActivate,
  onRowContextMenu,
  rowActions,
  selectionActions,
  showSelectionActions,
}: UseTableOptions<Data>): Table<Data> {
  const [uncontrolledSelectedRows, setUncontrolledSelectedRows] = useState<string[]>([])
  const uncontrolledSelectedRowsRef = useRef(uncontrolledSelectedRows)
  const selectedRows = selectedRowIds ?? uncontrolledSelectedRows
  const isSelectionControlled = selectedRowIds !== undefined
  const [pageSize] = useState(getPageSize)
  const [visibleRowLimit, setVisibleRowLimit] = useState(() => Math.min(pageSize, data.length))
  const [targetedPageStarts, setTargetedPageStarts] = useState<number[]>([])
  const id = useRef(UuidGenerator.GenerateUuid())

  uncontrolledSelectedRowsRef.current = uncontrolledSelectedRows

  useEffect(() => {
    setVisibleRowLimit((currentLimit) => {
      if (data.length === 0) {
        return currentLimit === 0 ? currentLimit : 0
      }

      const minimumPage = Math.min(pageSize, data.length)
      const nextLimit = Math.min(data.length, Math.max(currentLimit, minimumPage))
      return nextLimit === currentLimit ? currentLimit : nextLimit
    })
    setTargetedPageStarts((currentStarts) => {
      const nextStarts = currentStarts.filter((start) => start < data.length)
      return nextStarts.length === currentStarts.length ? currentStarts : nextStarts
    })
  }, [data.length, pageSize])

  const updateSelectedRows = useCallback(
    (update: SetStateAction<string[]>) => {
      const currentRows = selectedRowIds ?? uncontrolledSelectedRowsRef.current
      const nextRows = typeof update === 'function' ? update(currentRows) : update
      if (areRowIdsEqual(currentRows, nextRows)) {
        return
      }

      if (!isSelectionControlled) {
        uncontrolledSelectedRowsRef.current = nextRows
        setUncontrolledSelectedRows(nextRows)
      }
      onRowSelectionChange?.(nextRows)
    },
    [isSelectionControlled, onRowSelectionChange, selectedRowIds],
  )

  const selectedRowSet = useMemo(() => new Set(selectedRows), [selectedRows])
  const rowIds = useMemo(
    () => data.map((rowData, index) => (getRowId ? getRowId(rowData) : index.toString())),
    [data, getRowId],
  )
  const rowDataById = useMemo(() => new Map(rowIds.map((rowId, index) => [rowId, data[index] as Data])), [data, rowIds])

  const headers: TableHeader[] = useMemo(
    () =>
      columns.map((column, index) => {
        return {
          name: column.name,
          isSorting: sortBy && sortBy === column.sortBy,
          sortBy: column.sortBy,
          sortReversed: sortReversed,
          onSortChange: () => {
            if (!onSortChange || !column.sortBy) {
              return
            }
            onSortChange(column.sortBy, sortBy === column.sortBy ? !sortReversed : false)
          },
          hidden: column.hidden || false,
          colIndex: index,
        }
      }),
    [columns, onSortChange, sortBy, sortReversed],
  )

  const materializedRowIndexes = useMemo(() => {
    const indexes = new Set<number>()
    const sequentialEnd = Math.min(visibleRowLimit, data.length)
    for (let index = 0; index < sequentialEnd; index++) {
      indexes.add(index)
    }
    for (const pageStart of targetedPageStarts) {
      const pageEnd = Math.min(pageStart + pageSize, data.length)
      for (let index = pageStart; index < pageEnd; index++) {
        indexes.add(index)
      }
    }
    return Array.from(indexes).sort((left, right) => left - right)
  }, [data.length, pageSize, targetedPageStarts, visibleRowLimit])

  const rows: TableRow<Data>[] = useMemo(
    () =>
      materializedRowIndexes.map((rowIndex) => {
        const rowData = data[rowIndex] as Data
        const cells = columns.map((column, index) => {
          return {
            render: column.cell(rowData),
            hidden: column.hidden || false,
            colIndex: index,
          }
        })
        const id = getRowId ? getRowId(rowData) : rowIndex.toString()
        const row: TableRow<Data> = {
          id,
          rowIndex,
          isSelected: enableRowSelection ? selectedRowSet.has(id) : false,
          cells,
          rowData,
          rowActions: rowActions ? rowActions(rowData) : undefined,
        }
        return row
      }),
    [columns, data, enableRowSelection, getRowId, materializedRowIndexes, rowActions, selectedRowSet],
  )

  const selectRow = useCallback(
    (id: string) => {
      if (!enableRowSelection) {
        return
      }

      updateSelectedRows([id])
    },
    [enableRowSelection, updateSelectedRows],
  )

  const multiSelectRow = useCallback(
    (id: string) => {
      if (!enableRowSelection || !enableMultipleRowSelection) {
        return
      }

      updateSelectedRows((prev) => (prev.includes(id) ? prev.filter((rowId) => rowId !== id) : [...prev, id]))
    },
    [enableMultipleRowSelection, enableRowSelection, updateSelectedRows],
  )

  const rangeSelectUpToRow = useCallback(
    (id: string) => {
      if (!enableRowSelection || !enableMultipleRowSelection) {
        return
      }

      const lastSelectedIndex = rowIds.indexOf(selectedRows[selectedRows.length - 1] as string)
      const currentIndex = rowIds.indexOf(id)
      if (lastSelectedIndex < 0 || currentIndex < 0) {
        updateSelectedRows([id])
        return
      }
      const start = Math.min(lastSelectedIndex, currentIndex)
      const end = Math.max(lastSelectedIndex, currentIndex)
      const newSelectedRows = rowIds.slice(start, end + 1)
      updateSelectedRows(newSelectedRows)
    },
    [enableMultipleRowSelection, enableRowSelection, rowIds, selectedRows, updateSelectedRows],
  )

  const handleActivateRow = useCallback(
    (id: string) => {
      if (!onRowActivate) {
        return
      }
      const rowData = rowDataById.get(id)
      if (rowData) {
        onRowActivate(rowData)
      }
    },
    [onRowActivate, rowDataById],
  )

  const handleRowContextMenu = useCallback(
    (id: string, x: number, y: number, trigger: HTMLElement) => {
      if (!onRowContextMenu) {
        return
      }
      const rowData = rowDataById.get(id)
      if (rowData) {
        updateSelectedRows([id])
        onRowContextMenu(x, y, rowData, trigger)
      }
    },
    [onRowContextMenu, rowDataById, updateSelectedRows],
  )

  const hasMoreRows = materializedRowIndexes.length < data.length
  const loadMoreRows = useCallback(() => {
    setVisibleRowLimit((currentLimit) => {
      if (currentLimit >= data.length) {
        return currentLimit
      }
      return Math.min(data.length, currentLimit + pageSize)
    })
  }, [data.length, pageSize])

  const materializeRow = useCallback(
    (rowIndex: number) => {
      if (rowIndex < 0 || rowIndex >= data.length || rowIndex < visibleRowLimit) {
        return
      }
      const pageStart = Math.floor(rowIndex / pageSize) * pageSize
      setTargetedPageStarts((currentStarts) => {
        if (currentStarts.includes(pageStart)) {
          return currentStarts
        }
        return [...currentStarts, pageStart].sort((left, right) => left - right)
      })
    },
    [data.length, pageSize, visibleRowLimit],
  )

  const colCount = useMemo(() => columns.length, [columns])
  const rowCount = useMemo(() => data.length, [data.length])

  const table: Table<Data> = useMemo(
    () => ({
      id: id.current,
      headers,
      rows,
      loadMoreRows,
      materializeRow,
      hasMoreRows,
      colCount,
      rowCount,
      selectRow,
      multiSelectRow,
      rangeSelectUpToRow,
      handleActivateRow,
      handleRowContextMenu,
      selectedRows,
      canSelectRows: enableRowSelection || false,
      canSelectMultipleRows: enableMultipleRowSelection || false,
      selectionActions: selectionActions ? selectionActions(selectedRows) : undefined,
      showSelectionActions: showSelectionActions || false,
    }),
    [
      headers,
      rows,
      loadMoreRows,
      materializeRow,
      hasMoreRows,
      colCount,
      rowCount,
      selectRow,
      multiSelectRow,
      rangeSelectUpToRow,
      handleActivateRow,
      handleRowContextMenu,
      selectedRows,
      enableRowSelection,
      enableMultipleRowSelection,
      selectionActions,
      showSelectionActions,
    ],
  )

  return table
}
