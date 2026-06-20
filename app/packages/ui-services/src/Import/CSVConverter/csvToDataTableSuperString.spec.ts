import { csvRowsToDataTableData, csvToDataTableSuperString } from './csvToDataTableSuperString'
import { parseCsv } from './parseCsv'

describe('csvRowsToDataTableData', () => {
  it('returns empty columns/rows for no input', () => {
    expect(csvRowsToDataTableData([])).toEqual({ columns: [], rows: [] })
  })

  it('uses the first row as columns and the rest as rows', () => {
    const rows = [
      ['Task', 'Owner'],
      ['Build', 'Ada'],
      ['Ship', 'Linus'],
    ]
    expect(csvRowsToDataTableData(rows)).toEqual({
      columns: ['Task', 'Owner'],
      rows: [
        ['Build', 'Ada'],
        ['Ship', 'Linus'],
      ],
    })
  })

  it('normalizes ragged rows to the widest width', () => {
    const rows = [['a', 'b', 'c'], ['1'], ['x', 'y']]
    expect(csvRowsToDataTableData(rows)).toEqual({
      columns: ['a', 'b', 'c'],
      rows: [
        ['1', '', ''],
        ['x', 'y', ''],
      ],
    })
  })
})

describe('csvToDataTableSuperString', () => {
  it('produces a valid Lexical root containing a single datatable node', () => {
    const rows = parseCsv('Name,Status\nA,Done\nB,"In, progress"')
    const json = JSON.parse(csvToDataTableSuperString(rows))

    expect(json.root.type).toBe('root')
    expect(json.root.children).toHaveLength(1)

    const block = json.root.children[0]
    expect(block.type).toBe('datatable')
    expect(block.version).toBe(1)
    expect(block.data).toEqual({
      columns: ['Name', 'Status'],
      rows: [
        ['A', 'Done'],
        ['B', 'In, progress'],
      ],
    })
  })
})
