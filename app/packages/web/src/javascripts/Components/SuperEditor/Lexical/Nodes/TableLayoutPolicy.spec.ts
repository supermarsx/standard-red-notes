import { $getRoot, createEditor, LexicalEditor, SerializedEditorState, SerializedLexicalNode } from 'lexical'
import {
  $createTableNodeWithDimensions,
  $deleteTableColumn,
  $insertTableColumnAtNode,
  $isTableCellNode,
  $isTableNode,
  $isTableRowNode,
  $moveTableColumn,
  TableCellNode,
  TableNode,
  TableRowNode,
} from '@lexical/table'
import {
  $getTableColumnCount,
  $getTableColumnWidthPolicies,
  $getTableColumnWidthPolicy,
  $getTableHeaderSetting,
  $getTableWidthSetting,
  $resolveTableLayout,
  $setTableColumnWidthPolicy,
  $setTableHeadersDifferentiated,
  $setTableWidthMethod,
  applyResolvedTableLayoutToDom,
  columnWidthHonouring,
  DEFAULT_COLUMN_WIDTH_POLICY,
  DEFAULT_TABLE_WIDTH_METHOD,
  makeColumnWidthPolicy,
  MAX_COLUMN_WIDTH_PERCENT,
  MAX_COLUMN_WIDTH_PX,
  MIN_COLUMN_WIDTH_PX,
  parseTableColumnWidthPolicy,
  parseTableHeaderSetting,
  parseTableWidthSetting,
  resolveTableLayout,
  TABLE_FIT_ATTRIBUTE,
  TABLE_FIT_WIDTH_PROPERTY,
  TABLE_HEADERS_ATTRIBUTE,
  TABLE_WIDTH_ATTRIBUTE,
  TABLE_WIDTH_METHODS,
  TableColumnWidthPolicy,
  TableWidthMethod,
} from './TableLayoutPolicy'

/* ------------------------------------------------------------------- parsing */

describe('parseTableWidthSetting', () => {
  it('defaults to fit-content when nothing is stored', () => {
    for (const absent of [undefined, null]) {
      expect(parseTableWidthSetting(absent)).toEqual({ method: 'content', unrecognised: false })
    }
    expect(DEFAULT_TABLE_WIDTH_METHOD).toBe('content')
  })

  it('accepts every known method', () => {
    for (const method of TABLE_WIDTH_METHODS) {
      expect(parseTableWidthSetting(method)).toEqual({ method, unrecognised: false })
    }
  })

  it('reports an unrecognised stored value as unrecognised rather than as a setting', () => {
    for (const malformed of ['percentage', '', 42, true, {}, [], { method: 'fixed' }]) {
      const parsed = parseTableWidthSetting(malformed)
      expect(parsed.unrecognised).toBe(true)
      expect(parsed.method).toBe('content')
      expect(parsed.raw).toEqual(malformed)
    }
  })
})

describe('parseTableHeaderSetting', () => {
  it('differentiates headers by default', () => {
    expect(parseTableHeaderSetting(undefined)).toEqual({ differentiated: true, unrecognised: false })
  })

  it('accepts both booleans', () => {
    expect(parseTableHeaderSetting(true).differentiated).toBe(true)
    expect(parseTableHeaderSetting(false).differentiated).toBe(false)
  })

  it('treats a non-boolean as unrecognised and keeps differentiating', () => {
    const parsed = parseTableHeaderSetting('off')
    expect(parsed).toEqual({ differentiated: true, unrecognised: true, raw: 'off' })
  })
})

