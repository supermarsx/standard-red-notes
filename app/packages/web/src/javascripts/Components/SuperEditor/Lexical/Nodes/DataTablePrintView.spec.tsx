/** @jest-environment jsdom */

import { applyLiveDataTableEdits, DataTableData, getDataTablePrintSnapshot } from './DataTableNode'

describe('getDataTablePrintSnapshot', () => {
  it('returns every underlying row regardless of the interactive page size', () => {
    const data: DataTableData = {
      columns: ['Name', 'Count'],
      rows: Array.from({ length: 31 }, (_, index) => [`Row ${index + 1}`, String(index + 1)]),
      columnTypes: ['text', 'number'],
      rowsPerPage: 10,
    }

    const snapshot = getDataTablePrintSnapshot(data)

    expect(snapshot.columns).toEqual(['Name', 'Count'])
    expect(snapshot.rows).toHaveLength(31)
    expect(snapshot.rows[0]).toEqual(['Row 1', '1'])
    expect(snapshot.rows[30]).toEqual(['Row 31', '31'])
  })

  it('overlays an unsaved live cell edit without mutating paging or stored data', () => {
    const data: DataTableData = {
      columns: ['Name'],
      rows: [['Saved value'], ['Off-page value']],
      rowsPerPage: 1,
    }
    const liveTable = document.createElement('div')
    liveTable.innerHTML =
      '<input data-srn-datatable-row-index="0" data-srn-datatable-column-index="0" value="Latest unsaved value">'

    const snapshot = applyLiveDataTableEdits(getDataTablePrintSnapshot(data), liveTable)

    expect(snapshot.rows).toEqual([['Latest unsaved value'], ['Off-page value']])
    expect(data.rows).toEqual([['Saved value'], ['Off-page value']])
    expect(data.rowsPerPage).toBe(1)
  })
})
