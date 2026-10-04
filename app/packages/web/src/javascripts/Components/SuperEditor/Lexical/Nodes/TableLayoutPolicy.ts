/**
 * Standard Red Notes — table layout policy (width methods + header differentiation).
 *
 * WHY NODE STATE AND NOT A NODE SUBCLASS
 * --------------------------------------
 * The surrounding convention for adding persisted state to a stock Lexical node
 * is the subclass-and-replace idiom in `StyledBlockNodes.ts`. That idiom is
 * deliberately NOT used here. A `TableNode` subclass needs its own `getType()`
 * (Lexical's `resolveRegisteredNodeAfterReplacements` loops forever if the
 * replacement shares its base's type), which would re-serialize EVERY existing
 * table in EVERY existing note under a new type name — a silent migration that
 * only bites when an older build opens the note. Lexical 0.47 ships node state
 * (`createState` / `$getState` / `$setState`) for exactly this case: typed,
 * per-node, serialized under the `$` key by the base `exportJSON` /
 * `updateFromJSON`, with unknown keys passed through verbatim so builds that
 * disagree about the schema cannot erase each other's settings.
 *
 * VALIDATE AND NORMALIZE ON READ
 * ------------------------------
 * A stored policy is a synced value another client — or an older/newer build —
 * may have written, so `parse` is total: it never throws, clamps numbers into a
 * sane range, and falls back to the default for anything it does not recognise.
 * It also distinguishes "absent" from "present but unrecognised": an
 * unrecognised value reports `unrecognised: true` and keeps the offending
 * `raw` value verbatim, so the UI can say *unrecognised* rather than presenting
 * the fallback as a measured setting, and so a newer build that does understand
 * the value still finds it intact.
 *
 * NODE STATE KEY NAMESPACE
 * ------------------------
 * Reserved prefix: `superTable*` on `TableNode`, `superColumn*` on
 * `TableCellNode`. Taken here: `superTableWidth`, `superTableHeaders`,
 * `superColumnWidth`. Reserved for the table filtering work (t115-B) and NOT
 * used by this module: `superTableFilter` (TableNode) and `superColumnFilter`
 * (TableCellNode).
 */
import { $getState, $setState, createState, DOMExportOutput, LexicalEditor, LexicalNode } from 'lexical'
import { $computeTableMapSkipCellCheck, $isTableNode, TableCellNode, TableNode } from '@lexical/table'

/* ------------------------------------------------------------- width methods */

/**
 * The width methods the table rendering can actually honour.
 *
 * - `content` — shrink-wrap the table to its content (`table-layout: auto`,
 *   `inline-size: max-content`). The historical default, so it stays the
 *   default and serializes to nothing. It is the only method that keeps the
 *   64rem readable cap a data widget gets by default; the other three are
 *   explicit instructions about width, so they fill the content column.
 * - `full`   — fill the available measure (`table-layout: auto`,
 *   `inline-size: 100%`); columns still sized from content.
 * - `fixed`  — honour the per-column widths EXACTLY (`table-layout: fixed`).
 *   When EVERY column carries a px width the table shrink-wraps to their sum
 *   rather than stretching them to fill the measure — see `columnsFitWidth`.
 * - `equal`  — ignore per-column widths and give every column the same share
 *   (`table-layout: fixed`, no `<col>` widths).
 *
 * There is deliberately no `percent` table method: a table-level percentage is
 * `full` with a narrower measure, and the editor has no column-of-the-page
 * concept to measure a table-level percentage against.
 */
export const TABLE_WIDTH_METHODS = ['content', 'full', 'fixed', 'equal'] as const
export type TableWidthMethod = (typeof TABLE_WIDTH_METHODS)[number]
export const DEFAULT_TABLE_WIDTH_METHOD: TableWidthMethod = 'content'

/** Human labels, shared by the controls and by any explanatory copy. */
export const TABLE_WIDTH_METHOD_LABELS: Record<TableWidthMethod, string> = {
  content: 'Fit content',
  full: 'Full width',
  fixed: 'Fixed columns',
  equal: 'Equal columns',
}

export const isTableWidthMethod = (value: unknown): value is TableWidthMethod =>
  typeof value === 'string' && (TABLE_WIDTH_METHODS as readonly string[]).includes(value)