describe('parseTableColumnWidthPolicy', () => {
  it('defaults to automatic', () => {
    expect(parseTableColumnWidthPolicy(undefined)).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
    expect(parseTableColumnWidthPolicy({ mode: 'auto' })).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
  })

  it('accepts a fixed px width and a percentage', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 160 })).toEqual({
      mode: 'fixed',
      value: 160,
      unrecognised: false,
      clamped: false,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'percent', value: 25 })).toEqual({
      mode: 'percent',
      value: 25,
      unrecognised: false,
      clamped: false,
    })
  })

  it('clamps an out-of-range number and says it clamped', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 1e9 })).toEqual({
      mode: 'fixed',
      value: MAX_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: -5 })).toEqual({
      mode: 'fixed',
      value: MIN_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(parseTableColumnWidthPolicy({ mode: 'percent', value: 500 })).toEqual({
      mode: 'percent',
      value: MAX_COLUMN_WIDTH_PERCENT,
      unrecognised: false,
      clamped: true,
    })
  })

  it('rounds a fractional width', () => {
    expect(parseTableColumnWidthPolicy({ mode: 'fixed', value: 160.4 }).value).toBe(160)
  })

  it('never throws and never renders a malformed value back out', () => {
    const malformed: unknown[] = [
      42,
      'fixed',
      true,
      [],
      [{ mode: 'fixed', value: 10 }],
      { mode: 'fixed' },
      { mode: 'fixed', value: 'wide' },
      { mode: 'fixed', value: NaN },
      { mode: 'nonsense', value: 10 },
      { value: 10 },
      {},
    ]
    for (const value of malformed) {
      const parsed = parseTableColumnWidthPolicy(value)
      expect(parsed.unrecognised).toBe(true)
      expect(parsed.mode).toBe('auto')
      expect(parsed.value).toBeUndefined()
    }
  })

  it('emits no CSS for an unrecognised policy, so nothing claims it was applied', () => {
    const layout = resolveTableLayout({
      width: parseTableWidthSetting('fixed'),
      headers: parseTableHeaderSetting(undefined),
      columns: [parseTableColumnWidthPolicy({ mode: 'nonsense', value: 10 })],
    })
    expect(layout.columnWidths).toEqual([null])
  })
})

describe('makeColumnWidthPolicy', () => {
  it('normalizes through the same parser the stored value goes through', () => {
    expect(makeColumnWidthPolicy('auto')).toEqual(DEFAULT_COLUMN_WIDTH_POLICY)
    expect(makeColumnWidthPolicy('fixed', 5)).toEqual({
      mode: 'fixed',
      value: MIN_COLUMN_WIDTH_PX,
      unrecognised: false,
      clamped: true,
    })
    expect(makeColumnWidthPolicy('percent', 33).value).toBe(33)
  })
})

/* ---------------------------------------------------------------- precedence */

describe('resolveTableLayout precedence', () => {
  const columns = [
    makeColumnWidthPolicy('fixed', 120),
    makeColumnWidthPolicy('percent', 40),
    makeColumnWidthPolicy('auto'),
  ]
  const headers = parseTableHeaderSetting(undefined)

  it('treats a column width as a hint under the auto-layout methods', () => {
    for (const method of ['content', 'full'] as const) {
      const layout = resolveTableLayout({ width: parseTableWidthSetting(method), headers, columns })
      expect(layout.columnWidths).toEqual(['120px', '40%', null])
      expect(layout.suspendedColumnPolicies).toBe(false)
      // The px hint is a hint under both; the PERCENT is only a hint under
      // `full`, because `content` has no definite width to resolve it against.
      expect(layout.columnHonourings).toEqual(
        method === 'full' ? ['hint', 'hint', 'hint'] : ['hint', 'ignored', 'hint'],
      )
    }
    expect(resolveTableLayout({ width: parseTableWidthSetting('full'), headers, columns }).columnHonouring).toBe('hint')
  })

  it('honours a column width exactly under the fixed method', () => {
    const layout = resolveTableLayout({ width: parseTableWidthSetting('fixed'), headers, columns })
    expect(layout.columnHonouring).toBe('exact')
    expect(layout.columnHonourings).toEqual(['exact', 'exact', 'exact'])
    expect(layout.columnWidths).toEqual(['120px', '40%', null])
  })

  it('suspends every column policy under the equal method without erasing it', () => {
    const layout = resolveTableLayout({ width: parseTableWidthSetting('equal'), headers, columns })
    expect(layout.columnHonouring).toBe('suspended')
    expect(layout.columnWidths).toEqual([null, null, null])
    expect(layout.suspendedColumnPolicies).toBe(true)
    // The policies themselves are untouched, so switching method restores them.
    expect(columns[0]).toEqual({ mode: 'fixed', value: 120, unrecognised: false, clamped: false })
  })

  it('does not report suspension when there is nothing to suspend', () => {
    const layout = resolveTableLayout({
      width: parseTableWidthSetting('equal'),
      headers,
      columns: [makeColumnWidthPolicy('auto')],
    })
    expect(layout.suspendedColumnPolicies).toBe(false)
  })

  it('maps header differentiation onto the attribute, absent when differentiated', () => {
    expect(
      resolveTableLayout({ width: parseTableWidthSetting(undefined), headers, columns }).headerAttribute,
    ).toBeNull()
    expect(
      resolveTableLayout({ width: parseTableWidthSetting(undefined), headers: parseTableHeaderSetting(false), columns })
        .headerAttribute,
    ).toBe('plain')
  })
})

