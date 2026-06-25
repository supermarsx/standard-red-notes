/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import { INSERT_TABLE_COMMAND, TableNode, TableRowNode } from '@lexical/table'
import { $createParagraphNode, LexicalEditor } from 'lexical'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { mergeRegister } from '@lexical/utils'
import DecoratedInput from '@/Components/Input/DecoratedInput'
import Button from '@/Components/Button/Button'
import { isMobileScreen } from '../../../Utils'

/**
 * Table sizing limits, modeled after Microsoft Word's "Insert Table" dialog
 * (Word caps columns at 63). These are exported so that both the insert dialog
 * and the `/NxM` dynamic block shorthand enforce the same caps.
 */
export const MIN_TABLE_COLUMNS = 1
export const MAX_TABLE_COLUMNS = 63
export const MIN_TABLE_ROWS = 1
export const MAX_TABLE_ROWS = 1000

/** Size of the quick-pick hover/drag grid (Word-style). */
export const TABLE_GRID_PICKER_COLUMNS = 10
export const TABLE_GRID_PICKER_ROWS = 8

/**
 * Parses a user-entered size and validates it against the given bounds.
 * Returns the parsed value plus a flag indicating whether it is valid.
 */
export function parseTableDimension(
  value: string,
  min: number,
  max: number,
): { value: number; isValid: boolean } {
  const trimmed = value.trim()
  // Only accept whole, non-negative numbers (the number input can still
  // produce things like "" or "1e3", which we reject here).
  if (!/^\d+$/.test(trimmed)) {
    return { value: NaN, isValid: false }
  }
  const parsed = parseInt(trimmed, 10)
  return { value: parsed, isValid: Number.isInteger(parsed) && parsed >= min && parsed <= max }
}

/** Clamps a number into the inclusive [min, max] range. */
export function clampTableDimension(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min
  }
  return Math.min(Math.max(Math.round(value), min), max)
}

export function InsertTableDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor
  onClose: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState('5')
  const [columns, setColumns] = useState('5')

  const parsedRows = useMemo(() => parseTableDimension(rows, MIN_TABLE_ROWS, MAX_TABLE_ROWS), [rows])
  const parsedColumns = useMemo(
    () => parseTableDimension(columns, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS),
    [columns],
  )

  const isValid = parsedRows.isValid && parsedColumns.isValid

  const insertTable = useCallback(
    (numRows: number, numColumns: number) => {
      const clampedRows = clampTableDimension(numRows, MIN_TABLE_ROWS, MAX_TABLE_ROWS)
      const clampedColumns = clampTableDimension(numColumns, MIN_TABLE_COLUMNS, MAX_TABLE_COLUMNS)
      activeEditor.dispatchCommand(INSERT_TABLE_COMMAND, {
        columns: String(clampedColumns),
        rows: String(clampedRows),
      })
      onClose()
    },
    [activeEditor, onClose],
  )

  const onClick = () => {
    if (!isValid) {
      return
    }
    insertTable(parsedRows.value, parsedColumns.value)
  }

  const focusOnMount = useCallback((element: HTMLInputElement | null) => {
    if (element) {
      setTimeout(() => element.focus())
    }
  }, [])

  return (
    <>
      <TableGridPicker onSelect={insertTable} />
      <label className="mb-2.5 flex items-center justify-between gap-3">
        Columns:
        <DecoratedInput
          type="number"
          value={columns}
          onChange={setColumns}
          onEnter={onClick}
          ref={focusOnMount}
        />
      </label>
      <label className="mb-1 flex items-center justify-between gap-3">
        Rows:
        <DecoratedInput type="number" value={rows} onChange={setRows} onEnter={onClick} />
      </label>
      {!isValid && (
        <div className="mb-2.5 text-xs text-danger" role="alert">
          {!parsedColumns.isValid && (
            <div>
              Columns must be a whole number between {MIN_TABLE_COLUMNS} and {MAX_TABLE_COLUMNS}.
            </div>
          )}
          {!parsedRows.isValid && (
            <div>
              Rows must be a whole number between {MIN_TABLE_ROWS} and {MAX_TABLE_ROWS}.
            </div>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button onClick={onClick} disabled={!isValid} small={isMobileScreen()}>
          Confirm
        </Button>
      </div>
    </>
  )
}

/**
 * A small Word-style hover/drag grid for quickly picking common table sizes.
 * Larger custom sizes are entered via the number inputs below it.
 */
function TableGridPicker({ onSelect }: { onSelect: (rows: number, columns: number) => void }): React.JSX.Element {
  const [hovered, setHovered] = useState<{ rows: number; columns: number } | null>(null)

  const cells = useMemo(() => {
    const result: Array<{ row: number; column: number }> = []
    for (let row = 1; row <= TABLE_GRID_PICKER_ROWS; row++) {
      for (let column = 1; column <= TABLE_GRID_PICKER_COLUMNS; column++) {
        result.push({ row, column })
      }
    }
    return result
  }, [])

  const label = hovered ? `${hovered.columns} × ${hovered.rows} table` : 'Drag to select size'

  return (
    <div className="mb-2.5">
      <div
        className="grid w-fit gap-0.5"
        style={{ gridTemplateColumns: `repeat(${TABLE_GRID_PICKER_COLUMNS}, 1rem)` }}
        onMouseLeave={() => setHovered(null)}
        role="grid"
        aria-label="Table size picker"
      >
        {cells.map(({ row, column }) => {
          const isActive = hovered != null && row <= hovered.rows && column <= hovered.columns
          return (
            <button
              type="button"
              key={`${row}x${column}`}
              className={`h-4 w-4 border ${
                isActive ? 'border-info bg-info' : 'border-border bg-default'
              }`}
              onMouseEnter={() => setHovered({ rows: row, columns: column })}
              onFocus={() => setHovered({ rows: row, columns: column })}
              onClick={() => onSelect(row, column)}
              aria-label={`${column} by ${row} table`}
            />
          )
        })}
      </div>
      <div className="mt-1 text-xs text-passive-1">{label}</div>
    </div>
  )
}

/**
 * Sometimes copy/pasting tables from other sources can result
 * in adding extra table nodes which don't have any children.
 * This causes an error when copying the table or exporting the
 * note as HTML.
 * This plugin removes any tables which don't have any children.
 */
export function RemoveBrokenTablesPlugin() {
  const [editor] = useLexicalComposerContext()

  useEffect(() => {
    return mergeRegister(
      editor.registerNodeTransform(TableRowNode, (node) => {
        if (!node.getFirstChild()) {
          node.remove()
        }
      }),
      editor.registerNodeTransform(TableNode, (node) => {
        if (!node.getFirstChild()) {
          node.remove()
        }
        const hasNextSibling = !!node.getNextSibling()
        const hasPreviousSibling = !!node.getPreviousSibling()
        if (!node.getParent()) {
          return
        }
        if (!hasNextSibling) {
          node.insertAfter($createParagraphNode())
        } else if (!hasPreviousSibling) {
          node.insertBefore($createParagraphNode())
        }
      }),
    )
  }, [editor])

  return null
}
