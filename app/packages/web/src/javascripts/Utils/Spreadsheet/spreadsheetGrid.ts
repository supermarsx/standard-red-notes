/**
 * Data-shaping helpers for the Spreadsheet (`NoteType.Spreadsheet`) note type.
 *
 * Spreadsheet notes are edited by the bundled `@standardnotes/spreadsheets`
 * iframe component (built on Kendo UI Spreadsheet). The note's `text` field is a
 * JSON string produced by Kendo's `Spreadsheet.toJSON()` (plus `rows`/`columns`
 * counts the editor appends). Its shape is:
 *
 * ```json
 * {
 *   "sheets": [
 *     {
 *       "name": "Sheet1",
 *       "rows": [
 *         { "index": 0, "cells": [ { "index": 0, "value": "A1" }, { "index": 2, "value": 42 } ] }
 *       ]
 *     }
 *   ],
 *   "rows": 200,
 *   "columns": 50
 * }
 * ```
 *
 * Both `row.index` and `cell.index` are sparse (omitted rows/cells are empty),
 * so we re-densify them into a rectangular 2D grid. These helpers are pure (no
 * DOM, no heavy libs) and are the unit-tested core of the .xlsx / .docx export.
 */

/** A single sheet flattened to a dense, rectangular grid of cell values. */
export type SpreadsheetGrid = {
  /** Sheet name, used as the worksheet tab name / docx heading. */
  name: string
  /**
   * Dense rows of cell values. `null` represents an empty cell. Numbers are
   * preserved as numbers (so .xlsx treats them numerically); everything else is
   * coerced to a string.
   */
  rows: Array<Array<string | number | boolean | null>>
}

type KendoCell = {
  index?: number
  value?: unknown
}

type KendoRow = {
  index?: number
  cells?: KendoCell[]
}

type KendoSheet = {
  name?: unknown
  rows?: KendoRow[]
}

type KendoSpreadsheetJSON = {
  sheets?: KendoSheet[]
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

/**
 * Coerce a raw Kendo cell value to a value suitable for export. Finite numbers
 * and booleans are kept as-is (so .xlsx stores them with the right type);
 * `null`/`undefined` become `null` (empty cell); anything else is stringified.
 */
const coerceCellValue = (value: unknown): string | number | boolean | null => {
  if (value === null || value === undefined) {
    return null
  }
  if (isFiniteNumber(value) || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value
  }
  return String(value)
}

/**
 * Parse a spreadsheet note's `text` JSON into a list of dense grids (one per
 * sheet). Returns an empty array when the JSON is missing, invalid, or has no
 * sheets — callers should handle that as "empty sheet".
 */
export const parseSpreadsheetGrids = (noteText: string): SpreadsheetGrid[] => {
  let parsed: KendoSpreadsheetJSON
  try {
    parsed = JSON.parse(noteText) as KendoSpreadsheetJSON
  } catch {
    return []
  }

  if (!parsed || !Array.isArray(parsed.sheets)) {
    return []
  }

  return parsed.sheets.map((sheet, sheetIndex) => kendoSheetToGrid(sheet, sheetIndex))
}

const kendoSheetToGrid = (sheet: KendoSheet, sheetIndex: number): SpreadsheetGrid => {
  const name = typeof sheet.name === 'string' && sheet.name.length > 0 ? sheet.name : `Sheet${sheetIndex + 1}`

  const kendoRows = Array.isArray(sheet.rows) ? sheet.rows : []

  // First pass: determine the bounding box (max row index, max column index)
  // across all populated cells so we can build a rectangular grid.
  let maxRowIndex = -1
  let maxColIndex = -1

  for (let i = 0; i < kendoRows.length; i++) {
    const row = kendoRows[i]
    const rowIndex = isFiniteNumber(row?.index) ? row.index : i
    const cells = Array.isArray(row?.cells) ? row.cells : []
    if (cells.length === 0) {
      continue
    }
    maxRowIndex = Math.max(maxRowIndex, rowIndex)
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      const colIndex = isFiniteNumber(cell?.index) ? cell.index : c
      if (coerceCellValue(cell?.value) !== null) {
        maxColIndex = Math.max(maxColIndex, colIndex)
      }
    }
  }

  if (maxRowIndex < 0 || maxColIndex < 0) {
    return { name, rows: [] }
  }

  const width = maxColIndex + 1
  const rows: SpreadsheetGrid['rows'] = Array.from({ length: maxRowIndex + 1 }, () =>
    Array.from({ length: width }, () => null as string | number | boolean | null),
  )

  for (let i = 0; i < kendoRows.length; i++) {
    const row = kendoRows[i]
    const rowIndex = isFiniteNumber(row?.index) ? row.index : i
    if (rowIndex < 0 || rowIndex > maxRowIndex) {
      continue
    }
    const cells = Array.isArray(row?.cells) ? row.cells : []
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c]
      const colIndex = isFiniteNumber(cell?.index) ? cell.index : c
      if (colIndex < 0 || colIndex > maxColIndex) {
        continue
      }
      rows[rowIndex][colIndex] = coerceCellValue(cell?.value)
    }
  }

  return { name, rows }
}

/**
 * Convert a grid to an array-of-arrays (AOA) suitable for SheetJS
 * `utils.aoa_to_sheet`. Numbers/booleans are preserved by type; empty cells
 * become empty strings (SheetJS treats `null` as a gap but empty string keeps
 * the rectangular shape predictable). An empty grid yields `[]`.
 */
export const gridToAOA = (grid: SpreadsheetGrid): Array<Array<string | number | boolean>> => {
  return grid.rows.map((row) => row.map((cell) => (cell === null ? '' : cell)))
}

/**
 * Flatten a grid to plain string rows for the .docx table. Empty cells become
 * empty strings; numbers/booleans are stringified.
 */
export const gridToStringRows = (grid: SpreadsheetGrid): string[][] => {
  return grid.rows.map((row) => row.map((cell) => (cell === null ? '' : String(cell))))
}
