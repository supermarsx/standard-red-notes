/**
 * Per-column filtering for Super editor tables.
 *
 * WHAT THIS PLUGIN DOES AND DOES NOT DO
 *   - It decides which BODY rows are visible and sets ONE attribute,
 *     `data-srn-table-filtered`, on their `<tr>`. `TableFilter.scss` turns that
 *     into `display: none` on screen and back into `display: table-row` in
 *     print. No row is ever deleted, reordered or rewritten: a filtered table
 *     is the same document as an unfiltered one.
 *   - It injects a filter chip into every cell of the table's TOP row, so the
 *     headers carry the capability too. The chip paints its own surface and is
 *     never hover-gated, so it survives t115-A's differentiated-headers toggle
 *     being switched off.
 *   - It injects ONE `<caption>` per filtered table carrying the mandatory
 *     "Filtered: showing X of Y rows" disclosure, a Show-all-rows control, a
 *     direct edit route to every active column filter, and the in-place filter
 *     panel. A table showing 3 of 40 rows with no indicator is claiming to be a
 *     3-row table.
 *
 * Injected chrome follows the established in-editor pattern (see
 * `FoldablePlugin` and `ChecklistDueControls`): `contenteditable="false"` plus
 * `setDOMUnmanaged`, so Lexical's MutationObserver skips it instead of evicting
 * it and scheduling another update - the insert/observe/remove/update loop that
 * once froze the app. Lexical observes `characterData`/`childList`/`subtree` and
 * NOT attributes, so the row attribute above is invisible to it.
 *
 * This plugin deliberately touches nothing in `TableCellActionMenuPlugin`'s
 * container or positioning code; the menu side of the feature is one component
 * (`TableFilterMenuSection`) rendered at t115-A's reserved insertion point.
 */

import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useLexicalEditable } from '@lexical/react/useLexicalEditable'
import { mergeRegister } from '@lexical/utils'
import { $isTableNode, TableNode } from '@lexical/table'
import { $getNodeByKey, $nodesOfType, HISTORY_MERGE_TAG, LexicalEditor, setDOMUnmanaged } from 'lexical'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'

import TableFilterPanel from './TableFilterPanel'
import {
  ColumnCombinator,
  ColumnFilter,
  ColumnType,
  conditionIsActive,
  describeConditionsForLabel,
  FilterCondition,
  filterIndicatorText,
  filterIsDisclosable,
  filterPrintNoticeText,
  FilterSummary,
} from './tableFilterModel'
import {
  $clearTableFilters,
  $ensureColumnId,
  $projectTableFilters,
  $readTableGrid,
  $setTableColumnFilter,
} from './tableFilterState'

export const FILTERED_ROW_ATTR = 'data-srn-table-filtered'
export const FILTER_CAPTION_ATTR = 'data-srn-table-filter-caption'
export const FILTER_CHIP_ATTR = 'data-srn-table-filter-chip'
/**
 * The chip's transient pointer back to a live column POSITION. It exists only
 * between a click and the `editor.update` that handles it; it is never stored,
 * and the stored filter is always keyed by the column's minted id. An
 * index-keyed *filter* is the defect this whole module is shaped to avoid.
 */
export const FILTER_CHIP_COLUMN_INDEX_ATTR = 'data-srn-table-filter-chip-column'
export const FILTER_CLEAR_ATTR = 'data-srn-table-filter-clear'
export const FILTER_STATUS_SCREEN_ATTR = 'data-srn-table-filter-status-screen'
export const FILTER_STATUS_PRINT_ATTR = 'data-srn-table-filter-status-print'

const SVG_NS = 'http://www.w3.org/2000/svg'
/** A funnel, drawn rather than named: an unmapped Icon type renders as text. */
const FUNNEL_PATH = 'M1.5 2.5h13l-5 5.75V14l-3-1.75V8.25z'

const createFunnelGlyph = (): SVGSVGElement => {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('class', 'Lexical__tableFilterButtonGlyph')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', FUNNEL_PATH)
  path.setAttribute('fill', 'currentColor')
  svg.appendChild(path)
  return svg
}

/**
 * Build the per-header filter chip, marked Lexical-UNMANAGED.
 *
 * Exported so a test can assert the unmanaged flag and the discoverability
 * contract without an editor mount.
 */