/* ------------------------------------------- what a width method really does --
 *
 * Every pixel number quoted below is a RENDERED measurement from headless Chrome
 * (a three-row, three-column table in a content column of the stated width, with
 * editor.scss compiled fresh), not a prediction. jsdom has no layout engine, so
 * what this spec can pin is the READOUT — and the readout's whole job is to
 * describe those measurements rather than the intent.
 */

describe('columnWidthHonouring reports what the active method actually does', () => {
  const pxWidth = makeColumnWidthPolicy('fixed', 300)
  const percentWidth = makeColumnWidthPolicy('percent', 50)
  const auto = makeColumnWidthPolicy('auto')

  it('calls a px width under content a hint, because it is one', () => {
    // Measured @700: the table grew 226 -> 451 and column 0 rendered exactly 300.
    expect(columnWidthHonouring('content', pxWidth)).toBe('hint')
  })

  it('calls a percentage under content ignored, because nothing at all happens', () => {
    // Measured @700: 75px — byte-identical to the same table with no policy, and
    // the table stayed 226px wide. Reporting this as a `hint` showed the user a
    // width that does nothing.
    expect(columnWidthHonouring('content', percentWidth)).toBe('ignored')
  })

  it('calls both a hint under full, where the table does have a definite width', () => {
    // Measured @700: 300px -> 300; 50% -> 349.5 (half of 700 less the collapsed
    // border). Measured @1200: 50% -> 599.5.
    expect(columnWidthHonouring('full', pxWidth)).toBe('hint')
    expect(columnWidthHonouring('full', percentWidth)).toBe('hint')
  })

  it('calls every width exact under fixed and suspended under equal', () => {
    for (const policy of [pxWidth, percentWidth, auto]) {
      expect(columnWidthHonouring('fixed', policy)).toBe('exact')
      expect(columnWidthHonouring('equal', policy)).toBe('suspended')
    }
  })

  it('never calls anything but a percentage ignored', () => {
    for (const method of TABLE_WIDTH_METHODS) {
      expect(columnWidthHonouring(method, auto)).not.toBe('ignored')
      expect(columnWidthHonouring(method, pxWidth)).not.toBe('ignored')
    }
  })
})

describe('the table-level honouring summarises the columns that declare a width', () => {
  const headers = parseTableHeaderSetting(undefined)
  const summaryOf = (method: TableWidthMethod, columns: TableColumnWidthPolicy[]) =>
    resolveTableLayout({ width: parseTableWidthSetting(method), headers, columns }).columnHonouring

  it('reports the weakest reading among the columns that declare something', () => {
    // One ignored percentage is enough for the table's reading to stop saying
    // every width is being honoured.
    expect(summaryOf('content', [makeColumnWidthPolicy('fixed', 300), makeColumnWidthPolicy('percent', 50)])).toBe(
      'ignored',
    )
    expect(summaryOf('content', [makeColumnWidthPolicy('fixed', 300), makeColumnWidthPolicy('fixed', 120)])).toBe(
      'hint',
    )
  })

  it('does not count a column that declares nothing', () => {
    // An automatic column cannot be ignored: there is nothing to ignore. Were
    // the summary taken over ALL columns it would read `hint` above and `ignored`
    // here, which is backwards.
    expect(summaryOf('content', [makeColumnWidthPolicy('auto'), makeColumnWidthPolicy('percent', 50)])).toBe('ignored')
    expect(summaryOf('content', [makeColumnWidthPolicy('auto'), makeColumnWidthPolicy('auto')])).toBe('hint')
  })

  it('falls back to the method reading when no column declares a width', () => {
    expect(summaryOf('fixed', [makeColumnWidthPolicy('auto')])).toBe('exact')
    expect(summaryOf('equal', [makeColumnWidthPolicy('auto')])).toBe('suspended')
    expect(summaryOf('full', [])).toBe('hint')
  })
})

