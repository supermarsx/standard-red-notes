import * as React from 'react'
import { useCallback, useMemo, useState } from 'react'
import {
  $getNodeByKey,
  DecoratorNode,
  EditorConfig,
  LexicalEditor,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  ColumnType,
  ColumnTypeSetting,
  COLUMN_TYPES,
  compareCellValues,
  detectColumnType,
  formatCellValue,
} from './DataTableCellTypes'
import DataTableChart, { DataTableChartConfig, DataTableChartType } from './DataTableChart'

export type DataTableData = {
  columns: string[]
  rows: string[][]
  /** Per-column type override; 'auto' (or missing) means infer from the data. */
  columnTypes?: ColumnTypeSetting[]
  /** Optional chart built from the columns. */
  chart?: DataTableChartConfig | null
  /** Rows per page; 0 means show all. */
  rowsPerPage?: number
}

const DEFAULT_DATATABLE: DataTableData = {
  columns: ['Name', 'Status', 'Notes'],
  rows: [
    ['', '', ''],
    ['', '', ''],
  ],
}

function clone(data: DataTableData): DataTableData {
  return {
    columns: [...data.columns],
    rows: data.rows.map((r) => [...r]),
    columnTypes: data.columnTypes ? [...data.columnTypes] : undefined,
    chart: data.chart ? { ...data.chart, yColumns: [...data.chart.yColumns] } : data.chart,
    rowsPerPage: data.rowsPerPage,
  }
}

const typeSettingAt = (data: DataTableData, col: number): ColumnTypeSetting => data.columnTypes?.[col] ?? 'auto'

const setTypeSetting = (data: DataTableData, col: number, setting: ColumnTypeSetting): void => {
  const types = data.columnTypes ? [...data.columnTypes] : new Array<ColumnTypeSetting>(data.columns.length).fill('auto')
  while (types.length < data.columns.length) {
    types.push('auto')
  }
  types[col] = setting
  data.columnTypes = types
}

const TYPE_LABEL: Record<ColumnType, string> = {
  text: 'Text',
  number: 'Number',
  currency: 'Currency',
  date: 'Date',
  boolean: 'Boolean',
}

const PAGE_SIZES = [10, 25, 50, 100, 0] // 0 = All

