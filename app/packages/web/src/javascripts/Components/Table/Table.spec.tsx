/** @jest-environment jsdom */
import { act, createElement, useCallback, useState } from 'react'
import { createRoot, Root } from 'react-dom/client'
import Table from './Table'
import { Table as TableContract } from './CommonTypes'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('../ApplicationProvider', () => ({ useApplication: () => ({ keyboardService: { isMac: false } }) }))
jest.mock('../Icon/Icon', () => () => null)

type Row = { id: string }

const activateRow = jest.fn()
const loadMoreRows = jest.fn()
const materializeRow = jest.fn()
const selectRow = jest.fn()
const openRowContextMenu = jest.fn()

const createTable = (hasMoreRows = false): TableContract<Row> => ({
  id: 'table-test',
  headers: [
    {
      name: 'Name',
      isSorting: false,
      sortReversed: false,
      onSortChange: jest.fn(),
      hidden: false,
      colIndex: 0,
    },
  ],
  rows: [
    {
      id: 'row-1',
      rowIndex: 0,
      isSelected: false,
      rowData: { id: 'row-1' },
      cells: [
        {
          hidden: false,
          colIndex: 0,
          render: (
            <div>
              <span data-testid="plain-cell-content">Plain content</span>
              <button type="button" data-testid="native-action">
                Native action
              </button>
              <span role="menuitem" tabIndex={0} data-testid="aria-action">
                ARIA action
              </span>
              <span role="tab" tabIndex={0} data-testid="aria-tab">
                ARIA tab
              </span>
              <span role="treeitem" tabIndex={0} data-testid="aria-treeitem">
                ARIA tree item
              </span>
              <span contentEditable suppressContentEditableWarning data-testid="editable-action">
                Editable action
              </span>
            </div>
          ),
        },
      ],
      rowActions: (
        <button type="button" data-testid="row-action">
          Row action
        </button>
      ),
    },
  ],
  rowCount: 1,
  colCount: 1,
  loadMoreRows,
  materializeRow,
  hasMoreRows,
  selectRow,
  multiSelectRow: jest.fn(),
  rangeSelectUpToRow: jest.fn(),
  handleActivateRow: activateRow,
  handleRowContextMenu: openRowContextMenu,
  canSelectRows: true,
  canSelectMultipleRows: true,
  selectedRows: [],
  selectionActions: undefined,
  showSelectionActions: false,
})

let container: HTMLElement
let root: Root

beforeEach(() => {
  activateRow.mockClear()
  loadMoreRows.mockClear()
  materializeRow.mockClear()
  selectRow.mockClear()
  openRowContextMenu.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const renderTable = (hasMoreRows = false) => {
  act(() => root.render(createElement(Table<Row>, { table: createTable(hasMoreRows) })))
  return container.querySelector('[role="gridcell"]') as HTMLElement
}

describe('Table row activation isolation', () => {
  const interactiveTargets = [
    'native-action',
    'aria-action',
    'aria-tab',
    'aria-treeitem',
    'editable-action',
    'row-action',
  ]

  it.each(interactiveTargets)('does not activate for Enter on %s', (testId) => {
    renderTable()
    const target = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement

    act(() => target.focus())
    act(() => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))

    expect(activateRow).not.toHaveBeenCalled()
  })

  it.each(interactiveTargets)('does not activate for double-click on %s', (testId) => {
    renderTable()
    const target = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement

    act(() => target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))

    expect(activateRow).not.toHaveBeenCalled()
  })

  it.each(interactiveTargets)('does not select a row for click on %s', (testId) => {
    renderTable()
    const target = container.querySelector(`[data-testid="${testId}"]`) as HTMLElement

    act(() => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })))

    expect(selectRow).not.toHaveBeenCalled()
  })

  it('still activates a gridcell through Enter and non-interactive double-click', () => {
    const gridCell = renderTable()

    act(() => gridCell.focus())
    act(() => gridCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    act(() =>
      (container.querySelector('[data-testid="plain-cell-content"]') as HTMLElement).dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      ),
    )

    expect(activateRow).toHaveBeenCalledTimes(2)
    expect(activateRow).toHaveBeenCalledWith('row-1')
  })

  it('still selects an ordinary cell click', () => {
    renderTable()

    act(() =>
      (container.querySelector('[data-testid="plain-cell-content"]') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      ),
    )

    expect(selectRow).toHaveBeenCalledTimes(1)
    expect(selectRow).toHaveBeenCalledWith('row-1')
  })

  it('opens the row menu from right-click without selecting or activating the row', () => {
    const gridCell = renderTable()

    act(() =>
      gridCell.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 7, clientY: 9 }),
      ),
    )

    expect(openRowContextMenu).toHaveBeenCalledWith('row-1', 7, 9, gridCell)
    expect(selectRow).not.toHaveBeenCalled()
    expect(activateRow).not.toHaveBeenCalled()
  })

  it.each([
    ['Shift+F10', { key: 'F10', shiftKey: true }],
    ['ContextMenu', { key: 'ContextMenu' }],
  ])('opens the focused row menu from %s without activating it', (_label, init) => {
    const gridCell = renderTable()
    act(() => gridCell.focus())

    act(() => gridCell.dispatchEvent(new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })))

    expect(openRowContextMenu).toHaveBeenCalledWith('row-1', expect.any(Number), expect.any(Number), gridCell)
    expect(activateRow).not.toHaveBeenCalled()
  })
})

