import { normalizeRows } from './parseCsv'

/**
 * Shape of the Super editor's DataTableNode payload. Mirrors `DataTableData`
 * (and `SerializedDataTableNode`) in the web package's
 * `Components/SuperEditor/Lexical/Nodes/DataTableNode.tsx`. The first CSV row
 * becomes the column headers and the remaining rows become the table body.
 */
export type DataTableData = { columns: string[]; rows: string[][] }

export function csvRowsToDataTableData(rows: string[][]): DataTableData {
  if (rows.length === 0) {
    return { columns: [], rows: [] }
  }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0)
  const normalized = normalizeRows(rows, width)

  const [header, ...body] = normalized

  return {
    columns: header,
    rows: body,
  }
}

/**
 * Builds a serialized Lexical editor-state JSON string for a Super note whose
 * only block is a `datatable` node populated from the CSV rows.
 *
 * The DataTableNode is a top-level DecoratorNode (`isInline()` === false), so it
 * is a valid direct child of the root. Lexical fills in any missing optional
 * fields when it parses this state, and the resulting string round-trips through
 * `SuperConverterServiceInterface.isValidSuperString`.
 */
export function csvToDataTableSuperString(rows: string[][]): string {
  const data = csvRowsToDataTableData(rows)

  const editorState = {
    root: {
      children: [
        {
          type: 'datatable',
          version: 1,
          data,
        },
      ],
      direction: null,
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }

  return JSON.stringify(editorState)
}