function DataTableComponent({ data, nodeKey }: { data: DataTableData; nodeKey: NodeKey }): React.JSX.Element {
  const [editor] = useLexicalComposerContext()

  const mutate = useCallback(
    (fn: (draft: DataTableData) => void) => {
      editor.update(() => {
        const node = $getNodeByKey(nodeKey)
        if ($isDataTableNode(node)) {
          const draft = clone(node.getData())
          fn(draft)
          node.setData(draft)
        }
      })
    },
    [editor, nodeKey],
  )

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)
  const [sort, setSort] = useState<{ col: number; dir: 'asc' | 'desc' } | null>(null)
  const [page, setPage] = useState(0)
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null)

  const { columns, rows } = data
  const rowsPerPage = data.rowsPerPage ?? 25

  // Effective (resolved) type per column: explicit override, else auto-detected.
  const effectiveTypes = useMemo<ColumnType[]>(
    () =>
      columns.map((_, c) => {
        const setting = typeSettingAt(data, c)
        return setting === 'auto' ? detectColumnType(rows.map((r) => r[c] ?? '')) : setting
      }),
    [columns, rows, data],
  )

  const filterFor = (col: number) => filters[col] ?? ''

  // Rows after search + per-column filters, carrying their original index.
  const filteredRows = useMemo(() => {
    const term = search.trim().toLowerCase()
    const out: { idx: number; cells: string[] }[] = []
    rows.forEach((cells, idx) => {
      const matchesSearch =
        term.length === 0 ||
        cells.some((cell, c) => {
          const raw = (cell ?? '').toLowerCase()
          const formatted = formatCellValue(cell ?? '', effectiveTypes[c] ?? 'text').toLowerCase()
          return raw.includes(term) || formatted.includes(term)
        })
      if (!matchesSearch) {
        return
      }
      const matchesColumnFilters = columns.every((_, c) => {
        const f = (filters[c] ?? '').trim().toLowerCase()
        if (f.length === 0) {
          return true
        }
        const raw = (cells[c] ?? '').toLowerCase()
        const formatted = formatCellValue(cells[c] ?? '', effectiveTypes[c] ?? 'text').toLowerCase()
        return raw.includes(f) || formatted.includes(f)
      })
      if (matchesColumnFilters) {
        out.push({ idx, cells })
      }
    })
    return out
  }, [rows, columns, search, filters, effectiveTypes])

  const sortedRows = useMemo(() => {
    if (!sort) {
      return filteredRows
    }
    const type = effectiveTypes[sort.col] ?? 'text'
    const factor = sort.dir === 'asc' ? 1 : -1
    return [...filteredRows].sort(
      (a, b) => compareCellValues(a.cells[sort.col] ?? '', b.cells[sort.col] ?? '', type) * factor,
    )
  }, [filteredRows, sort, effectiveTypes])

  const totalPages = rowsPerPage === 0 ? 1 : Math.max(1, Math.ceil(sortedRows.length / rowsPerPage))
  const currentPage = Math.min(page, totalPages - 1)
  const pagedRows = useMemo(() => {
    if (rowsPerPage === 0) {
      return sortedRows
    }
    const start = currentPage * rowsPerPage
    return sortedRows.slice(start, start + rowsPerPage)
  }, [sortedRows, currentPage, rowsPerPage])

  // ----- mutations -----
  const setHeader = (col: number, value: string) => mutate((d) => (d.columns[col] = value))
  const setCell = (row: number, col: number, value: string) =>
    mutate((d) => {
      if (d.rows[row]) {
        d.rows[row][col] = value
      }
    })
  const addRow = () => mutate((d) => d.rows.push(new Array(d.columns.length).fill('')))
  const removeRow = (row: number) => mutate((d) => d.rows.splice(row, 1))
  const addColumn = () =>
    mutate((d) => {
      d.columns.push(`Column ${d.columns.length + 1}`)
      d.rows.forEach((r) => r.push(''))
      if (d.columnTypes) {
        d.columnTypes.push('auto')
      }
    })
  const removeColumn = (col: number) =>
    mutate((d) => {
      if (d.columns.length <= 1) {
        return
      }
      d.columns.splice(col, 1)
      d.rows.forEach((r) => r.splice(col, 1))
      d.columnTypes?.splice(col, 1)
    })
  const setColumnType = (col: number, setting: ColumnTypeSetting) => mutate((d) => setTypeSetting(d, col, setting))
  const setRowsPerPage = (value: number) => {
    setPage(0)
    mutate((d) => (d.rowsPerPage = value))
  }
  const setChart = (chart: DataTableChartConfig | null) => mutate((d) => (d.chart = chart))

  const toggleSort = (col: number) =>
    setSort((current) => {
      if (!current || current.col !== col) {
        return { col, dir: 'asc' }
      }
      if (current.dir === 'asc') {
        return { col, dir: 'desc' }
      }
      return null
    })

  const sortIndicator = (col: number) => (sort?.col === col ? (sort.dir === 'asc' ? '▲' : '▼') : '⇅')

  // ----- chart config -----
  const chart = data.chart ?? null
  const numericColumns = columns.map((_, c) => c).filter((c) => effectiveTypes[c] !== 'text')
  const toggleChart = () => {
    if (chart) {
      setChart(null)
    } else {
      const yColumn = numericColumns.find((c) => c !== 0) ?? numericColumns[0] ?? Math.min(1, columns.length - 1)
      setChart({ type: 'bar', xColumn: 0, yColumns: [yColumn] })
    }
  }

  return (
    <div className="my-2 rounded border border-border bg-default" data-datatable-block="true">
      <div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1 text-xs text-passive-1">
        <span className="mr-1 font-semibold">Data table</span>
        <input
          className="min-w-0 flex-grow rounded border border-border bg-default px-2 py-0.5 text-foreground outline-none focus:border-info"
          placeholder="Search…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setPage(0)
          }}
        />
        <button
          className={`rounded px-2 py-0.5 hover:bg-contrast ${showFilters ? 'bg-contrast text-info' : ''}`}
          onClick={() => setShowFilters((v) => !v)}
          type="button"
        >
          Filters
        </button>
        <button
          className={`rounded px-2 py-0.5 hover:bg-contrast ${chart ? 'bg-contrast text-info' : ''}`}
          onClick={toggleChart}
          type="button"
        >
          Chart
        </button>
        <button className="rounded px-2 py-0.5 hover:bg-contrast" onClick={addColumn} type="button">
          + Column
        </button>
        <button className="rounded px-2 py-0.5 hover:bg-contrast" onClick={addRow} type="button">
          + Row
        </button>
      </div>

      <div className="overflow-x-auto p-1">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>
              {columns.map((col, c) => (
                <th key={`h-${c}`} className="border border-border bg-contrast p-0 align-top">
                  <div className="flex flex-col">
                    <div className="flex items-center">
                      <input
                        className="min-w-0 flex-grow bg-transparent px-2 py-1 text-left font-semibold text-text outline-none"
                        defaultValue={col}
                        key={`hi-${c}-${col}`}
                        onBlur={(e) => setHeader(c, e.target.value)}
                      />
                      <button
                        className="px-1 text-passive-1 hover:text-info"
                        onClick={() => toggleSort(c)}
                        title="Sort by this column"
                        type="button"
                      >
                        {sortIndicator(c)}
                      </button>
                      <button
                        className="px-1 text-passive-1 hover:text-danger"
                        onClick={() => removeColumn(c)}
                        title="Delete column"
                        type="button"
                      >
                        ×
                      </button>
                    </div>
                    <div className="flex items-center gap-1 px-2 pb-1">
                      <select
                        className="rounded border border-border bg-default px-1 py-px text-[10px] uppercase tracking-wide text-passive-1 outline-none"
                        value={typeSettingAt(data, c)}
                        onChange={(e) => setColumnType(c, e.target.value as ColumnTypeSetting)}
                        title="Column type"
                      >
                        <option value="auto">Auto · {TYPE_LABEL[effectiveTypes[c] ?? 'text']}</option>
                        {COLUMN_TYPES.map((t) => (
                          <option key={t} value={t}>
                            {TYPE_LABEL[t]}
                          </option>
                        ))}
                      </select>
                    </div>
                    {showFilters && (
                      <div className="px-2 pb-1">
                        <input
                          className="w-full rounded border border-border bg-default px-1 py-px text-xs font-normal text-foreground outline-none focus:border-info"
                          placeholder="Filter…"
                          value={filterFor(c)}
                          onChange={(e) => {
                            const next = [...filters]
                            next[c] = e.target.value
                            setFilters(next)
                            setPage(0)
                          }}
                        />
                      </div>
                    )}
                  </div>
                </th>
              ))}
              <th className="w-6 border border-border bg-contrast" />
            </tr>
          </thead>
          <tbody>
            {pagedRows.map(({ idx, cells }) => (
              <tr key={`r-${idx}`}>
                {columns.map((_, c) => {
                  const raw = cells[c] ?? ''
                  const isEditing = editing?.row === idx && editing.col === c
                  const type = effectiveTypes[c] ?? 'text'
                  return (
                    <td key={`c-${idx}-${c}`} className="border border-border p-0 align-top">
                      {isEditing ? (
                        <input
                          autoFocus
                          className="w-full bg-contrast px-2 py-1 text-foreground outline-none"
                          defaultValue={raw}
                          onBlur={(e) => {
                            setCell(idx, c, e.target.value)
                            setEditing(null)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              setCell(idx, c, (e.target as HTMLInputElement).value)
                              setEditing(null)
                            } else if (e.key === 'Escape') {
                              setEditing(null)
                            }
                          }}
                        />
                      ) : (
                        <button
                          type="button"
                          className={`block w-full px-2 py-1 text-left outline-none hover:bg-contrast ${
                            type === 'number' || type === 'currency' ? 'text-right tabular-nums' : ''
                          } ${raw.trim().length === 0 ? 'text-passive-2' : 'text-foreground'}`}
                          onClick={() => setEditing({ row: idx, col: c })}
                        >
                          {raw.trim().length === 0 ? ' ' : formatCellValue(raw, type)}
                        </button>
                      )}
                    </td>
                  )
                })}
                <td className="border border-border text-center align-middle">
                  <button
                    className="px-1 text-passive-1 hover:text-danger"
                    onClick={() => removeRow(idx)}
                    title="Delete row"
                    type="button"
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
            {pagedRows.length === 0 && (
              <tr>
                <td className="px-2 py-3 text-center text-sm text-passive-1" colSpan={columns.length + 1}>
                  No matching rows
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-2 py-1 text-xs text-passive-1">
        <span>
          {sortedRows.length} {sortedRows.length === 1 ? 'row' : 'rows'}
          {sortedRows.length !== rows.length ? ` (of ${rows.length})` : ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <label className="flex items-center gap-1">
            Rows
            <select
              className="rounded border border-border bg-default px-1 py-px outline-none"
              value={rowsPerPage}
              onChange={(e) => setRowsPerPage(Number(e.target.value))}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size === 0 ? 'All' : size}
                </option>
              ))}
            </select>
          </label>
          {rowsPerPage !== 0 && totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                className="rounded px-2 py-0.5 hover:bg-contrast disabled:opacity-40"
                onClick={() => setPage(Math.max(0, currentPage - 1))}
                disabled={currentPage === 0}
                type="button"
              >
                ‹
              </button>
              <span>
                {currentPage + 1} / {totalPages}
              </span>
              <button
                className="rounded px-2 py-0.5 hover:bg-contrast disabled:opacity-40"
                onClick={() => setPage(Math.min(totalPages - 1, currentPage + 1))}
                disabled={currentPage >= totalPages - 1}
                type="button"
              >
                ›
              </button>
            </div>
          )}
        </div>
      </div>

      {chart && (
        <div className="border-t border-border p-2">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-passive-1">
            <label className="flex items-center gap-1">
              Type
              <select
                className="rounded border border-border bg-default px-1 py-px outline-none"
                value={chart.type}
                onChange={(e) => setChart({ ...chart, type: e.target.value as DataTableChartType })}
              >
                <option value="bar">Bar</option>
                <option value="line">Line</option>
                <option value="pie">Pie</option>
              </select>
            </label>
            <label className="flex items-center gap-1">
              {chart.type === 'pie' ? 'Labels' : 'X axis'}
              <select
                className="rounded border border-border bg-default px-1 py-px outline-none"
                value={chart.xColumn}
                onChange={(e) => setChart({ ...chart, xColumn: Number(e.target.value) })}
              >
                {columns.map((name, c) => (
                  <option key={c} value={c}>
                    {name || `Column ${c + 1}`}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center gap-1">
              <span>{chart.type === 'pie' ? 'Value' : 'Series'}</span>
              {columns.map((name, c) => (
                <label key={c} className="flex items-center gap-0.5">
                  <input
                    type={chart.type === 'pie' ? 'radio' : 'checkbox'}
                    checked={chart.type === 'pie' ? chart.yColumns[0] === c : chart.yColumns.includes(c)}
                    onChange={(e) => {
                      if (chart.type === 'pie') {
                        setChart({ ...chart, yColumns: [c] })
                      } else {
                        const set = new Set(chart.yColumns)
                        if (e.target.checked) {
                          set.add(c)
                        } else {
                          set.delete(c)
                        }
                        setChart({ ...chart, yColumns: Array.from(set).sort((a, b) => a - b) })
                      }
                    }}
                  />
                  {name || `Column ${c + 1}`}
                </label>
              ))}
            </div>
          </div>
          {chart.yColumns.length > 0 ? (
            <DataTableChart columns={columns} rows={sortedRows.map((r) => r.cells)} types={effectiveTypes} config={chart} />
          ) : (
            <div className="p-3 text-sm text-passive-1">Pick at least one series column to chart.</div>
          )}
        </div>
      )}
    </div>
  )
}

export type SerializedDataTableNode = Spread<{ data: DataTableData }, SerializedLexicalNode>

export class DataTableNode extends DecoratorNode<React.JSX.Element> {
  __data: DataTableData

  static getType(): string {
    return 'datatable'
  }

  static clone(node: DataTableNode): DataTableNode {
    return new DataTableNode(node.__data, node.__key)
  }

  constructor(data: DataTableData, key?: NodeKey) {
    super(key)
    this.__data = data
  }

  static importJSON(serializedNode: SerializedDataTableNode): DataTableNode {
    return $createDataTableNode(serializedNode.data)
  }

  exportJSON(): SerializedDataTableNode {
    return { type: 'datatable', version: 1, data: this.__data }
  }

  createDOM(): HTMLElement {
    const div = document.createElement('div')
    div.style.display = 'contents'
    return div
  }

  updateDOM(): false {
    return false
  }

  getData(): DataTableData {
    return this.getLatest().__data
  }

  setData(data: DataTableData): void {
    this.getWritable().__data = data
  }

  getTextContent(): string {
    const header = this.__data.columns.join(' | ')
    const rows = this.__data.rows.map((r) => r.join(' | '))
    return [header, ...rows].join('\n')
  }

  isInline(): false {
    return false
  }

  decorate(_editor: LexicalEditor, _config: EditorConfig): React.JSX.Element {
    return <DataTableComponent data={this.__data} nodeKey={this.getKey()} />
  }
}

export function $createDataTableNode(data: DataTableData = DEFAULT_DATATABLE): DataTableNode {
  return new DataTableNode(data)
}

export function $isDataTableNode(node: LexicalNode | null | undefined): node is DataTableNode {
  return node instanceof DataTableNode
}
