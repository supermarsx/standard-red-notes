import * as XLSX from 'xlsx'
import { buildSpreadsheetXlsx } from './exportSpreadsheet'

const spreadsheetNote = (sheets: unknown): string => JSON.stringify({ sheets })

describe('buildSpreadsheetXlsx', () => {
  it('round-trips multiple sheets and preserves scalar cell types', async () => {
    const output = await buildSpreadsheetXlsx(
      spreadsheetNote([
        {
          name: 'Budget',
          rows: [
            {
              cells: [{ value: 'Item' }, { value: 'Cost' }, { value: 'Paid' }],
            },
            {
              cells: [{ value: 'Rent' }, { value: 1200 }, { value: true }],
            },
          ],
        },
        {
          name: 'budget',
          rows: [{ cells: [{ value: 'duplicate name' }] }],
        },
      ]),
    )

    const workbook = XLSX.read(output, { type: 'array' })
    expect(workbook.SheetNames).toEqual(['Budget', 'budget_1'])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Budget, { header: 1, raw: true })).toEqual([
      ['Item', 'Cost', 'Paid'],
      ['Rent', 1200, true],
    ])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.budget_1, { header: 1, raw: true })).toEqual([['duplicate name']])
  })

  it('produces a valid empty workbook for malformed note data', async () => {
    const output = await buildSpreadsheetXlsx('not json')
    const workbook = XLSX.read(output, { type: 'array' })

    expect(workbook.SheetNames).toEqual(['Sheet1'])
    expect(XLSX.utils.sheet_to_json(workbook.Sheets.Sheet1, { header: 1, raw: true })).toEqual([])
  })
})