const keyboardMaterializeRow = jest.fn()

const KeyboardHarness = ({ hideTrailingColumn = false }: { hideTrailingColumn?: boolean }) => {
  const [visibleRowIndexes, setVisibleRowIndexes] = useState([0, 1])
  const handleMaterializeRow = useCallback((rowIndex: number) => {
    keyboardMaterializeRow(rowIndex)
    setVisibleRowIndexes((current) => {
      if (current.includes(rowIndex)) {
        return current
      }
      return [...current, rowIndex].sort((a, b) => a - b)
    })
  }, [])
  const keyboardTable: TableContract<Row> = {
    ...createTable(true),
    headers: [
      {
        name: 'Name',
        isSorting: false,
        sortReversed: false,
        onSortChange: jest.fn(),
        hidden: false,
        colIndex: 0,
      },
      {
        name: 'Hidden trailing column',
        isSorting: false,
        sortReversed: false,
        onSortChange: jest.fn(),
        hidden: hideTrailingColumn,
        colIndex: 1,
      },
    ],
    rows: visibleRowIndexes.map((rowIndex) => ({
      id: `row-${rowIndex}`,
      rowIndex,
      isSelected: false,
      rowData: { id: `row-${rowIndex}` },
      cells: [
        { hidden: false, colIndex: 0, render: `Row ${rowIndex}` },
        { hidden: hideTrailingColumn, colIndex: 1, render: `Trailing ${rowIndex}` },
      ],
    })),
    rowCount: 6,
    colCount: 2,
    materializeRow: handleMaterializeRow,
  }

  return <Table table={keyboardTable} />
}

const getCell = (ariaRowIndex: number, ariaColumnIndex = 1) =>
  container.querySelector(
    `[role="row"][aria-rowindex="${ariaRowIndex}"] [role="gridcell"][aria-colindex="${ariaColumnIndex}"]`,
  ) as HTMLElement

describe('Table logical keyboard navigation', () => {
  beforeEach(() => keyboardMaterializeRow.mockClear())

  it('materializes and focuses the next logical row at a page boundary', () => {
    act(() => root.render(<KeyboardHarness />))
    const lastMaterializedCell = getCell(3)
    act(() => lastMaterializedCell.focus())

    act(() =>
      lastMaterializedCell.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }),
      ),
    )

    expect(keyboardMaterializeRow).toHaveBeenCalledWith(2)
    expect(document.activeElement).toBe(getCell(4))
  })

  it('materializes and focuses the logical PageDown target', () => {
    act(() => root.render(<KeyboardHarness />))
    const firstCell = getCell(2)
    act(() => firstCell.focus())

    act(() =>
      firstCell.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true })),
    )

    expect(keyboardMaterializeRow).toHaveBeenCalledWith(5)
    expect(document.activeElement).toBe(getCell(7))
  })

  it('materializes Ctrl+End and focuses the last visible column when trailing columns are hidden', () => {
    act(() => root.render(<KeyboardHarness hideTrailingColumn />))
    const firstCell = getCell(2)
    act(() => firstCell.focus())

    act(() =>
      firstCell.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    )

    expect(keyboardMaterializeRow).toHaveBeenCalledWith(5)
    expect(document.activeElement).toBe(getCell(7, 1))
  })
})

describe('Table terminal pagination', () => {
  it('does not request another page when all logical rows are already materialized', () => {
    renderTable(false)
    const scroller = container.firstElementChild as HTMLElement
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 100 },
      offsetHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
    })

    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(loadMoreRows).not.toHaveBeenCalled()
  })

  it('requests one bounded page near the bottom when more rows exist', () => {
    renderTable(true)
    const scroller = container.firstElementChild as HTMLElement
    Object.defineProperties(scroller, {
      scrollTop: { configurable: true, value: 100 },
      offsetHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 200 },
    })

    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })))

    expect(loadMoreRows).toHaveBeenCalledTimes(1)
  })
})