describe('columnsFitWidth keeps `fixed` exact when the widths under-fill the table', () => {
  const headers = parseTableHeaderSetting(undefined)
  const fitOf = (method: TableWidthMethod, columns: TableColumnWidthPolicy[]) =>
    resolveTableLayout({ width: parseTableWidthSetting(method), headers, columns }).columnsFitWidth

  it('is the sum of the declared widths when every column is sized in px', () => {
    // Measured @700 WITHOUT this: 200/200/200 rendered 233/233/233, because
    // `table-layout: fixed` on a table held at 100% hands the leftover 100px back
    // to the columns. With it the table is 601px (600 + the collapsed border) and
    // the columns render exactly 200/200/200 — at a 1200px column too.
    expect(
      fitOf('fixed', [
        makeColumnWidthPolicy('fixed', 200),
        makeColumnWidthPolicy('fixed', 200),
        makeColumnWidthPolicy('fixed', 200),
      ]),
    ).toBe('600px')
    // The policy's own floor, which rendered 24/24/24 in a 73px table.
    expect(fitOf('fixed', [makeColumnWidthPolicy('fixed', 24), makeColumnWidthPolicy('fixed', 24)])).toBe('48px')
    // Widths that overflow the measure are not clamped: the table is 1201px and
    // the wrapper scrolls, as it did before.
    expect(
      fitOf('fixed', [
        makeColumnWidthPolicy('fixed', 400),
        makeColumnWidthPolicy('fixed', 400),
        makeColumnWidthPolicy('fixed', 400),
      ]),
    ).toBe('1200px')
  })

  it('is null when any column is automatic, so that column keeps absorbing the remainder', () => {
    // Measured @700: col0 300 and the two automatic columns 199.5 each — the
    // table still fills. That regime was already exact and must stay so.
    expect(fitOf('fixed', [makeColumnWidthPolicy('fixed', 300), makeColumnWidthPolicy('auto')])).toBeNull()
  })

  it('is null when any column is a percentage, which needs the table width it would replace', () => {
    expect(fitOf('fixed', [makeColumnWidthPolicy('percent', 50), makeColumnWidthPolicy('fixed', 200)])).toBeNull()
    expect(fitOf('fixed', [makeColumnWidthPolicy('percent', 50), makeColumnWidthPolicy('percent', 50)])).toBeNull()
  })

  it('is null when a stored width is unrecognised, so nothing is sized from a value we rejected', () => {
    expect(
      fitOf('fixed', [parseTableColumnWidthPolicy({ mode: 'ems', value: 12 }), makeColumnWidthPolicy('fixed', 200)]),
    ).toBeNull()
  })

  it('is null for every other width method, and for a table with no columns', () => {
    const sized = [makeColumnWidthPolicy('fixed', 200), makeColumnWidthPolicy('fixed', 200)]
    for (const method of ['content', 'full', 'equal'] as const) {
      expect(fitOf(method, sized)).toBeNull()
    }
    expect(fitOf('fixed', [])).toBeNull()
  })
})

/* --------------------------------------------------------- DOM application */