/* ---------------------------------------------------- per-column width modes */

export const TABLE_COLUMN_WIDTH_MODES = ['auto', 'fixed', 'percent'] as const
export type TableColumnWidthMode = (typeof TABLE_COLUMN_WIDTH_MODES)[number]

export const TABLE_COLUMN_WIDTH_MODE_LABELS: Record<TableColumnWidthMode, string> = {
  auto: 'Automatic',
  fixed: 'Fixed width',
  percent: 'Percentage',
}

/** Sane bounds. A stored number outside them is clamped, never rejected. */
export const MIN_COLUMN_WIDTH_PX = 24
export const MAX_COLUMN_WIDTH_PX = 2000
export const MIN_COLUMN_WIDTH_PERCENT = 1
export const MAX_COLUMN_WIDTH_PERCENT = 100

/**
 * A parsed policy. `unrecognised` and `clamped` are provenance, not settings:
 * they let a control report that the stored value was not understood, or was
 * out of range, instead of presenting the fallback as the user's choice.
 */
export type TableWidthSetting = {
  readonly method: TableWidthMethod
  readonly unrecognised: boolean
  readonly raw?: unknown
}

export type TableHeaderSetting = {
  /** Whether the header row/column is STYLED distinctly. Never affects `th`. */
  readonly differentiated: boolean
  readonly unrecognised: boolean
  readonly raw?: unknown
}

export type TableColumnWidthPolicy = {
  readonly mode: TableColumnWidthMode
  /** Present for `fixed` (px) and `percent` (%). Absent for `auto`. */
  readonly value?: number
  readonly unrecognised: boolean
  readonly clamped: boolean
  readonly raw?: unknown
}

export const DEFAULT_TABLE_WIDTH_SETTING: TableWidthSetting = {
  method: DEFAULT_TABLE_WIDTH_METHOD,
  unrecognised: false,
}

export const DEFAULT_TABLE_HEADER_SETTING: TableHeaderSetting = {
  differentiated: true,
  unrecognised: false,
}

export const DEFAULT_COLUMN_WIDTH_POLICY: TableColumnWidthPolicy = {
  mode: 'auto',
  unrecognised: false,
  clamped: false,
}

/** Clamp into `[min, max]`, rounding; non-finite input falls back to `min`. */
const clampWidth = (value: number, min: number, max: number): { value: number; clamped: boolean } => {
  if (!Number.isFinite(value)) {
    return { value: min, clamped: true }
  }
  const rounded = Math.round(value)
  const bounded = Math.min(Math.max(rounded, min), max)
  return { value: bounded, clamped: bounded !== value }
}

/* -------------------------------------------------------------------- parsers */

export const parseTableWidthSetting = (jsonValue: unknown): TableWidthSetting => {
  if (jsonValue === undefined || jsonValue === null) {
    return DEFAULT_TABLE_WIDTH_SETTING
  }
  if (isTableWidthMethod(jsonValue)) {
    return { method: jsonValue, unrecognised: false }
  }
  return { method: DEFAULT_TABLE_WIDTH_METHOD, unrecognised: true, raw: jsonValue }
}

export const parseTableHeaderSetting = (jsonValue: unknown): TableHeaderSetting => {
  if (jsonValue === undefined || jsonValue === null) {
    return DEFAULT_TABLE_HEADER_SETTING
  }
  if (typeof jsonValue === 'boolean') {
    return { differentiated: jsonValue, unrecognised: false }
  }
  return { differentiated: DEFAULT_TABLE_HEADER_SETTING.differentiated, unrecognised: true, raw: jsonValue }
}

const unrecognisedColumnPolicy = (raw: unknown): TableColumnWidthPolicy => ({
  mode: 'auto',
  unrecognised: true,
  clamped: false,
  raw,
})

