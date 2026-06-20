/**
 * Pure result-shaping helpers for the SQL query block, kept separate from the
 * React node so they can be unit-tested without loading the (heavy, WASM) sql.js
 * engine.
 *
 * sql.js' `Database.exec(sql)` returns an array of result sets, each shaped like
 * `{ columns: string[]; values: SqlValue[][] }`. A statement that returns no
 * rows (INSERT/CREATE, or a SELECT with zero matches) yields an empty array or a
 * result with no values. These helpers normalize that into a single table the UI
 * can render, and stringify cell values safely for display.
 */

export type SqlExecResult = {
  columns: string[]
  values: unknown[][]
}

export type SqlResultTable = {
  columns: string[]
  rows: string[][]
  /** Number of rows in the (last) result set. */
  rowCount: number
  /** True when the statement(s) executed but produced no result set/rows. */
  empty: boolean
}

/** Render a single SQLite cell value as a display string. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (value instanceof Uint8Array) {
    return `[blob ${value.length} bytes]`
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}

/**
 * Collapse sql.js' multi-result-set output into a single renderable table. When
 * several statements run we show the LAST result set that returned columns
 * (typically the final SELECT). When nothing returns rows we report `empty`.
 */
export function shapeSqlResult(results: SqlExecResult[] | null | undefined): SqlResultTable {
  if (!Array.isArray(results) || results.length === 0) {
    return { columns: [], rows: [], rowCount: 0, empty: true }
  }

  // Prefer the last result set that actually has columns.
  let chosen: SqlExecResult | undefined
  for (let i = results.length - 1; i >= 0; i--) {
    const r = results[i]
    if (r && Array.isArray(r.columns) && r.columns.length > 0) {
      chosen = r
      break
    }
  }

  if (!chosen) {
    return { columns: [], rows: [], rowCount: 0, empty: true }
  }

  const columns = chosen.columns.map((c) => String(c))
  const values = Array.isArray(chosen.values) ? chosen.values : []
  const rows = values.map((row) => (Array.isArray(row) ? row.map(formatCell) : []))

  return {
    columns,
    rows,
    rowCount: rows.length,
    empty: rows.length === 0,
  }
}