describe('applyResolvedTableLayoutToDom', () => {
  const buildTable = (columnCount: number) => {
    const wrapper = document.createElement('div')
    const table = document.createElement('table')
    const colgroup = document.createElement('colgroup')
    for (let i = 0; i < columnCount; i++) {
      colgroup.appendChild(document.createElement('col'))
    }
    table.appendChild(colgroup)
    wrapper.appendChild(table)
    return { wrapper, table, colgroup }
  }

  it('writes the width attribute onto both the scroll wrapper and the table', () => {
    const { wrapper, table } = buildTable(2)
    applyResolvedTableLayoutToDom(wrapper, {
      method: 'full',
      widthAttribute: 'full',
      headerAttribute: null,
      columnsFitWidth: null,
      columnWidths: [null, null],
      columnHonouring: 'hint',
      columnHonourings: ['hint', 'hint'],
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    })
    expect(wrapper.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('full')
    expect(table.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('full')
    expect(wrapper.hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('hands the table its exact fit width, and takes it away again', () => {
    const { wrapper, table } = buildTable(3)
    const base = {
      method: 'fixed',
      widthAttribute: 'fixed',
      headerAttribute: null,
      columnWidths: ['200px', '200px', '200px'],
      columnHonouring: 'exact',
      columnHonourings: ['exact', 'exact', 'exact'],
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    } as const
    applyResolvedTableLayoutToDom(wrapper, { ...base, columnsFitWidth: '600px' })
    // The attribute is the stylesheet's hook and the custom property is the
    // measure; the rule in editor.scss needs both, and neither goes on the
    // wrapper, which must keep filling the measure.
    expect(table.getAttribute(TABLE_FIT_ATTRIBUTE)).toBe('columns')
    expect(table.style.getPropertyValue(TABLE_FIT_WIDTH_PROPERTY)).toBe('600px')
    expect(wrapper.hasAttribute(TABLE_FIT_ATTRIBUTE)).toBe(false)
    // Switching a column back to automatic must leave nothing behind, or the
    // table would stay stuck at a width nothing is asking for any more.
    applyResolvedTableLayoutToDom(wrapper, { ...base, columnsFitWidth: null })
    expect(table.hasAttribute(TABLE_FIT_ATTRIBUTE)).toBe(false)
    expect(table.style.getPropertyValue(TABLE_FIT_WIDTH_PROPERTY)).toBe('')
  })

  it('marks plain headers and clears the mark again when re-differentiated', () => {
    const { wrapper, table } = buildTable(1)
    const base = {
      method: 'content',
      widthAttribute: 'content',
      columnsFitWidth: null,
      columnWidths: [null],
      columnHonouring: 'hint',
      columnHonourings: ['hint'],
      suspendedColumnPolicies: false,
    } as const
    applyResolvedTableLayoutToDom(wrapper, { ...base, headerAttribute: 'plain', differentiatedHeaders: false })
    expect(table.getAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe('plain')
    applyResolvedTableLayoutToDom(wrapper, { ...base, headerAttribute: null, differentiatedHeaders: true })
    expect(table.hasAttribute(TABLE_HEADERS_ATTRIBUTE)).toBe(false)
  })

  it('writes per-column widths onto the colgroup and leaves automatic columns alone', () => {
    const { wrapper, colgroup } = buildTable(3)
    const cols = Array.from(colgroup.querySelectorAll('col'))
    cols[2].style.width = '90px'
    applyResolvedTableLayoutToDom(wrapper, {
      method: 'fixed',
      widthAttribute: 'fixed',
      headerAttribute: null,
      columnsFitWidth: null,
      columnWidths: ['120px', '40%', null],
      columnHonouring: 'exact',
      columnHonourings: ['exact', 'exact', 'exact'],
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    })
    expect(cols[0].style.width).toBe('120px')
    expect(cols[1].style.width).toBe('40%')
    // Column 2 is automatic, so a width the column resizer wrote survives.
    expect(cols[2].style.width).toBe('90px')
  })

  it('tolerates a bare table with no wrapper, and a null element', () => {
    const bare = {
      method: 'equal',
      widthAttribute: 'equal',
      headerAttribute: null,
      columnsFitWidth: null,
      columnWidths: [],
      columnHonouring: 'suspended',
      columnHonourings: [],
      suspendedColumnPolicies: false,
      differentiatedHeaders: true,
    } as const
    const table = document.createElement('table')
    expect(() => applyResolvedTableLayoutToDom(table, bare)).not.toThrow()
    expect(table.getAttribute(TABLE_WIDTH_ATTRIBUTE)).toBe('equal')
    expect(() => applyResolvedTableLayoutToDom(null, bare)).not.toThrow()
  })
})

/* ----------------------------------------------- node state on a live editor */

const makeEditor = (): LexicalEditor =>
  createEditor({
    namespace: 'table-layout-policy-test',
    nodes: [TableNode, TableRowNode, TableCellNode],
    onError: (error) => {
      throw error
    },
  })

const withTable = <T>(editor: LexicalEditor, run: (table: TableNode) => T): T => {
  let result!: T
  editor.update(
    () => {
      const table = $getRoot()
        .getChildren()
        .find((child): child is TableNode => $isTableNode(child))
      if (table === undefined) {
        throw new Error('expected a table')
      }
      result = run(table)
    },
    { discrete: true },
  )
  return result
}

/** The cell node at a (row, column) coordinate of a simple unmerged table. */
const cellAt = (table: TableNode, row: number, column: number): TableCellNode => {
  const rowNode = table.getChildren()[row]
  if (!$isTableRowNode(rowNode)) {
    throw new Error(`no row ${row}`)
  }
  const cell = rowNode.getChildren()[column]
  if (!$isTableCellNode(cell)) {
    throw new Error(`no cell ${row},${column}`)
  }
  return cell
}

const seedTable = (editor: LexicalEditor, rows: number, columns: number): void => {
  editor.update(
    () => {
      $getRoot()
        .clear()
        .append($createTableNodeWithDimensions(rows, columns, true))
    },
    { discrete: true },
  )
}

const findSerializedTable = (state: SerializedEditorState): SerializedLexicalNode & Record<string, unknown> => {
  const walk = (node: SerializedLexicalNode): (SerializedLexicalNode & Record<string, unknown>) | null => {
    if (node.type === 'table') {
      return node as SerializedLexicalNode & Record<string, unknown>
    }
    const children = (node as { children?: SerializedLexicalNode[] }).children
    for (const child of children ?? []) {
      const found = walk(child)
      if (found !== null) {
        return found
      }
    }
    return null
  }
  const found = walk(state.root as unknown as SerializedLexicalNode)
  if (found === null) {
    throw new Error('no serialized table found')
  }
  return found
}

describe('table-level layout state', () => {
  it('defaults to fit-content with differentiated headers and serializes nothing', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const read = withTable(editor, (table) => ({
      width: $getTableWidthSetting(table),
      headers: $getTableHeaderSetting(table),
    }))
    expect(read.width.method).toBe('content')
    expect(read.headers.differentiated).toBe(true)
    expect(findSerializedTable(editor.getEditorState().toJSON()).$).toBeUndefined()
  })

  it('round-trips a width method and a plain-header flag through serialization', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      $setTableHeadersDifferentiated(table, false)
    })

    const json = editor.getEditorState().toJSON()
    expect(findSerializedTable(json).$).toEqual({ superTableWidth: 'fixed', superTableHeaders: false })

    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))
    const read = withTable(reloaded, (table) => ({
      width: $getTableWidthSetting(table),
      headers: $getTableHeaderSetting(table),
    }))
    expect(read.width).toEqual({ method: 'fixed', unrecognised: false })
    expect(read.headers.differentiated).toBe(false)
  })

  it('reads a malformed stored method as unrecognised, applies the default, and keeps the raw value', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const json = editor.getEditorState().toJSON()
    const table = findSerializedTable(json)
    table.$ = { superTableWidth: 'percentage-of-page', superTableHeaders: 'yes' }

    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))
    const read = withTable(reloaded, (t) => ({
      width: $getTableWidthSetting(t),
      headers: $getTableHeaderSetting(t),
      layout: $resolveTableLayout(t),
    }))

    expect(read.width).toEqual({ method: 'content', unrecognised: true, raw: 'percentage-of-page' })
    expect(read.headers).toEqual({ differentiated: true, unrecognised: true, raw: 'yes' })
    // The default is what gets applied; the unrecognised value is never rendered.
    expect(read.layout.widthAttribute).toBe('content')
    expect(read.layout.headerAttribute).toBeNull()
    // And it is preserved verbatim, so a build that understands it still finds it.
    expect(findSerializedTable(reloaded.getEditorState().toJSON()).$).toEqual({
      superTableWidth: 'percentage-of-page',
      superTableHeaders: 'yes',
    })
  })
})

