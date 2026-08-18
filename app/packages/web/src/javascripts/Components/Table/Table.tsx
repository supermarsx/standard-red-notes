import { classNames } from '@standardnotes/snjs'
import { KeyboardKey } from '@standardnotes/ui-services'
import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useApplication } from '../ApplicationProvider'
import Icon from '../Icon/Icon'
import { useContextMenuEvent } from '@/Hooks/useContextMenuEvent'
import { Table as TableType, TableRow as TableRowType } from './CommonTypes'

const InteractiveEventTargetSelector = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'label',
  'summary',
  'audio[controls]',
  'video[controls]',
  'iframe',
  'object',
  'embed',
  '[contenteditable]:not([contenteditable="false"])',
  '[tabindex]:not([tabindex="-1"])',
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="combobox"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="option"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="scrollbar"]',
  '[role="tab"]',
  '[role="treeitem"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menubar"]',
  '[role="radiogroup"]',
  '[role="tablist"]',
  '[role="tree"]',
  '[role="treegrid"]',
  '[data-table-interactive]',
].join(',')

export const isInteractiveTableEventTarget = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(InteractiveEventTargetSelector) !== null

function TableRow<Data>({
  row,
  index: rowIndex,
  canSelectRows,
  handleRowClick,
  handleRowContextMenu,
  handleActivateRow,
}: {
  row: TableRowType<Data>
  index: number
  canSelectRows: TableType<Data>['canSelectRows']
  handleRowClick: (event: React.MouseEvent<HTMLDivElement, MouseEvent>, id: string) => void
  handleRowContextMenu: TableType<Data>['handleRowContextMenu']
  handleActivateRow: TableType<Data>['handleActivateRow']
}) {
  const [isHovered, setIsHovered] = useState(false)
  const [isFocused, setIsFocused] = useState(false)
  const rowRef = useRef<HTMLDivElement>(null)
  const isHoveredOrFocused = isHovered || isFocused

  const openContextMenu = useCallback(
    (x: number, y: number, eventTarget?: HTMLElement) => {
      const trigger =
        eventTarget?.closest<HTMLElement>('[role="gridcell"]') ??
        rowRef.current?.querySelector<HTMLElement>('[role="gridcell"]')
      if (trigger) {
        handleRowContextMenu(row.id, x, y, trigger)
      }
    },
    [handleRowContextMenu, row.id],
  )

  useContextMenuEvent(rowRef, openContextMenu)

  const visibleCells = row.cells.filter((cell) => !cell.hidden)

  return (
    <div
      role="row"
      ref={rowRef}
      id={row.id}
      aria-rowindex={rowIndex + 2}
      {...(canSelectRows ? { 'aria-selected': row.isSelected } : {})}
      className="group relative contents"
      onMouseEnter={() => {
        setIsHovered(true)
      }}
      onMouseLeave={() => {
        setIsHovered(false)
      }}
      onClick={(event) => {
        if (!isInteractiveTableEventTarget(event.target)) {
          handleRowClick(event, row.id)
        }
      }}
      onDoubleClick={(event) => {
        if (!isInteractiveTableEventTarget(event.target)) {
          handleActivateRow(row.id)
        }
      }}
      onFocus={() => {
        setIsFocused(true)
      }}
      onBlur={(event) => {
        if (!event.relatedTarget?.closest(`[id="${row.id}"]`)) {
          setIsFocused(false)
        }
      }}
    >
      {visibleCells.map((cell, index, array) => {
        return (
          <div
            role="gridcell"
            aria-rowindex={rowIndex + 2}
            aria-colindex={cell.colIndex + 1}
            key={index}
            className={classNames(
              'border-border focus:border-info relative flex items-center overflow-hidden border-b px-3 py-4',
              row.isSelected && 'bg-info-backdrop',
              canSelectRows && 'cursor-pointer',
              canSelectRows && isHoveredOrFocused && 'bg-contrast',
            )}
            tabIndex={-1}
          >
            {cell.render}
            {row.rowActions && index === array.length - 1 && (
              <div
                className={classNames(
                  'absolute top-0 right-0 flex h-full items-center p-2',
                  row.isSelected ? '' : isHoveredOrFocused ? '' : 'invisible',
                  isFocused && 'visible',
                )}
              >
                <div className="z-[1]">{row.rowActions}</div>
                <div
                  className={classNames(
                    'absolute top-0 right-0 z-0 h-full w-full backdrop-blur-[2px]',
                    row.isSelected ? '' : isHoveredOrFocused ? '' : 'invisible',
                  )}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const PageScrollThreshold = 200

function Table<Data>({ table }: { table: TableType<Data> }) {
  const application = useApplication()
  const gridRef = useRef<HTMLDivElement>(null)
  const [pendingFocus, setPendingFocus] = useState<{ rowIndex: number; colIndex: number } | null>(null)

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement, UIEvent>) => {
      if (!table.hasMoreRows) {
        return
      }
      const offset = PageScrollThreshold
      const element = event.currentTarget
      if (element.scrollTop + element.offsetHeight >= element.scrollHeight - offset) {
        table.loadMoreRows()
      }
    },
    [table],
  )

  const {
    id,
    headers,
    rows,
    colCount,
    rowCount,
    selectRow,
    multiSelectRow,
    rangeSelectUpToRow,
    handleRowContextMenu,
    handleActivateRow,
    selectedRows,
    selectionActions,
    canSelectRows,
    canSelectMultipleRows,
    showSelectionActions,
  } = table

  const focusedRowIndex = useRef<number>(0)
  const focusedCellIndex = useRef<number>(0)

  const focusCell = useCallback((rowIndex: number, colIndex: number): boolean => {
    const row = gridRef.current?.querySelector(`[role="row"][aria-rowindex="${rowIndex}"]`)
    const cell = row?.querySelector<HTMLElement>(`[aria-colindex="${colIndex}"]`)
    if (!cell) {
      return false
    }
    cell.focus()
    return true
  }, [])

  const focusLogicalCell = useCallback(
    (requestedRowIndex: number, colIndex: number) => {
      const rowIndex = Math.min(Math.max(requestedRowIndex, 1), rowCount + 1)
      if (focusCell(rowIndex, colIndex)) {
        setPendingFocus(null)
        return
      }
      if (rowIndex <= 1 || rowIndex > rowCount + 1) {
        return
      }

      setPendingFocus({ rowIndex, colIndex })
      table.materializeRow(rowIndex - 2)
    },
    [focusCell, rowCount, table],
  )

  useLayoutEffect(() => {
    if (!pendingFocus) {
      return
    }
    if (pendingFocus.rowIndex > rowCount + 1 || focusCell(pendingFocus.rowIndex, pendingFocus.colIndex)) {
      setPendingFocus(null)
    }
  }, [focusCell, pendingFocus, rowCount, rows])

  const onFocus: React.FocusEventHandler = useCallback((event) => {
    const target = event.target as HTMLElement
    const row = target.closest('[role="row"]') as HTMLElement
    const cell = target.closest('[role="gridcell"],[role="columnheader"]') as HTMLElement
    if (row) {
      focusedRowIndex.current = parseInt(row.getAttribute('aria-rowindex') || '0')
    }
    if (cell) {
      focusedCellIndex.current = parseInt(cell.getAttribute('aria-colindex') || '0')
    }
  }, [])

  const onBlur: React.FocusEventHandler = useCallback((event) => {
    const activeElement = document.activeElement as HTMLElement
    if (activeElement.closest('[role="grid"]') !== event.target) {
      focusedRowIndex.current = 0
      focusedCellIndex.current = 0
    }
  }, [])

  const onKeyDown: React.KeyboardEventHandler = useCallback(
    (event) => {
      const gridElement = event.currentTarget
      const allRenderedRows = gridElement.querySelectorAll<HTMLElement>('[role="row"]')
      const currentRow = Array.from(allRenderedRows).find(
        (row) => row.getAttribute('aria-rowindex') === focusedRowIndex.current.toString(),
      )
      const allFocusableCells = Array.from(currentRow ? currentRow.querySelectorAll<HTMLElement>('[tabindex]') : [])

      switch (event.key) {
        case KeyboardKey.Up:
          event.preventDefault()
          if (focusedRowIndex.current > 1) {
            const previousRow = focusedRowIndex.current - 1
            focusLogicalCell(previousRow, focusedCellIndex.current)
          }
          break
        case KeyboardKey.Down:
          event.preventDefault()
          if (focusedRowIndex.current <= rowCount) {
            const nextRow = focusedRowIndex.current + 1
            focusLogicalCell(nextRow, focusedCellIndex.current)
          }
          break
        case KeyboardKey.Left: {
          event.preventDefault()
          if (!allFocusableCells) {
            return
          }
          const currentCellIndex = allFocusableCells.findIndex(
            (cell) => parseInt(cell.getAttribute('aria-colindex') || '0') === focusedCellIndex.current,
          )
          if (currentCellIndex === 0) {
            return
          }
          const previousCell = allFocusableCells[currentCellIndex - 1]
          if (!previousCell) {
            return
          }
          previousCell.focus()
          break
        }
        case KeyboardKey.Right: {
          event.preventDefault()
          if (!allFocusableCells) {
            return
          }
          const currentCellIndex = allFocusableCells.findIndex(
            (cell) => parseInt(cell.getAttribute('aria-colindex') || '0') === focusedCellIndex.current,
          )
          if (currentCellIndex === allFocusableCells.length - 1) {
            return
          }
          const nextCell = allFocusableCells[currentCellIndex + 1]
          if (!nextCell) {
            return
          }
          nextCell.focus()
          break
        }
        case KeyboardKey.Home:
          event.preventDefault()
          if (event.ctrlKey) {
            focusLogicalCell(1, 1)
          } else {
            if (!allFocusableCells) {
              return
            }
            const firstFocusableCell = allFocusableCells[0]
            if (!firstFocusableCell) {
              return
            }
            const firstCellIndex = parseInt(firstFocusableCell.getAttribute('aria-colindex') || '0')
            if (firstCellIndex > 0) {
              focusLogicalCell(focusedRowIndex.current, firstCellIndex)
            }
          }
          break
        case KeyboardKey.End: {
          event.preventDefault()
          if (event.ctrlKey) {
            const lastVisibleColumnIndex = headers.filter((header) => !header.hidden).at(-1)?.colIndex
            focusLogicalCell(rowCount > 0 ? rowCount + 1 : 1, (lastVisibleColumnIndex ?? Math.max(colCount - 1, 0)) + 1)
            return
          }
          if (!allFocusableCells) {
            return
          }
          const lastFocusableCell = allFocusableCells[allFocusableCells.length - 1]
          if (!lastFocusableCell) {
            return
          }
          const lastCellIndex = parseInt(lastFocusableCell.getAttribute('aria-colindex') || '0')
          if (lastCellIndex > 0) {
            focusLogicalCell(focusedRowIndex.current, lastCellIndex)
          }
          break
        }
        case KeyboardKey.PageUp: {
          event.preventDefault()
          const previousRow = focusedRowIndex.current - 5
          if (previousRow > 0) {
            focusLogicalCell(previousRow, focusedCellIndex.current)
          } else {
            focusLogicalCell(1, focusedCellIndex.current)
          }
          break
        }
        case KeyboardKey.PageDown: {
          event.preventDefault()
          const nextRow = Math.min(focusedRowIndex.current + 5, rowCount + 1)
          focusLogicalCell(nextRow, focusedCellIndex.current)
          break
        }
        case KeyboardKey.Enter: {
          const target = event.target as HTMLElement
          const closestColumnHeader = target.closest<HTMLElement>('[role="columnheader"]')
          if (closestColumnHeader && closestColumnHeader.getAttribute('data-can-sort')) {
            event.preventDefault()
            closestColumnHeader.click()
            return
          }
          if (isInteractiveTableEventTarget(target)) {
            return
          }
          const currentRowId = currentRow?.id
          if (currentRowId) {
            event.preventDefault()
            handleActivateRow(currentRowId)
          }
          break
        }
        case KeyboardKey.Space: {
          const target = event.target as HTMLElement
          const currentRowId = currentRow?.id
          if (!currentRowId) {
            return
          }
          if (target.getAttribute('role') !== 'gridcell') {
            return
          }
          event.preventDefault()
          const isCmdOrCtrlPressed = application.keyboardService.isMac ? event.metaKey : event.ctrlKey
          if (isCmdOrCtrlPressed && canSelectMultipleRows) {
            multiSelectRow(currentRowId)
          } else if (event.shiftKey && canSelectMultipleRows) {
            rangeSelectUpToRow(currentRowId)
          } else {
            selectRow(currentRowId)
          }
          break
        }
        case 'ContextMenu':
        case 'F10': {
          if (event.key === 'F10' && !event.shiftKey) {
            return
          }
          const target = event.target as HTMLElement
          const currentRowId = currentRow?.id
          const trigger = target.closest<HTMLElement>('[role="gridcell"]')
          if (!currentRowId || !trigger || isInteractiveTableEventTarget(target)) {
            return
          }
          event.preventDefault()
          event.stopPropagation()
          const bounds = trigger.getBoundingClientRect()
          handleRowContextMenu(currentRowId, bounds.left, bounds.bottom, trigger)
          break
        }
      }
    },
    [
      application.keyboardService.isMac,
      canSelectMultipleRows,
      colCount,
      focusLogicalCell,
      handleActivateRow,
      handleRowContextMenu,
      headers,
      multiSelectRow,
      rangeSelectUpToRow,
      rowCount,
      selectRow,
    ],
  )

  const handleRowClick = useCallback(
    (event: React.MouseEvent, rowId: string) => {
      if (!canSelectRows) {
        return
      }
      const isCmdOrCtrlPressed = application.keyboardService.isMac ? event.metaKey : event.ctrlKey
      if (isCmdOrCtrlPressed && canSelectMultipleRows) {
        multiSelectRow(rowId)
      } else if (event.shiftKey && canSelectMultipleRows) {
        rangeSelectUpToRow(rowId)
      } else {
        selectRow(rowId)
      }
    },
    [
      application.keyboardService.isMac,
      canSelectMultipleRows,
      canSelectRows,
      multiSelectRow,
      rangeSelectUpToRow,
      selectRow,
    ],
  )

  return (
    <div className="block min-h-0 overflow-auto" onScroll={onScroll}>
      {showSelectionActions && selectedRows.length >= 2 && (
        <div className="border-border bg-default sticky top-0 z-[2] flex items-center justify-between border-b px-3 py-2">
          <span className="text-info-0 text-sm font-medium">{selectedRows.length} selected</span>
          {selectedRows.length > 0 && selectionActions}
        </div>
      )}
      <div
        className="relative grid w-full overflow-x-hidden px-3"
        role="grid"
        ref={gridRef}
        aria-colcount={colCount}
        aria-rowcount={rowCount}
        aria-multiselectable={canSelectMultipleRows}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        id={`table-${id}`}
      >
        <div role="row" aria-rowindex={1} className="contents">
          {headers
            .filter((header) => !header.hidden)
            .map((header, index) => {
              return (
                <div
                  role="columnheader"
                  aria-rowindex={1}
                  aria-colindex={header.colIndex + 1}
                  aria-sort={header.isSorting ? (header.sortReversed ? 'descending' : 'ascending') : 'none'}
                  className={classNames(
                    'border-border text-passive-0 border-b px-3 pt-3 pb-2 text-left text-sm font-medium',
                    header.sortBy &&
                      'hover:bg-info-backdrop focus:border-info focus:bg-info-backdrop cursor-pointer hover:underline',
                  )}
                  style={{
                    gridColumn: index + 1,
                  }}
                  onClick={header.onSortChange}
                  key={index.toString()}
                  data-can-sort={header.sortBy ? true : undefined}
                  {...(header.sortBy && { tabIndex: index === 0 ? 0 : -1 })}
                >
                  <div className="flex items-center gap-1">
                    {header.name}
                    {header.isSorting && (
                      <Icon
                        type={header.sortReversed ? 'arrow-up' : 'arrow-down'}
                        size="custom"
                        className="text-passive-1 h-4.5 w-4.5"
                      />
                    )}
                  </div>
                </div>
              )
            })}
        </div>
        <div className="contents whitespace-nowrap">
          {rows.map((row) => (
            <TableRow
              row={row}
              key={row.id}
              index={row.rowIndex}
              canSelectRows={canSelectRows}
              handleRowClick={handleRowClick}
              handleRowContextMenu={handleRowContextMenu}
              handleActivateRow={handleActivateRow}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export default Table