export const createFilterChip = (): HTMLElement => {
  const chip = document.createElement('span')
  chip.setAttribute(FILTER_CHIP_ATTR, 'true')
  chip.setAttribute('contenteditable', 'false')
  chip.setAttribute('role', 'button')
  chip.setAttribute('aria-expanded', 'false')
  chip.tabIndex = -1
  chip.className = 'Lexical__tableFilterButton'
  chip.appendChild(createFunnelGlyph())
  setDOMUnmanaged(chip)
  return chip
}

/** Create or update one header cell's chip. Returns the chip. */
export const syncFilterChip = (
  cellElement: HTMLElement,
  columnIndex: number,
  columnLabel: string,
  activeDescription: string | null,
  isOpen: boolean,
): HTMLElement => {
  const existing = cellElement.querySelector<HTMLElement>(`:scope > [${FILTER_CHIP_ATTR}]`)
  const chip = existing ?? createFilterChip()
  chip.setAttribute(FILTER_CHIP_COLUMN_INDEX_ATTR, String(columnIndex))
  chip.setAttribute('data-srn-table-filter-active', activeDescription === null ? 'false' : 'true')
  chip.setAttribute('aria-expanded', isOpen ? 'true' : 'false')
  const label = activeDescription === null ? `Filter ${columnLabel}` : `Filter ${columnLabel}: ${activeDescription}`
  chip.setAttribute('aria-label', label)
  chip.setAttribute('title', label)
  if (!existing) {
    // APPEND so the caret cannot be seated before a non-editable child when the
    // user clicks at column zero of the header text.
    cellElement.appendChild(chip)
  }
  return chip
}

/** Create or reuse the table's disclosure caption, marked Lexical-UNMANAGED. */
export const ensureFilterCaption = (tableElement: HTMLTableElement): HTMLElement => {
  const existing = tableElement.querySelector<HTMLElement>(`:scope > caption[${FILTER_CAPTION_ATTR}]`)
  if (existing) {
    return existing
  }
  const caption = tableElement.ownerDocument.createElement('caption')
  caption.setAttribute(FILTER_CAPTION_ATTR, 'true')
  caption.setAttribute('contenteditable', 'false')
  caption.className = 'Lexical__tableFilterCaption'
  // `captureSelection` keeps the caret inside the panel's text inputs instead of
  // being force-synced back into the document, exactly as ChecklistDueControls
  // does for its date fields.
  setDOMUnmanaged(caption, { captureSelection: true })
  tableElement.insertBefore(caption, tableElement.firstChild)
  return caption
}

const tableElementOf = (editor: LexicalEditor, tableKey: string): HTMLTableElement | null => {
  const element = editor.getElementByKey(tableKey)
  if (element === null) {
    return null
  }
  if (element instanceof HTMLTableElement) {
    return element
  }
  return element.querySelector('table')
}

type ColumnView = {
  columnIndex: number
  columnId: string | null
  label: string
  type: ColumnType
  filter: ColumnFilter | null
  hasActiveCondition: boolean
}

type TableView = {
  tableKey: string
  caption: HTMLElement
  columns: ColumnView[]
  summary: FilterSummary
  unreadable: string[]
}

type OpenColumn = { tableKey: string; columnIndex: number }

const viewSignature = (views: TableView[], open: OpenColumn | null): string =>
  JSON.stringify([views.map((view) => [view.tableKey, view.summary, view.unreadable, view.columns]), open])