export const parseTableColumnWidthPolicy = (jsonValue: unknown): TableColumnWidthPolicy => {
  if (jsonValue === undefined || jsonValue === null) {
    return DEFAULT_COLUMN_WIDTH_POLICY
  }
  if (typeof jsonValue !== 'object' || Array.isArray(jsonValue)) {
    return unrecognisedColumnPolicy(jsonValue)
  }
  const candidate = jsonValue as { mode?: unknown; value?: unknown }
  if (candidate.mode === 'auto') {
    return DEFAULT_COLUMN_WIDTH_POLICY
  }
  if (candidate.mode !== 'fixed' && candidate.mode !== 'percent') {
    return unrecognisedColumnPolicy(jsonValue)
  }
  // A sized mode with no usable number is malformed, not a measured setting.
  if (typeof candidate.value !== 'number' || Number.isNaN(candidate.value)) {
    return unrecognisedColumnPolicy(jsonValue)
  }
  const bounds =
    candidate.mode === 'fixed'
      ? ([MIN_COLUMN_WIDTH_PX, MAX_COLUMN_WIDTH_PX] as const)
      : ([MIN_COLUMN_WIDTH_PERCENT, MAX_COLUMN_WIDTH_PERCENT] as const)
  const { value, clamped } = clampWidth(candidate.value, bounds[0], bounds[1])
  return { mode: candidate.mode, value, unrecognised: false, clamped }
}

/* ------------------------------------------------------------------ unparsers */

const unparseTableWidthSetting = (setting: TableWidthSetting): unknown => {
  return setting.unrecognised ? setting.raw : setting.method
}

const unparseTableHeaderSetting = (setting: TableHeaderSetting): unknown => {
  return setting.unrecognised ? setting.raw : setting.differentiated
}

const unparseTableColumnWidthPolicy = (policy: TableColumnWidthPolicy): unknown => {
  if (policy.unrecognised) {
    return policy.raw
  }
  if (policy.mode === 'auto') {
    return { mode: 'auto' }
  }
  return { mode: policy.mode, value: policy.value }
}

/**
 * Compare the preserved `raw` values of two settings. Only ever populated for
 * unrecognised values, which can be any JSON shape, so compare structurally
 * rather than by reference — `Object.is` would mark two equivalent unrecognised
 * values as a change and dirty the node on every read-modify-write.
 */
const rawValuesAreEqual = (a: { raw?: unknown }, b: { raw?: unknown }): boolean =>
  a.raw === b.raw || JSON.stringify(a.raw ?? null) === JSON.stringify(b.raw ?? null)

/* --------------------------------------------------------------- state config */

export const tableWidthState = createState('superTableWidth', {
  parse: parseTableWidthSetting,
  unparse: unparseTableWidthSetting,
  isEqual: (a: TableWidthSetting, b: TableWidthSetting) =>
    a.method === b.method && a.unrecognised === b.unrecognised && rawValuesAreEqual(a, b),
})

export const tableHeaderState = createState('superTableHeaders', {
  parse: parseTableHeaderSetting,
  unparse: unparseTableHeaderSetting,
  isEqual: (a: TableHeaderSetting, b: TableHeaderSetting) =>
    a.differentiated === b.differentiated && a.unrecognised === b.unrecognised && rawValuesAreEqual(a, b),
})

export const columnWidthState = createState('superColumnWidth', {
  parse: parseTableColumnWidthPolicy,
  unparse: unparseTableColumnWidthPolicy,
  isEqual: (a: TableColumnWidthPolicy, b: TableColumnWidthPolicy) =>
    a.mode === b.mode && a.value === b.value && a.unrecognised === b.unrecognised && rawValuesAreEqual(a, b),
})

/* ------------------------------------------------- table-level accessors ($) */

export const $getTableWidthSetting = (table: TableNode): TableWidthSetting => $getState(table, tableWidthState)

export const $setTableWidthMethod = (table: TableNode, method: TableWidthMethod): void => {
  $setState(table, tableWidthState, { method, unrecognised: false })
}

export const $getTableHeaderSetting = (table: TableNode): TableHeaderSetting => $getState(table, tableHeaderState)

export const $setTableHeadersDifferentiated = (table: TableNode, differentiated: boolean): void => {
  $setState(table, tableHeaderState, { differentiated, unrecognised: false })
}

