/**
 * Standard Red Notes: pure relational-linking helpers for the Super editor's
 * structured Data table block ("base"). Side-effect-free so they can be unit
 * tested in isolation.
 *
 * A data table may declare per-column "link" configs that make a column's
 * cells reference rows of ANOTHER data table by that target table's key value
 * (a foreign key). These helpers build an id->table lookup, resolve a stored
 * key to the target's display/label value, and normalize key matching.
 *
 * Cross-NOTE linking is intentionally out of scope for v1: resolution only
 * considers tables collected from the same editor document. Joins and
 * aggregations are likewise out of scope — links resolve a single label only.
 */

/**
 * Per-column foreign-key configuration. Lives in `DataTableData.links`, a
 * sparse array parallel to `columns` (index = column). A null/missing entry
 * means the column is a plain (non-link) column.
 */
export type LinkColumnConfig = {
  /** Stable id of the target DataTableData this column points at. */
  targetTableId: string
  /** Column index in the target table whose value cells store (the FK / key). */
  targetKeyColumn: number
  /** Column index in the target table to display when a key resolves; defaults to targetKeyColumn. */
  displayColumn?: number
}

/** Minimal shape of a data table needed for relational resolution. */
export type RelationTable = {
  id?: string
  columns: string[]
  rows: string[][]
  keyColumn?: number
}

/** A table that is guaranteed to have an id (used as a lookup map value). */
export type IdentifiedTable = RelationTable & { id: string }

/** The effective key column for a table (defaults to 0 for backward compat). */
export const effectiveKeyColumn = (table: Pick<RelationTable, 'keyColumn'>): number => table.keyColumn ?? 0

/**
 * Normalize a key for matching: trim and lower-case. Foreign keys are matched
 * case-insensitively and whitespace-insensitively so that hand-typed values
 * resolve gracefully. Returns '' for nullish input.
 */
export const normalizeKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase()

/**
 * Build an id -> table map from a list of tables. Tables without an id are
 * skipped (they cannot be link targets, but remain valid tables). When two
 * tables share an id, the first one wins (deterministic, stable).
 */
export const buildTableMap = (tables: ReadonlyArray<RelationTable>): Map<string, IdentifiedTable> => {
  const map = new Map<string, IdentifiedTable>()
  for (const table of tables) {
    if (table.id && !map.has(table.id)) {
      map.set(table.id, table as IdentifiedTable)
    }
  }
  return map
}

export type LinkResolution = {
  /** Whether the stored key matched a row in the target table. */
  matched: boolean
  /** The text to display: target's display-column value when matched, else the raw key. */
  display: string
  /** Index of the matched row in the target table, or -1 when unmatched. */
  rowIndex: number
  /** Id of the target table, when the link config has a resolvable target. */
  targetTableId: string | null
}

/**
 * Resolve a single link cell value against the id->table map.
 *
 * Behaviour (graceful, never throws):
 *  - missing/empty config -> raw value shown, unmatched.
 *  - missing target table -> raw value shown, unmatched.
 *  - empty key -> raw value ('') shown, unmatched.
 *  - key matches a target row's key column (case/space-insensitive) -> display
 *    the target's display column (falls back to key column). On duplicate keys,
 *    the FIRST matching row wins (deterministic).
 *  - no match -> raw value shown, unmatched (semi-structured fallback).
 */
export const resolveLink = (
  rawValue: string,
  config: LinkColumnConfig | null | undefined,
  tableMap: ReadonlyMap<string, IdentifiedTable>,
): LinkResolution => {
  const raw = rawValue ?? ''
  if (!config) {
    return { matched: false, display: raw, rowIndex: -1, targetTableId: null }
  }
  const target = tableMap.get(config.targetTableId)
  if (!target) {
    return { matched: false, display: raw, rowIndex: -1, targetTableId: config.targetTableId }
  }
  const normalized = normalizeKey(raw)
  if (normalized.length === 0) {
    return { matched: false, display: raw, rowIndex: -1, targetTableId: config.targetTableId }
  }
  const keyCol = config.targetKeyColumn
  const displayCol = config.displayColumn ?? keyCol
  for (let i = 0; i < target.rows.length; i++) {
    const row = target.rows[i]
    if (!row) {
      continue
    }
    if (normalizeKey(row[keyCol] ?? '') === normalized) {
      const display = row[displayCol]
      // Fall back to the raw key if the display cell is empty.
      const text = display !== undefined && display.trim().length > 0 ? display : raw
      return { matched: true, display: text, rowIndex: i, targetTableId: config.targetTableId }
    }
  }
  return { matched: false, display: raw, rowIndex: -1, targetTableId: config.targetTableId }
}

/** The link config for a given column, or null when the column is not a link. */
export const linkConfigAt = (
  links: ReadonlyArray<LinkColumnConfig | null | undefined> | undefined,
  col: number,
): LinkColumnConfig | null => links?.[col] ?? null

/** Whether a table declares at least one link column. */
export const hasLinks = (links: ReadonlyArray<LinkColumnConfig | null | undefined> | undefined): boolean =>
  !!links && links.some((l) => !!l)

/**
 * Distinct list of target table ids referenced by a table's link columns,
 * in first-seen order. Used for the "linked tables" indicator.
 */
export const linkedTargetIds = (
  links: ReadonlyArray<LinkColumnConfig | null | undefined> | undefined,
): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  if (!links) {
    return out
  }
  for (const link of links) {
    if (link && !seen.has(link.targetTableId)) {
      seen.add(link.targetTableId)
      out.push(link.targetTableId)
    }
  }
  return out
}

/**
 * The list of selectable options (key + label) for a target table, used by the
 * link cell picker. `value` is the stored FK (the key column); `label` is the
 * display column (falls back to the key when the display cell is empty).
 * Rows with an empty key are skipped. Duplicate keys are de-duplicated by the
 * first occurrence so the picker stays unambiguous.
 */
export type LinkOption = { value: string; label: string }

export const linkOptionsFor = (table: RelationTable, config: LinkColumnConfig): LinkOption[] => {
  const keyCol = config.targetKeyColumn
  const displayCol = config.displayColumn ?? keyCol
  const seen = new Set<string>()
  const out: LinkOption[] = []
  for (const row of table.rows) {
    const value = (row[keyCol] ?? '').trim()
    if (value.length === 0) {
      continue
    }
    const norm = normalizeKey(value)
    if (seen.has(norm)) {
      continue
    }
    seen.add(norm)
    const display = (row[displayCol] ?? '').trim()
    out.push({ value, label: display.length > 0 ? display : value })
  }
  return out
}