const TableFilterCaptionContent = ({
  view,
  open,
  editable,
  onOpenColumn,
  onWriteFilter,
  onClearColumn,
  onClearAll,
}: {
  view: TableView
  open: OpenColumn | null
  editable: boolean
  onOpenColumn: (next: OpenColumn | null) => void
  onWriteFilter: (
    tableKey: string,
    columnIndex: number,
    conditions: FilterCondition[],
    combinator: ColumnCombinator,
  ) => void
  onClearColumn: (tableKey: string, columnIndex: number) => void
  onClearAll: (tableKey: string) => void
}) => {
  const disclosable = filterIsDisclosable(view.summary)
  const openColumn =
    open && open.tableKey === view.tableKey
      ? view.columns.find((column) => column.columnIndex === open.columnIndex)
      : undefined
  const activeColumns = view.columns.filter((column) => column.hasActiveCondition)

  return (
    <>
      {disclosable && (
        <div className="Lexical__tableFilterStatus" role="status" data-srn-table-filter-status="true">
          <span {...{ [FILTER_STATUS_SCREEN_ATTR]: 'true' }}>{filterIndicatorText(view.summary)}</span>
          <span {...{ [FILTER_STATUS_PRINT_ATTR]: 'true' }}>{filterPrintNoticeText(view.summary)}</span>
          {editable && (
            <span
              role="button"
              tabIndex={-1}
              className="Lexical__tableFilterClear"
              {...{ [FILTER_CLEAR_ATTR]: 'true' }}
              onClick={() => onClearAll(view.tableKey)}
            >
              Show all rows
            </span>
          )}
          {/*
            A table with no header row can hide the very row that carries the
            chips, so every active filter is also reachable from here - which is
            always on screen while anything is hidden.
          */}
          {editable &&
            activeColumns.map((column) => (
              <span
                key={column.columnIndex}
                role="button"
                tabIndex={-1}
                className="Lexical__tableFilterClear"
                data-srn-table-filter-edit={column.columnIndex}
                onClick={() => onOpenColumn({ tableKey: view.tableKey, columnIndex: column.columnIndex })}
              >
                {`Edit ${column.label}`}
              </span>
            ))}
        </div>
      )}
      {editable && openColumn && (
        <TableFilterPanel
          columnLabel={openColumn.label}
          columnType={openColumn.type}
          conditions={openColumn.filter?.conditions ?? []}
          combinator={openColumn.filter?.combinator ?? 'all'}
          statusText={disclosable ? filterIndicatorText(view.summary) : null}
          unreadable={view.unreadable}
          onChange={(conditions, combinator) =>
            onWriteFilter(view.tableKey, openColumn.columnIndex, conditions, combinator)
          }
          onClear={() => onClearColumn(view.tableKey, openColumn.columnIndex)}
          onClose={() => onOpenColumn(null)}
        />
      )}
    </>
  )
}