describe('per-column width policies are keyed by cell, not by index', () => {
  it('stores and reads one column without disturbing its neighbours', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150)))
    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'fixed', 'auto'])
    expect(policies[1].value).toBe(150)
  })

  it('keeps the policy on its own column after a column is inserted to its LEFT', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150)))

    withTable(editor, (table) => {
      $insertTableColumnAtNode(cellAt(table, 0, 0), false, false)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(withTable(editor, (table) => $getTableColumnCount(table))).toBe(4)
    // An index-keyed policy would still be reading column 1 here.
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'fixed', 'auto'])
    expect(policies[2].value).toBe(150)
  })

  it('drops only the deleted column, leaving the others where they are', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 4)
    withTable(editor, (table) => {
      $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 150))
      $setTableColumnWidthPolicy(table, 3, makeColumnWidthPolicy('percent', 20))
    })

    withTable(editor, (table) => {
      $deleteTableColumn(table, 1)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'percent'])
    expect(policies[2].value).toBe(20)
  })

  it('follows the column when the column is moved', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 3)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('percent', 60)))

    withTable(editor, (table) => {
      $moveTableColumn(table, 0, 2)
    })

    const policies = withTable(editor, (table) => $getTableColumnWidthPolicies(table))
    expect(policies.map((p) => p.mode)).toEqual(['auto', 'auto', 'percent'])
    expect(policies[2].value).toBe(60)
  })

  it('survives deletion of the top row, because every row carries the policy', () => {
    const editor = makeEditor()
    seedTable(editor, 3, 2)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 1, makeColumnWidthPolicy('fixed', 200)))

    withTable(editor, (table) => {
      table.getChildren()[0].remove()
    })

    expect(withTable(editor, (table) => $getTableColumnWidthPolicy(table, 1).value)).toBe(200)
  })

  it('round-trips per-column policies through serialization', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    withTable(editor, (table) => $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('percent', 70)))

    const json = JSON.stringify(editor.getEditorState().toJSON())
    const reloaded = makeEditor()
    reloaded.setEditorState(reloaded.parseEditorState(json))

    const policies = withTable(reloaded, (table) => $getTableColumnWidthPolicies(table))
    expect(policies[0]).toEqual({ mode: 'percent', value: 70, unrecognised: false, clamped: false })
    expect(policies[1].mode).toBe('auto')
  })

  it('does not throw and applies nothing when a stored column policy is malformed', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const json = editor.getEditorState().toJSON()
    const table = findSerializedTable(json)
    const firstRow = (table.children as { children: Record<string, unknown>[] }[])[0]
    firstRow.children[0].$ = { superColumnWidth: { mode: 'ems', value: 12 } }

    const reloaded = makeEditor()
    expect(() => reloaded.setEditorState(reloaded.parseEditorState(JSON.stringify(json)))).not.toThrow()
    const resolved = withTable(reloaded, (t) => ({
      policy: $getTableColumnWidthPolicy(t, 0),
      layout: $resolveTableLayout(t),
    }))
    expect(resolved.policy.unrecognised).toBe(true)
    expect(resolved.policy.mode).toBe('auto')
    expect(resolved.layout.columnWidths[0]).toBeNull()
  })
})