/* ----------------------------------------------- per-column accessors ($) ---
 *
 * KEYING. A column is not a node, so a per-column policy has nowhere of its own
 * to live. Keying it by column INDEX on the table would silently re-attach every
 * policy to the wrong column after an insert, delete or move. Instead the policy
 * is stored as node state on the TableCellNodes that START that column — keyed,
 * in effect, by Lexical NodeKey. Column structure operations move, add and drop
 * whole cells, so the policy travels with its column for free:
 *
 *   - insert a column  → brand new cells, which carry the default policy
 *   - delete a column  → its cells (and only its cells) go with it
 *   - move a column    → `$moveTableColumn` re-parents the same cells
 *
 * It is written to the owning cell in EVERY row rather than only the first, so
 * deleting the top row does not take the column's policy with it; reads take the
 * topmost row that declares one. Cells with `colSpan > 1` are skipped: a width
 * written on a spanning cell would describe several columns at once.
 */

type ColumnCells = { readonly columnCount: number; readonly cellsByColumn: TableCellNode[][] }

/**
 * Group a table's cells by the column they start, using Lexical's own table map
 * so merged cells are accounted for. Cells spanning more than one column are
 * excluded — they cannot carry a single column's width.
 */
const $collectColumnCells = (table: TableNode): ColumnCells => {
  const [tableMap] = $computeTableMapSkipCellCheck(table, null, null)
  const columnCount = tableMap.reduce((widest, row) => Math.max(widest, row.length), 0)
  const cellsByColumn: TableCellNode[][] = Array.from({ length: columnCount }, () => [])
  const seen = new Set<string>()
  for (let row = 0; row < tableMap.length; row++) {
    for (let column = 0; column < tableMap[row].length; column++) {
      const mapValue = tableMap[row][column]
      if (mapValue === undefined || mapValue.startColumn !== column || mapValue.startRow !== row) {
        continue
      }
      const cell = mapValue.cell
      if (cell.getColSpan() > 1) {
        continue
      }
      const key = cell.getKey()
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      cellsByColumn[column].push(cell)
    }
  }
  return { columnCount, cellsByColumn }
}

/** The number of columns the table map reports (merge-aware). */
export const $getTableColumnCount = (table: TableNode): number => $collectColumnCells(table).columnCount

/**
 * Resolve one column's policy: the topmost row whose owning cell declares a
 * non-default policy wins. A column whose cells all span (so nothing can be
 * stored) reads as the default, which is truthful — nothing is applied.
 */
export const $getTableColumnWidthPolicy = (table: TableNode, columnIndex: number): TableColumnWidthPolicy => {
  const { cellsByColumn } = $collectColumnCells(table)
  const cells = cellsByColumn[columnIndex]
  if (cells === undefined) {
    return DEFAULT_COLUMN_WIDTH_POLICY
  }
  for (const cell of cells) {
    const policy = $getState(cell, columnWidthState)
    if (policy.mode !== 'auto' || policy.unrecognised) {
      return policy
    }
  }
  return DEFAULT_COLUMN_WIDTH_POLICY
}

/** Every column's policy, left to right. */
export const $getTableColumnWidthPolicies = (table: TableNode): TableColumnWidthPolicy[] => {
  const { columnCount, cellsByColumn } = $collectColumnCells(table)
  const policies: TableColumnWidthPolicy[] = []
  for (let column = 0; column < columnCount; column++) {
    let resolved = DEFAULT_COLUMN_WIDTH_POLICY
    for (const cell of cellsByColumn[column]) {
      const policy = $getState(cell, columnWidthState)
      if (policy.mode !== 'auto' || policy.unrecognised) {
        resolved = policy
        break
      }
    }
    policies.push(resolved)
  }
  return policies
}

/** Write one column's policy onto every non-spanning cell that starts it. */
export const $setTableColumnWidthPolicy = (
  table: TableNode,
  columnIndex: number,
  policy: TableColumnWidthPolicy,
): void => {
  const { cellsByColumn } = $collectColumnCells(table)
  const cells = cellsByColumn[columnIndex]
  if (cells === undefined) {
    return
  }
  for (const cell of cells) {
    $setState(cell, columnWidthState, policy)
  }
  // The policy lives on the cells, but it is the TABLE's rendering that changes.
  // Dirty the table so the layout plugin's TableNode mutation listener re-runs;
  // without this the new width would only appear after some later table edit.
  table.markDirty()
}

/** Build a policy from a mode and a raw user-entered number, normalizing it. */
export const makeColumnWidthPolicy = (mode: TableColumnWidthMode, value?: number): TableColumnWidthPolicy => {
  if (mode === 'auto') {
    return DEFAULT_COLUMN_WIDTH_POLICY
  }
  return parseTableColumnWidthPolicy({ mode, value })
}

