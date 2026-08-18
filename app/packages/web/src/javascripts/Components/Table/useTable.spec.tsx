/** @jest-environment jsdom */
import { act, createElement, useEffect } from 'react'
import { createRoot, Root } from 'react-dom/client'
import { Table } from './CommonTypes'
import { useTable } from './useTable'

jest.mock('@standardnotes/snjs', () => ({
  UuidGenerator: { GenerateUuid: () => 'table-test-id' },
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Row = { id: string; title: string }

const data: Row[] = [
  { id: 'a', title: 'Alpha' },
  { id: 'b', title: 'Beta' },
]

let latestTable: Table<Row>
const captureLatestTable = (table: Table<Row>) => {
  latestTable = table
}

const Harness = ({
  selectedRowIds,
  onRowSelectionChange,
}: {
  selectedRowIds?: string[]
  onRowSelectionChange?: (rowIds: string[]) => void
}) => {
  const table = useTable({
    data,
    columns: [{ name: 'Name', cell: (row) => row.title }],
    getRowId: (row) => row.id,
    enableRowSelection: true,
    enableMultipleRowSelection: true,
    selectedRowIds,
    onRowSelectionChange,
  })

  useEffect(() => captureLatestTable(table), [table])
  return null
}

const makeRows = (count: number): Row[] =>
  Array.from({ length: count }, (_, index) => ({ id: `row-${index}`, title: `Row ${index}` }))

const paginationRenderSpy = jest.fn()
const renderCell = jest.fn((row: Row) => row.title)
const renderRowActions = jest.fn((row: Row) => `Actions ${row.id}`)

const PaginationHarness = ({ rows }: { rows: Row[] }) => {
  const table = useTable({
    data: rows,
    columns: [{ name: 'Name', cell: renderCell }],
    getRowId: (row) => row.id,
    rowActions: renderRowActions,
    enableRowSelection: true,
    enableMultipleRowSelection: true,
  })

  useEffect(() => {
    captureLatestTable(table)
    paginationRenderSpy()
  }, [table])
  return null
}

describe('useTable controlled selection', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    paginationRenderSpy.mockClear()
    renderCell.mockClear()
    renderRowActions.mockClear()
    container = document.createElement('div')
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
  })

  it('applies external select-all and clear updates without echoing stale internal rows', () => {
    const onSelectionChange = jest.fn()

    act(() => root.render(createElement(Harness, { selectedRowIds: ['a'], onRowSelectionChange: onSelectionChange })))
    expect(latestTable.selectedRows).toEqual(['a'])
    expect(onSelectionChange).not.toHaveBeenCalled()

    act(() =>
      root.render(createElement(Harness, { selectedRowIds: ['a', 'b'], onRowSelectionChange: onSelectionChange })),
    )
    expect(latestTable.selectedRows).toEqual(['a', 'b'])
    expect(onSelectionChange).not.toHaveBeenCalled()

    act(() => root.render(createElement(Harness, { selectedRowIds: [], onRowSelectionChange: onSelectionChange })))
    expect(latestTable.selectedRows).toEqual([])
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('emits a controlled proposal exactly once while a rejecting parent remains authoritative', () => {
    const onSelectionChange = jest.fn()
    const stableSelection: string[] = []
    act(() =>
      root.render(createElement(Harness, { selectedRowIds: stableSelection, onRowSelectionChange: onSelectionChange })),
    )

    act(() => latestTable.multiSelectRow('a'))

    expect(latestTable.selectedRows).toBe(stableSelection)
    expect(latestTable.selectedRows).toEqual([])
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['a'])

    act(() =>
      root.render(createElement(Harness, { selectedRowIds: stableSelection, onRowSelectionChange: onSelectionChange })),
    )
    expect(latestTable.selectedRows).toEqual([])
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
  })

  it('accepts a controlled proposal on the parent round-trip without echoing it', () => {
    const onSelectionChange = jest.fn()
    act(() => root.render(createElement(Harness, { selectedRowIds: [], onRowSelectionChange: onSelectionChange })))

    act(() => latestTable.selectRow('a'))
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['a'])

    act(() => root.render(createElement(Harness, { selectedRowIds: ['a'], onRowSelectionChange: onSelectionChange })))
    expect(latestTable.selectedRows).toEqual(['a'])
    expect(onSelectionChange).toHaveBeenCalledTimes(1)
  })

  it('keeps uncontrolled table selection behavior', () => {
    const onSelectionChange = jest.fn()
    act(() => root.render(createElement(Harness, { onRowSelectionChange: onSelectionChange })))

    act(() => latestTable.selectRow('b'))
    expect(latestTable.selectedRows).toEqual(['b'])

    act(() => latestTable.multiSelectRow('a'))
    expect(latestTable.selectedRows).toEqual(['b', 'a'])
    expect(onSelectionChange).toHaveBeenCalledTimes(2)
    expect(onSelectionChange).toHaveBeenLastCalledWith(['b', 'a'])
  })

  it('materializes a bounded page while keeping the public logical counts coherent', () => {
    const rows = makeRows(75)
    act(() => root.render(createElement(PaginationHarness, { rows })))

    const initialVisibleRows = latestTable.rows.length
    expect(initialVisibleRows).toBeGreaterThan(0)
    expect(initialVisibleRows).toBeLessThan(rows.length)
    expect(latestTable.rowCount).toBe(rows.length)
    expect(latestTable.hasMoreRows).toBe(true)
    expect(renderCell).toHaveBeenCalledTimes(initialVisibleRows)
    expect(renderRowActions).toHaveBeenCalledTimes(initialVisibleRows)

    act(() => latestTable.loadMoreRows())

    expect(latestTable.rows.length).toBeGreaterThan(initialVisibleRows)
    expect(latestTable.rowCount).toBe(rows.length)
  })

  it('does not rerender when pagination is requested after every row is visible', () => {
    act(() => root.render(createElement(PaginationHarness, { rows: makeRows(3) })))
    expect(latestTable.hasMoreRows).toBe(false)
    const renderCountAtEnd = paginationRenderSpy.mock.calls.length

    act(() => latestTable.loadMoreRows())

    expect(paginationRenderSpy).toHaveBeenCalledTimes(renderCountAtEnd)
    expect(latestTable.rows).toHaveLength(3)
  })

  it('clamps on shrink and restores at least one bounded page when data grows again', () => {
    act(() => root.render(createElement(PaginationHarness, { rows: makeRows(75) })))
    act(() => latestTable.loadMoreRows())
    expect(latestTable.rows.length).toBeGreaterThan(20)

    act(() => root.render(createElement(PaginationHarness, { rows: makeRows(5) })))
    expect(latestTable.rows).toHaveLength(5)
    expect(latestTable.hasMoreRows).toBe(false)

    act(() => root.render(createElement(PaginationHarness, { rows: makeRows(75) })))
    expect(latestTable.rows.length).toBeGreaterThanOrEqual(20)
    expect(latestTable.rows.length).toBeLessThan(75)
  })

  it('range-selects across logical rows that have not been materialized yet', () => {
    act(() => root.render(createElement(PaginationHarness, { rows: makeRows(75) })))
    expect(latestTable.rows.length).toBeLessThan(75)

    act(() => latestTable.selectRow('row-0'))
    act(() => latestTable.rangeSelectUpToRow('row-30'))

    expect(latestTable.selectedRows).toHaveLength(31)
    expect(latestTable.selectedRows[0]).toBe('row-0')
    expect(latestTable.selectedRows[30]).toBe('row-30')
  })

  it('materializes only the bounded page containing a requested logical row', () => {
    const rows = makeRows(75)
    act(() => root.render(createElement(PaginationHarness, { rows })))
    const initialVisibleRows = latestTable.rows.length
    renderCell.mockClear()
    renderRowActions.mockClear()

    act(() => latestTable.materializeRow(74))

    expect(latestTable.rows.some((row) => row.rowIndex === 74)).toBe(true)
    expect(latestTable.rows.length).toBeGreaterThan(initialVisibleRows)
    expect(latestTable.rows.length).toBeLessThan(rows.length)
    expect(renderCell).toHaveBeenCalledTimes(latestTable.rows.length)
    expect(renderRowActions).toHaveBeenCalledTimes(latestTable.rows.length)
  })
})
