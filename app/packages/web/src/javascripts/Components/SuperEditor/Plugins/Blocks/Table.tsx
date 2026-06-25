import { BlockPickerOption } from '../BlockPickerPlugin/BlockPickerOption'
import { LexicalEditor } from 'lexical'
import { INSERT_TABLE_COMMAND } from '@lexical/table'
import { LexicalIconName } from '@/Components/Icon/LexicalIcons'
import {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  MIN_TABLE_COLUMNS,
  MIN_TABLE_ROWS,
} from '../TablePlugin'

export function GetTableBlockOption(onSelect: () => void) {
  return new BlockPickerOption('Table', {
    iconName: 'table' as LexicalIconName,
    keywords: ['table', 'grid', 'spreadsheet', 'rows', 'columns'],
    onSelect: onSelect,
  })
}

/** Number of column suggestions to offer when only the rows count is typed. */
const PARTIAL_TABLE_SUGGESTION_COLUMNS = 5

const isRowsInRange = (rows: number) => rows >= MIN_TABLE_ROWS && rows <= MAX_TABLE_ROWS
const isColumnsInRange = (columns: number) => columns >= MIN_TABLE_COLUMNS && columns <= MAX_TABLE_COLUMNS

export function GetDynamicTableBlocks(editor: LexicalEditor, queryString: string) {
  const options: Array<BlockPickerOption> = []

  if (queryString == null) {
    return options
  }

  // The query shorthand is `<rows>x<columns>` (e.g. `3x5`) or a partial
  // `<rows>` / `<rows>x`. We parse loosely and rely on the shared table caps
  // to reject absurd sizes, rather than baking the limits into the regex.
  const fullTableRegex = new RegExp(/^(\d+)x(\d+)$/)
  const partialTableRegex = new RegExp(/^(\d+)x?$/)

  const fullTableMatch = fullTableRegex.exec(queryString)
  const partialTableMatch = partialTableRegex.exec(queryString)

  if (fullTableMatch) {
    const rows = parseInt(fullTableMatch[1], 10)
    const columns = parseInt(fullTableMatch[2], 10)

    if (isRowsInRange(rows) && isColumnsInRange(columns)) {
      options.push(
        new BlockPickerOption(`${rows}x${columns} Table`, {
          iconName: 'table',
          keywords: ['table'],
          onSelect: () =>
            editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: String(columns), rows: String(rows) }),
        }),
      )
    }
  } else if (partialTableMatch) {
    const rows = parseInt(partialTableMatch[1], 10)

    if (isRowsInRange(rows)) {
      options.push(
        ...Array.from({ length: PARTIAL_TABLE_SUGGESTION_COLUMNS }, (_, i) => i + 1)
          .filter((columns) => isColumnsInRange(columns))
          .map(
            (columns) =>
              new BlockPickerOption(`${rows}x${columns} Table`, {
                iconName: 'table',
                keywords: ['table'],
                onSelect: () =>
                  editor.dispatchCommand(INSERT_TABLE_COMMAND, { columns: String(columns), rows: String(rows) }),
              }),
          ),
      )
    }
  }

  return options
}