/* ------------------------------------------------------------------ resolution
 *
 * PRECEDENCE. The table method chooses the table's own box AND the column-sizing
 * algorithm; a per-column policy refines that algorithm, it never overrides it:
 *
 *   content / full  → `table-layout: auto`. A column width is a HINT; the
 *                     browser may still grow a column its content overflows.
 *                     A PERCENTAGE under `content` is the one case where
 *                     nothing at all happens — see `columnWidthHonouring`.
 *   fixed           → `table-layout: fixed`. Column widths are honoured exactly.
 *   equal           → `table-layout: fixed`, no column widths emitted. Every
 *                     per-column policy is SUSPENDED, not erased, so switching
 *                     back to another method restores them. The controls say so
 *                     rather than appearing to apply a width that is ignored.
 */

export type TableColumnWidthHonouring = 'exact' | 'hint' | 'suspended' | 'ignored'

/**
 * What the active width method actually DOES with one column's width. This is a
 * readout the controls show the user, so it has to describe the rendering rather
 * than the intent.
 *
 * `ignored` exists because of one measured case: a PERCENTAGE under `content`.
 * `content` sizes the table with `inline-size: max-content`, so a percentage has
 * no definite base to resolve against and the browser discards it — measured in
 * headless Chrome at a 700px content column, a 50% first column renders 75px,
 * byte-identical to the same table with no policy at all. Calling that a `hint`
 * overstates it: nothing is applied. A PX width under `content` is a real hint
 * (300px measured 300px, growing the table from 226 to 451), so it stays `hint`.
 */
export const columnWidthHonouring = (
  method: TableWidthMethod,
  policy: TableColumnWidthPolicy,
): TableColumnWidthHonouring => {
  if (method === 'equal') {
    return 'suspended'
  }
  if (method === 'fixed') {
    return 'exact'
  }
  if (method === 'content' && policy.mode === 'percent') {
    return 'ignored'
  }
  return 'hint'
}

/** Least honoured first. The table-level summary reports the weakest reading. */
const HONOURING_WEAKEST_FIRST: readonly TableColumnWidthHonouring[] = ['suspended', 'ignored', 'hint', 'exact']

export type ResolvedTableLayout = {
  readonly method: TableWidthMethod
  /** Value for the `data-super-table-width` attribute. */
  readonly widthAttribute: TableWidthMethod
  /** `data-super-table-headers` value, or null when the attribute is absent. */
  readonly headerAttribute: 'plain' | null
  /**
   * The exact width the table's own box must take, or null to leave it to the
   * stylesheet.
   *
   * CSS `table-layout: fixed` on a table held at `inline-size: 100%` hands the
   * leftover measure back to the columns, so 200/200/200 in a 700px content
   * column rendered 233/233/233 — not honoured exactly, even though the API said
   * `exact`. When every column is sized in px the table can instead be exactly as
   * wide as its columns (601px for 200/200/200, the extra 1px being the collapsed
   * outer border), which is exact in all three regimes: under-fill leaves the
   * remainder unoccupied, sum == measure fits, sum > measure overflows into the
   * wrapper's scroll. Null when any column is automatic or a percentage — a
   * percentage needs the definite table width this would take away.
   */
  readonly columnsFitWidth: string | null
  /** Per column: the CSS length for its `<col>`, or null to leave it alone. */
  readonly columnWidths: readonly (string | null)[]
  /**
   * The weakest honouring among the columns that declare a width, or the
   * method's own reading when none does. A summary: a mixed table can honour one
   * column and ignore another, and `columnHonourings` is the per-column truth.
   */
  readonly columnHonouring: TableColumnWidthHonouring
  /** How the active method treats EACH column's width, left to right. */
  readonly columnHonourings: readonly TableColumnWidthHonouring[]
  /** True when policies exist that the active method suspends. */
  readonly suspendedColumnPolicies: boolean
  readonly differentiatedHeaders: boolean
}

/**
 * The width a `fixed` table must take so that EVERY declared column width is
 * rendered exactly: the sum of them. Null unless every column is sized in px,
 * because that is the only case in which the sum is known — a percentage column
 * resolves against the table's width, so fixing the table's width to the columns
 * would be circular, and an automatic column is asking for the leftover measure.
 */
