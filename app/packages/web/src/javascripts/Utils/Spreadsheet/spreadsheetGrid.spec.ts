import { gridToAOA, gridToStringRows, parseSpreadsheetGrids, SpreadsheetGrid } from './spreadsheetGrid'

const kendoJSON = (sheets: unknown): string => JSON.stringify({ sheets })

describe('parseSpreadsheetGrids', () => {
  it('densifies a sparse Kendo sheet into a rectangular grid', () => {
    const text = kendoJSON([
      {
        name: 'Budget',
        rows: [
          { index: 0, cells: [{ index: 0, value: 'Item' }, { index: 1, value: 'Cost' }] },
          { index: 2, cells: [{ index: 0, value: 'Rent' }, { index: 1, value: 1200 }] },
        ],
      },
    ])

    const grids = parseSpreadsheetGrids(text)

    expect(grids).toHaveLength(1)
    expect(grids[0].name).toBe('Budget')
    // Row index 1 was omitted -> filled with empty cells; gap column preserved.
    expect(grids[0].rows).toEqual([
      ['Item', 'Cost'],
      [null, null],
      ['Rent', 1200],
    ])
  })

  it('preserves numeric and boolean cell types, stringifies others', () => {
    const text = kendoJSON([
      {
        name: 'Types',
        rows: [
          {
            index: 0,
            cells: [
              { index: 0, value: 42 },
              { index: 1, value: 'hello' },
              { index: 2, value: true },
              { index: 3, value: { nested: 1 } },
            ],
          },
        ],
      },
    ])

    const [grid] = parseSpreadsheetGrids(text)

    expect(grid.rows[0][0]).toBe(42)
    expect(grid.rows[0][1]).toBe('hello')
    expect(grid.rows[0][2]).toBe(true)
    expect(typeof grid.rows[0][3]).toBe('string')
  })

  it('handles cells with omitted index by falling back to array position', () => {
    const text = kendoJSON([
      {
        name: 'NoIndex',
        rows: [{ cells: [{ value: 'a' }, { value: 'b' }] }],
      },
    ])

    const [grid] = parseSpreadsheetGrids(text)
    expect(grid.rows).toEqual([['a', 'b']])
  })

  it('returns an empty grid (no rows) for a sheet with no populated cells', () => {
    const text = kendoJSON([{ name: 'Empty', rows: [] }])
    const [grid] = parseSpreadsheetGrids(text)
    expect(grid.name).toBe('Empty')
    expect(grid.rows).toEqual([])
  })

  it('returns [] for invalid JSON', () => {
    expect(parseSpreadsheetGrids('not json{')).toEqual([])
  })

  it('returns [] when there are no sheets', () => {
    expect(parseSpreadsheetGrids(JSON.stringify({ rows: 200, columns: 50 }))).toEqual([])
    expect(parseSpreadsheetGrids('{}')).toEqual([])
  })

  it('defaults the sheet name when missing', () => {
    const text = kendoJSON([{ rows: [{ index: 0, cells: [{ index: 0, value: 'x' }] }] }])
    const [grid] = parseSpreadsheetGrids(text)
    expect(grid.name).toBe('Sheet1')
  })

  it('parses multiple sheets', () => {
    const text = kendoJSON([
      { name: 'One', rows: [{ index: 0, cells: [{ index: 0, value: 1 }] }] },
      { name: 'Two', rows: [{ index: 0, cells: [{ index: 0, value: 2 }] }] },
    ])
    const grids = parseSpreadsheetGrids(text)
    expect(grids.map((g) => g.name)).toEqual(['One', 'Two'])
    expect(grids[1].rows).toEqual([[2]])
  })
})

describe('gridToAOA', () => {
  it('replaces empty cells with empty strings and keeps value types', () => {
    const grid: SpreadsheetGrid = {
      name: 's',
      rows: [
        ['a', 1, null],
        [null, true, 'b'],
      ],
    }
    expect(gridToAOA(grid)).toEqual([
      ['a', 1, ''],
      ['', true, 'b'],
    ])
  })

  it('returns [] for an empty grid', () => {
    expect(gridToAOA({ name: 's', rows: [] })).toEqual([])
  })
})

describe('gridToStringRows', () => {
  it('stringifies all cells, empty cells become empty strings', () => {
    const grid: SpreadsheetGrid = {
      name: 's',
      rows: [
        ['a', 1, null],
        [false, null, 'b'],
      ],
    }
    expect(gridToStringRows(grid)).toEqual([
      ['a', '1', ''],
      ['false', '', 'b'],
    ])
  })

  it('returns [] for an empty grid', () => {
    expect(gridToStringRows({ name: 's', rows: [] })).toEqual([])
  })
})
