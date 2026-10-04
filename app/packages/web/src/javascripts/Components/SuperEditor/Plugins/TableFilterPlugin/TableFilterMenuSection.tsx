/**
 * The Filtering section of the selection-scoped table actions menu.
 *
 * This is the ONLY thing table filtering adds to
 * `TableCellActionMenuPlugin/index.tsx`: a single element placed inside the
 * existing `<Menu>`. The container, `moveMenu`, `setMenuButtonPosition`, the
 * scroll/resize listeners and the `createPortal` call are untouched, because
 * t113-A is concurrently mirroring that primitive for mermaid charts.
 *
 * The disclosure expands IN PLACE rather than opening a nested Popover:
 * `useListKeyboardNavigation` collects `button, div[role="button"]` with a
 * subtree MutationObserver, so an in-place expansion stays arrow-key navigable
 * automatically while a portaled nested Popover would not.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getTableNodeFromLexicalNodeOrThrow, TableCellNode, TableNode } from '@lexical/table'
import { HISTORY_MERGE_TAG } from 'lexical'
import { useCallback, useEffect, useState } from 'react'

import MenuItem from '@/Components/Menu/MenuItem'
import MenuItemSeparator from '@/Components/Menu/MenuItemSeparator'

import TableFilterPanel from './TableFilterPanel'
import {
  ColumnCombinator,
  ColumnType,
  describeConditionsForLabel,
  FilterCondition,
  filterIndicatorText,
  filterIsDisclosable,
  FilterSummary,
} from './tableFilterModel'
import {
  $clearTableFilters,
  $ensureColumnId,
  $projectTableFilters,
  $readTableGrid,
  $setTableColumnFilter,
  TableFilterProjection,
} from './tableFilterState'

type Snapshot = {
  columnIndex: number
  columnLabel: string
  columnType: ColumnType
  conditions: FilterCondition[]
  combinator: ColumnCombinator
  columnDescription: string | null
  summary: FilterSummary
  unreadable: string[]
}

/** The grid position whose own cell is this one, or -1. */
const columnIndexOfCell = (projection: TableFilterProjection, cellKey: string): number => {
  for (const row of projection.grid.grid) {
    for (let columnIndex = 0; columnIndex < row.length; columnIndex++) {
      const value = row[columnIndex]
      if (value && value.startColumn === columnIndex && value.cell.getKey() === cellKey) {
        return columnIndex
      }
    }
  }
  return -1
}

const TableFilterMenuSection = ({ tableCellNode }: { tableCellNode: TableCellNode }) => {
  const [editor] = useLexicalComposerContext()
  const [expanded, setExpanded] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)

  const readSnapshot = useCallback(
    (): Snapshot | null =>
      editor.getEditorState().read(() => {
        if (!tableCellNode.isAttached()) {
          return null
        }
        const tableNode = $getTableNodeFromLexicalNodeOrThrow(tableCellNode)
        const projection = $projectTableFilters(tableNode)
        const columnIndex = columnIndexOfCell(projection, tableCellNode.getKey())
        const column = projection.columns[columnIndex]
        if (columnIndex < 0 || !column) {
          return null
        }
        const filter =
          column.columnId === null
            ? undefined
            : projection.state.filters.find((entry) => entry.columnId === column.columnId)
        return {
          columnIndex,
          columnLabel: column.label,
          columnType: column.type,
          conditions: filter ? filter.conditions : [],
          combinator: filter ? filter.combinator : 'all',
          columnDescription: filter ? describeConditionsForLabel(filter, column.type) : null,
          summary: projection.summary,
          unreadable: projection.state.unreadable,
        }
      }),
    [editor, tableCellNode],
  )

  useEffect(() => {
    setSnapshot(readSnapshot())
    return editor.registerUpdateListener(() => {
      setSnapshot(readSnapshot())
    })
  }, [editor, readSnapshot])

  const withTable = useCallback(
    (run: (tableNode: TableNode) => void, tag?: typeof HISTORY_MERGE_TAG) => {
      editor.update(
        () => {
          if (!tableCellNode.isAttached()) {
            return
          }
          run($getTableNodeFromLexicalNodeOrThrow(tableCellNode))
        },
        tag ? { tag } : undefined,
      )
    },
    [editor, tableCellNode],
  )

  const onChange = useCallback(
    (conditions: FilterCondition[], combinator: ColumnCombinator) => {
      const columnIndex = snapshot?.columnIndex
      if (columnIndex === undefined) {
        return
      }
      withTable((tableNode) => {
        const columnId = $ensureColumnId($readTableGrid(tableNode), columnIndex)
        if (columnId === null) {
          return
        }
        $setTableColumnFilter(tableNode, columnId, conditions.length === 0 ? null : { combinator, conditions })
      }, HISTORY_MERGE_TAG)
    },
    [snapshot, withTable],
  )

  const onClearColumn = useCallback(() => {
    const columnIndex = snapshot?.columnIndex
    if (columnIndex === undefined) {
      return
    }
    withTable((tableNode) => {
      const columnId = $ensureColumnId($readTableGrid(tableNode), columnIndex)
      if (columnId !== null) {
        $setTableColumnFilter(tableNode, columnId, null)
      }
    })
  }, [snapshot, withTable])

  const onClearAll = useCallback(() => {
    withTable((tableNode) => {
      $clearTableFilters(tableNode)
    })
  }, [withTable])

  if (snapshot === null) {
    return null
  }

  const disclosable = filterIsDisclosable(snapshot.summary)

  return (
    <div data-srn-table-filter-section="true">
      <MenuItemSeparator />
      <div className="text-text px-3 py-1 text-sm font-semibold uppercase lg:text-xs">Filtering</div>
      <div className="text-passive-0 px-3 pb-1 text-xs" role="status" data-srn-table-filter-menu-status="true">
        {disclosable
          ? filterIndicatorText(snapshot.summary)
          : `No filter. All ${snapshot.summary.total} ${snapshot.summary.total === 1 ? 'row' : 'rows'} shown.`}
      </div>
      <MenuItem
        icon="tune"
        aria-expanded={expanded}
        data-srn-table-filter-disclosure="true"
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? 'Hide' : 'Filter'} {snapshot.columnLabel}
        {snapshot.columnDescription ? ` (${snapshot.columnDescription})` : ''}
      </MenuItem>
      {expanded && (
        <div className="px-3 pb-2">
          <TableFilterPanel
            columnLabel={snapshot.columnLabel}
            columnType={snapshot.columnType}
            conditions={snapshot.conditions}
            combinator={snapshot.combinator}
            statusText={disclosable ? filterIndicatorText(snapshot.summary) : null}
            unreadable={snapshot.unreadable}
            onChange={onChange}
            onClear={onClearColumn}
          />
        </div>
      )}
      {snapshot.columnDescription !== null && (
        <MenuItem data-srn-table-filter-clear-this-column="true" onClick={onClearColumn}>
          Clear filter on {snapshot.columnLabel}
        </MenuItem>
      )}
      {disclosable && (
        <MenuItem data-srn-table-filter-show-all="true" onClick={onClearAll}>
          Show all rows
        </MenuItem>
      )}
    </div>
  )
}

export default TableFilterMenuSection