const declaredColumnsWidth = (columns: readonly TableColumnWidthPolicy[]): string | null => {
  if (columns.length === 0) {
    return null
  }
  let total = 0
  for (const policy of columns) {
    if (policy.mode !== 'fixed' || policy.value === undefined) {
      return null
    }
    total += policy.value
  }
  return `${total}px`
}

const columnWidthCss = (policy: TableColumnWidthPolicy): string | null => {
  if (policy.unrecognised || policy.mode === 'auto' || policy.value === undefined) {
    return null
  }
  return policy.mode === 'fixed' ? `${policy.value}px` : `${policy.value}%`
}

export const resolveTableLayout = (input: {
  width: TableWidthSetting
  headers: TableHeaderSetting
  columns: readonly TableColumnWidthPolicy[]
}): ResolvedTableLayout => {
  const method = input.width.method
  const columnHonourings = input.columns.map((policy) => columnWidthHonouring(method, policy))
  const declared = input.columns.map(columnWidthCss)
  // The summary reports the weakest reading among the columns that actually
  // declare a width; with nothing declared it reports what the method would do.
  const declaredHonourings = columnHonourings.filter((_, index) => declared[index] !== null)
  const columnHonouring: TableColumnWidthHonouring =
    HONOURING_WEAKEST_FIRST.find((candidate) => declaredHonourings.includes(candidate)) ??
    columnWidthHonouring(method, DEFAULT_COLUMN_WIDTH_POLICY)
  const suspendedColumnPolicies = method === 'equal' && declared.some((width) => width !== null)
  return {
    method,
    widthAttribute: method,
    headerAttribute: input.headers.differentiated ? null : 'plain',
    columnsFitWidth: method === 'fixed' ? declaredColumnsWidth(input.columns) : null,
    columnWidths: method === 'equal' ? declared.map(() => null) : declared,
    columnHonouring,
    columnHonourings,
    suspendedColumnPolicies,
    differentiatedHeaders: input.headers.differentiated,
  }
}

/** Read a table's whole resolved layout in one pass. Must run in a Lexical read. */
export const $resolveTableLayout = (table: TableNode): ResolvedTableLayout =>
  resolveTableLayout({
    width: $getTableWidthSetting(table),
    headers: $getTableHeaderSetting(table),
    columns: $getTableColumnWidthPolicies(table),
  })

/* ----------------------------------------------------------------- DOM attrs */

export const TABLE_WIDTH_ATTRIBUTE = 'data-super-table-width'
export const TABLE_HEADERS_ATTRIBUTE = 'data-super-table-headers'
/** Selector hook for "this table is exactly as wide as its declared columns". */
export const TABLE_FIT_ATTRIBUTE = 'data-super-table-fit'
/**
 * How the measure itself reaches the stylesheet: a custom property rather than an
 * inline `inline-size`, so the rule that consumes it stays in editor.scss with
 * the rest of the table geometry instead of becoming an inline width on an
 * element Lexical manages.
 *
 * It DOES travel into the standalone HTML export, whose `<style>` is
 * `_colors.scss` + `editor.scss` + `export-overrides.scss` (NoteExportUtils.ts),
 * and the fit rule's `table.Lexical__table[…][…]` outranks that sheet's
 * `.Lexical__table { inline-size: 100% }`. Measured in Chrome on a 900px page: the
 * exported table is 601px with 200/200/200 columns — the same as on screen —
 * while the same table without the attribute fills the page at 900px with
 * 299.66px columns. That is deliberate: exact columns should be exact in both
 * places. PAPER still fills, because editor.scss's `@media print` block claims
 * `.Lexical__table { inline-size: 100% !important }`, and importance outranks the
 * fit rule's specificity (asserted as CSS text in WidgetLayoutContract.spec.ts;
 * emulating print media over CDP was tried and does not discriminate, so it is
 * NOT offered as evidence). The DOCX / ODT / PDF generators read `columnWidths`
 * and never CSS at all.
 */
export const TABLE_FIT_WIDTH_PROPERTY = '--super-table-fit-width'