export default function TableFilterPlugin(): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const editable = useLexicalEditable()
  const [views, setViews] = useState<TableView[]>([])
  const [open, setOpen] = useState<OpenColumn | null>(null)

  const writeFilter = useCallback(
    (tableKey: string, columnIndex: number, conditions: FilterCondition[], combinator: ColumnCombinator) => {
      editor.update(
        () => {
          const tableNode = $getNodeByKey(tableKey)
          if (!$isTableNode(tableNode)) {
            return
          }
          const grid = $readTableGrid(tableNode)
          const columnId = $ensureColumnId(grid, columnIndex)
          if (columnId === null) {
            return
          }
          $setTableColumnFilter(tableNode, columnId, conditions.length === 0 ? null : { combinator, conditions })
        },
        // Typing a filter value must not bury the user's real edits under a
        // keystroke-per-entry undo stack.
        { tag: HISTORY_MERGE_TAG },
      )
    },
    [editor],
  )

  const clearColumn = useCallback(
    (tableKey: string, columnIndex: number) => {
      editor.update(() => {
        const tableNode = $getNodeByKey(tableKey)
        if (!$isTableNode(tableNode)) {
          return
        }
        const grid = $readTableGrid(tableNode)
        const columnId = $ensureColumnId(grid, columnIndex)
        if (columnId === null) {
          return
        }
        $setTableColumnFilter(tableNode, columnId, null)
      })
    },
    [editor],
  )

  const clearAll = useCallback(
    (tableKey: string) => {
      editor.update(() => {
        const tableNode = $getNodeByKey(tableKey)
        if ($isTableNode(tableNode)) {
          $clearTableFilters(tableNode)
        }
      })
    },
    [editor],
  )

  useEffect(() => {
    let signature = ''

    const apply = () => {
      const nextViews: TableView[] = []

      editor.getEditorState().read(() => {
        for (const tableNode of $nodesOfType(TableNode)) {
          const tableKey = tableNode.getKey()
          const tableElement = tableElementOf(editor, tableKey)
          if (tableElement === null) {
            continue
          }

          const projection = $projectTableFilters(tableNode)
          const filtersByColumnId = new Map(projection.state.filters.map((filter) => [filter.columnId, filter]))

          const columns: ColumnView[] = projection.columns.map((column, columnIndex) => {
            const filter = column.columnId === null ? null : (filtersByColumnId.get(column.columnId) ?? null)
            return {
              columnIndex,
              columnId: column.columnId,
              label: column.label,
              type: column.type,
              filter,
              hasActiveCondition:
                filter !== null && filter.conditions.some((condition) => conditionIsActive(condition, column.type)),
            }
          })

          // 1. Row visibility. Presentation only.
          projection.bodyRows.forEach((row, index) => {
            const rowElement = editor.getElementByKey(row.rowKey)
            if (!rowElement) {
              return
            }
            if (projection.visibility[index]) {
              rowElement.removeAttribute(FILTERED_ROW_ATTR)
            } else {
              rowElement.setAttribute(FILTERED_ROW_ATTR, 'true')
            }
          })

          // 2. The per-header chips, in the table's TOP row only. Any chip left
          //    behind on a cell that is no longer in the top row (a row was
          //    inserted above it) is removed, so a stale chip can never point at
          //    a column position it does not occupy.
          const chipHosts = new Set<HTMLElement>()
          const topRow = projection.grid.grid[0] ?? []
          if (editable) {
            for (let columnIndex = 0; columnIndex < projection.grid.columnCount; columnIndex++) {
              const value = topRow[columnIndex]
              if (!value || value.startColumn !== columnIndex) {
                continue
              }
              const cellElement = editor.getElementByKey(value.cell.getKey())
              if (!cellElement) {
                continue
              }
              const column = columns[columnIndex]
              const label = column ? column.label : `Column ${columnIndex + 1}`
              const description =
                column && column.hasActiveCondition && column.filter
                  ? describeConditionsForLabel(column.filter, column.type)
                  : null
              syncFilterChip(
                cellElement,
                columnIndex,
                label,
                description,
                open !== null && open.tableKey === tableKey && open.columnIndex === columnIndex,
              )
              chipHosts.add(cellElement)
            }
          }
          tableElement.querySelectorAll<HTMLElement>(`[${FILTER_CHIP_ATTR}]`).forEach((chip) => {
            const host = chip.parentElement
            if (host === null || !chipHosts.has(host)) {
              chip.remove()
            }
          })

          // 3. The disclosure caption, created only when there is something to
          //    disclose or a panel to host.
          const panelIsOpen = editable && open !== null && open.tableKey === tableKey
          const needsCaption = filterIsDisclosable(projection.summary) || panelIsOpen
          if (!needsCaption) {
            tableElement.querySelector<HTMLElement>(`:scope > caption[${FILTER_CAPTION_ATTR}]`)?.remove()
            continue
          }

          nextViews.push({
            tableKey,
            caption: ensureFilterCaption(tableElement),
            columns,
            summary: projection.summary,
            unreadable: projection.state.unreadable,
          })
        }
      })

      const nextSignature = viewSignature(nextViews, open)
      if (nextSignature !== signature) {
        signature = nextSignature
        setViews(nextViews)
      }
    }

    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      const chip = target?.closest<HTMLElement>(`[${FILTER_CHIP_ATTR}]`)
      if (!chip) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      const columnIndex = Number(chip.getAttribute(FILTER_CHIP_COLUMN_INDEX_ATTR))
      const tableElement = chip.closest('table')
      if (!Number.isInteger(columnIndex) || tableElement === null) {
        return
      }
      const tableKey = editor.getEditorState().read(() => {
        for (const tableNode of $nodesOfType(TableNode)) {
          if (tableElementOf(editor, tableNode.getKey()) === tableElement) {
            return tableNode.getKey()
          }
        }
        return null
      })
      if (tableKey === null) {
        return
      }
      setOpen((current) => {
        const alreadyOpen = current !== null && current.tableKey === tableKey && current.columnIndex === columnIndex
        return alreadyOpen ? null : { tableKey, columnIndex }
      })
    }

    const cleanup = mergeRegister(
      editor.registerUpdateListener(() => {
        apply()
      }),
      editor.registerRootListener((nextRoot, prevRoot) => {
        prevRoot?.removeEventListener('click', onClick)
        nextRoot?.addEventListener('click', onClick)
      }),
    )

    apply()

    return cleanup
  }, [editor, editable, open])

  const portals = useMemo(
    () =>
      views.map((view) =>
        createPortal(
          <TableFilterCaptionContent
            view={view}
            open={open}
            editable={editable}
            onOpenColumn={setOpen}
            onWriteFilter={writeFilter}
            onClearColumn={clearColumn}
            onClearAll={clearAll}
          />,
          view.caption,
          `table-filter-${view.tableKey}`,
        ),
      ),
    [clearAll, clearColumn, editable, open, views, writeFilter],
  )

  return <>{portals}</>
}