describe('$resolveTableLayout', () => {
  it('combines table method, header flag and column policies', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const layout = withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      $setTableHeadersDifferentiated(table, false)
      $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 90))
      $setTableColumnWidthPolicy(table, 2, makeColumnWidthPolicy('percent', 30))
      return $resolveTableLayout(table)
    })
    expect(layout.method).toBe('fixed')
    expect(layout.headerAttribute).toBe('plain')
    expect(layout.columnWidths).toEqual(['90px', null, '30%'])
    expect(layout.columnHonouring).toBe('exact')
  })

  it('computes the exact fit width from a real table whose every column is sized', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const layout = withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      for (const column of [0, 1, 2]) {
        $setTableColumnWidthPolicy(table, column, makeColumnWidthPolicy('fixed', 200))
      }
      return $resolveTableLayout(table)
    })
    expect(layout.columnWidths).toEqual(['200px', '200px', '200px'])
    expect(layout.columnsFitWidth).toBe('600px')
    expect(layout.columnHonourings).toEqual(['exact', 'exact', 'exact'])
  })

  it('drops the fit width again as soon as one column goes back to automatic', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 3)
    const layout = withTable(editor, (table) => {
      $setTableWidthMethod(table, 'fixed')
      for (const column of [0, 1, 2]) {
        $setTableColumnWidthPolicy(table, column, makeColumnWidthPolicy('fixed', 200))
      }
      $setTableColumnWidthPolicy(table, 2, makeColumnWidthPolicy('auto'))
      return $resolveTableLayout(table)
    })
    expect(layout.columnWidths).toEqual(['200px', '200px', null])
    expect(layout.columnsFitWidth).toBeNull()
  })

  it('reports a percentage column under the content method as ignored, not as a hint', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const layout = withTable(editor, (table) => {
      $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('percent', 50))
      return $resolveTableLayout(table)
    })
    // `content` is the default method, so this is what a fresh table does.
    expect(layout.method).toBe('content')
    expect(layout.columnHonourings).toEqual(['ignored', 'hint'])
    expect(layout.columnHonouring).toBe('ignored')
    // The width is still emitted: the document export paths lay every table out
    // with a definite width, where the percentage does resolve.
    expect(layout.columnWidths).toEqual(['50%', null])
  })

  it('reports suspension when the equal method is chosen over real column policies', () => {
    const editor = makeEditor()
    seedTable(editor, 2, 2)
    const layout = withTable(editor, (table) => {
      $setTableColumnWidthPolicy(table, 0, makeColumnWidthPolicy('fixed', 90))
      $setTableWidthMethod(table, 'equal')
      return $resolveTableLayout(table)
    })
    expect(layout.suspendedColumnPolicies).toBe(true)
    expect(layout.columnWidths).toEqual([null, null])
  })
})