/**
 * Apply a resolved layout to an already-rendered table.
 *
 * `element` is whatever `editor.getElementByKey(tableKey)` returned: the
 * horizontal-scroll wrapper when scrollable tables are active, otherwise the
 * `<table>` itself. The width attribute is written to BOTH, because the wrapper
 * owns its own measure and the table owns `table-layout`.
 *
 * The FIT attribute goes on the table only: it shrinks the table to its declared
 * column widths, while the wrapper keeps filling the measure so the leftover
 * space stays part of the block (and so the wrapper is still the scroll port when
 * the declared widths overflow it).
 *
 * Per-column widths are written to the `<col>` elements of Lexical's own
 * (DOM-unmanaged) `<colgroup>` — the correct HTML mechanism, honoured under both
 * `table-layout: auto` and `fixed`, and already carried through `exportDOM`.
 * Columns left on `auto` are not touched, so a width the user dragged with the
 * column resizer (Lexical's `colWidths`) still applies there.
 */
export const applyResolvedTableLayoutToDom = (element: HTMLElement | null, layout: ResolvedTableLayout): void => {
  if (element === null) {
    return
  }
  const tableElement = element instanceof HTMLTableElement ? element : element.querySelector('table')
  for (const target of new Set<HTMLElement | null>([element, tableElement])) {
    if (target === null) {
      continue
    }
    target.setAttribute(TABLE_WIDTH_ATTRIBUTE, layout.widthAttribute)
    if (layout.headerAttribute === null) {
      target.removeAttribute(TABLE_HEADERS_ATTRIBUTE)
    } else {
      target.setAttribute(TABLE_HEADERS_ATTRIBUTE, layout.headerAttribute)
    }
  }
  if (tableElement === null) {
    return
  }
  if (layout.columnsFitWidth === null) {
    tableElement.removeAttribute(TABLE_FIT_ATTRIBUTE)
    tableElement.style.removeProperty(TABLE_FIT_WIDTH_PROPERTY)
  } else {
    tableElement.setAttribute(TABLE_FIT_ATTRIBUTE, 'columns')
    tableElement.style.setProperty(TABLE_FIT_WIDTH_PROPERTY, layout.columnsFitWidth)
  }
  const cols = tableElement.querySelectorAll(':scope > colgroup > col')
  for (let index = 0; index < cols.length; index++) {
    const col = cols[index]
    if (!(col instanceof HTMLElement)) {
      continue
    }
    const width = layout.columnWidths[index]
    if (width === null || width === undefined) {
      continue
    }
    col.style.width = width
  }
}

/**
 * An `exportDOM` for `TableNode` that applies the layout to Lexical's own output,
 * for the standalone-HTML export path.
 *
 * `exportDOM` is not overridable on a stock node, so this is registered through
 * `createEditor`'s `html.export` map on the EXPORT editor (see
 * `Tools/HeadlessSuperConverter.tsx`).
 *
 * It deliberately reuses the SAME applier the on-screen plugin uses. Lexical's
 * `exportDOM` does emit a `<colgroup>`, but `$updateColgroup` only writes a width
 * onto a `<col>` from Lexical's own `colWidths` — so an exported table's columns
 * came out bare, and a per-column width policy silently applied on screen and
 * nowhere else. Sharing the applier is what keeps the two from drifting again.
 *
 * The printed output needs none of this: printing clones the live editor DOM, which
 * the layout plugin has already decorated.
 */
export const $exportTableDomWithLayout = (editor: LexicalEditor, target: LexicalNode): DOMExportOutput => {
  const output = target.exportDOM(editor)
  if (!$isTableNode(target)) {
    return output
  }
  const layout = $resolveTableLayout(target)
  const decorate = (
    element: HTMLElement | DocumentFragment | Text | null | undefined,
  ): HTMLElement | DocumentFragment | Text | null | undefined => {
    if (element instanceof HTMLElement) {
      applyResolvedTableLayoutToDom(element, layout)
    } else if (element != null && 'querySelector' in element) {
      const tableElement = element.querySelector('table')
      if (tableElement !== null) {
        applyResolvedTableLayoutToDom(tableElement, layout)
      }
    }
    return element
  }
  const previousAfter = output.after
  return {
    ...output,
    after: (element) => decorate(previousAfter ? previousAfter(element) : element),
  }
}
